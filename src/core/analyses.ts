// Higher-level analyses built on repeated engine runs, independent of the UI.
import { buildNetlist, parseValue } from "./netlist";
import type { Schematic } from "./schematic";
import type { AnalysisRequest, SimResult, SimVector } from "./sim";

export type Runner = (netlist: string, request: AnalysisRequest) => Promise<SimResult>;

export interface FourierRow {
  harmonic: number;
  frequency: number;
  magnitude: number;
  phaseDeg: number;
}

export interface FourierResult {
  rows: FourierRow[];
  /** Total harmonic distortion in percent, relative to the fundamental. */
  thd: number;
  dc: number;
}

/** Discrete Fourier series at the harmonics of `fundamental`, over the last whole period. */
export function fourier(time: ArrayLike<number>, values: ArrayLike<number>, fundamental: number, harmonics = 9): FourierResult {
  const end = time[time.length - 1];
  const start = end - 1 / fundamental;
  if (start < time[0]) throw new Error("The transient run is shorter than one period of the fundamental.");
  const samples = 4096;
  const data = new Float64Array(samples);
  let j = 0;
  for (let i = 0; i < samples; i++) {
    const t = start + ((i + 0.5) / samples) * (end - start);
    while (j < time.length - 2 && time[j + 1] < t) j++;
    const span = time[j + 1] - time[j] || 1;
    data[i] = values[j] + ((values[j + 1] - values[j]) * (t - time[j])) / span;
  }
  let dc = 0;
  for (const v of data) dc += v;
  dc /= samples;
  const rows: FourierRow[] = [];
  for (let h = 1; h <= harmonics; h++) {
    let re = 0, im = 0;
    for (let i = 0; i < samples; i++) {
      const angle = (2 * Math.PI * h * (i + 0.5)) / samples;
      re += data[i] * Math.cos(angle);
      im -= data[i] * Math.sin(angle);
    }
    re *= 2 / samples;
    im *= 2 / samples;
    rows.push({ harmonic: h, frequency: h * fundamental, magnitude: Math.hypot(re, im), phaseDeg: (Math.atan2(im, re) * 180) / Math.PI });
  }
  const base = rows[0].magnitude || 1;
  const thd = (Math.sqrt(rows.slice(1).reduce((sum, r) => sum + r.magnitude ** 2, 0)) / base) * 100;
  return { rows, thd, dc };
}

export interface SweepRun {
  label: string;
  result: SimResult;
}

function withParam(doc: Schematic, refDes: string, param: string, value: string): Schematic {
  const copy: Schematic = structuredClone(doc);
  const comp = copy.components.find((c) => c.refDes.toUpperCase() === refDes.toUpperCase());
  if (!comp) throw new Error(`No component named ${refDes}.`);
  // Imported parts keep their main value under a file-specific key.
  const key = param === "value" && comp.valueKey ? comp.valueKey : param;
  if (!(key in comp.params)) {
    const names = Object.keys(comp.params).filter((k) => !/^p\d+$/.test(k));
    throw new Error(`${refDes} has no parameter "${param}"${names.length ? `. Try: ${names.join(", ")}.` : "."}`);
  }
  comp.params[key] = value;
  return copy;
}

export async function parameterSweep(
  doc: Schematic, refDes: string, param: string, start: number, stop: number, steps: number,
  request: AnalysisRequest, run: Runner,
): Promise<SweepRun[]> {
  const runs: SweepRun[] = [];
  if (!Number.isFinite(steps) || steps < 1) throw new Error("Enter at least one step.");
  const count = Math.round(steps);
  for (let i = 0; i < count; i++) {
    const value = count === 1 ? start : start + ((stop - start) * i) / (count - 1);
    const label = `${refDes}.${param}=${parseFloat(value.toPrecision(4))}`;
    const netlist = buildNetlist(withParam(doc, refDes, param, String(value)));
    if (netlist.errors.length) throw new Error(netlist.errors.join(" "));
    runs.push({ label, result: await run(netlist.text, request) });
  }
  return runs;
}

/** Repeats an analysis across temperatures, using the netlist's own .temp directive. */
export async function temperatureSweep(
  netlist: string, start: number, stop: number, steps: number, request: AnalysisRequest, run: Runner,
): Promise<SweepRun[]> {
  if (!Number.isFinite(steps) || steps < 1) throw new Error("Enter at least one step.");
  const count = Math.round(steps);
  const runs: SweepRun[] = [];
  for (let i = 0; i < count; i++) {
    const temp = count === 1 ? start : start + ((stop - start) * i) / (count - 1);
    const label = `${parseFloat(temp.toPrecision(4))} C`;
    const text = netlist.replace(/^\.end\s*$/m, `.temp ${temp}\n.end`);
    runs.push({ label, result: await run(text, request) });
  }
  return runs;
}

const TOLERANCED = new Set(["resistor", "capacitor", "inductor"]);

/** Varies every R, L and C uniformly within tolerance. `random` is injectable for tests. */
export async function monteCarlo(
  doc: Schematic, runs: number, tolerancePercent: number, request: AnalysisRequest, run: Runner,
  random: () => number = Math.random,
): Promise<SweepRun[]> {
  const output: SweepRun[] = [];
  if (!Number.isFinite(runs) || runs < 1) throw new Error("Enter at least one run.");
  const eligible = doc.components.filter((c) => TOLERANCED.has(c.family ?? c.kind));
  if (!eligible.length) throw new Error("Monte Carlo varies resistors, capacitors and inductors, and this circuit has none it can change.");
  for (let i = 0; i < runs; i++) {
    const copy: Schematic = structuredClone(doc);
    for (const comp of copy.components) {
      if (!TOLERANCED.has(comp.family ?? comp.kind)) continue;
      const key = comp.valueKey ?? "value";
      const factor = 1 + ((2 * random() - 1) * tolerancePercent) / 100;
      comp.params[key] = String(parseValue(comp.params[key]) * factor);
    }
    output.push({ label: `run ${i + 1}`, result: await run(buildNetlist(copy).text, request) });
  }
  return output;
}

export function findVector(result: SimResult, name: string): SimVector | undefined {
  const wanted = name.toLowerCase();
  return result.vectors.find((v) => v.name.toLowerCase() === wanted);
}

/** Below this share of the strongest signal of its kind, an AC value is the solver's rounding, not a signal. */
const AC_RESIDUE = 1e-13;

/** Each vector of an AC result in dB, with NaN where it holds no signal, which no plot should draw down to. */
export function acDecibels(result: SimResult): Map<string, Float64Array> {
  const magnitudes = result.vectors.map((v) => Float64Array.from(v.re, (re, i) => Math.hypot(re, v.im?.[i] ?? 0)));
  const strongest = new Map<string, number>();
  result.vectors.forEach((v, n) => strongest.set(v.unit, magnitudes[n].reduce((peak, m) => Math.max(peak, m), strongest.get(v.unit) ?? 0)));
  return new Map(result.vectors.map((v, n) => {
    const floor = strongest.get(v.unit)! * AC_RESIDUE;
    return [v.name, magnitudes[n].map((m) => (m > floor ? 20 * Math.log10(m) : NaN))];
  }));
}

/** The vectors of an AC result that hold a signal anywhere in the sweep. */
export function acSignals(result: SimResult): Set<string> {
  return new Set([...acDecibels(result)].filter(([, db]) => db.some((value) => !Number.isNaN(value))).map(([name]) => name));
}

export function rms(values: ArrayLike<number>, time: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    sum += ((a * a + a * b + b * b) / 3) * (time[i] - time[i - 1]);
  }
  const span = time[time.length - 1] - time[0];
  return span > 0 ? Math.sqrt(sum / span) : Math.abs(values[0] ?? 0);
}

/**
 * The samples a meter should read. A signal that is repeating right now is read across its
 * last few whole periods, so a partial period can't skew the result. Anything else is read
 * from the newest `fallback` part of the samples, so the reading follows the circuit.
 * A span of whole periods also gives the level it crosses at each end, between two samples.
 */
export function settledSpan(values: ArrayLike<number>, time: ArrayLike<number>, fallback = 0.02, noPeriods = fallback): [number, number, number?] {
  const lastIndex = time.length - 1;
  const newest = (share: number): [number, number] => {
    const recent = time[lastIndex] - (time[lastIndex] - time[0]) * share;
    let start = lastIndex;
    while (start > 0 && time[start - 1] >= recent) start--;
    return [start === lastIndex ? Math.max(0, lastIndex - 1) : start, lastIndex];
  };
  const middle = time[0] + (time[lastIndex] - time[0]) / 2;
  let center = 0, weight = 0, high = -Infinity, low = Infinity;
  for (let i = 1; i <= lastIndex; i++) {
    if (time[i] < middle) continue;
    const dt = time[i] - time[i - 1];
    center += ((values[i - 1] + values[i]) / 2) * dt;
    weight += dt;
    if (values[i] > high) high = values[i];
    if (values[i] < low) low = values[i];
  }
  if (weight <= 0) return newest(noPeriods);
  center /= weight;
  const crossings: number[] = [];
  for (let i = 1; i <= lastIndex; i++) if (values[i - 1] < center && values[i] >= center) crossings.push(i);
  // Solver residue crosses its own mean too, and isn't a signal worth measuring in periods.
  if (crossings.length < 2 || high - low <= 1e-9) return newest(noPeriods);
  const used = crossings.slice(-5);
  let shortest = Infinity, longest = 0;
  for (let i = 1; i < used.length; i++) {
    const spacing = time[used[i]] - time[used[i - 1]];
    if (spacing < shortest) shortest = spacing;
    if (spacing > longest) longest = spacing;
  }
  const ended = time[lastIndex] - time[used[used.length - 1]];
  // Irregular crossings are chatter, and old ones mean the signal has since stopped.
  if (longest > shortest * 2 || ended > longest * 2) return newest(fallback);
  return [used[0], used[used.length - 1], center];
}

/**
 * Time-weighted mean and mean square over a span from settledSpan. A span of whole periods is cut
 * at the crossings themselves, since a window ending on a sample is off by part of a step. Between
 * samples a signal follows a parabola where the bend agrees on both sides of the step, because
 * straight lines read a sine low. Anywhere else, like a ramp or an edge, straight lines are right.
 */
function settledMoments(values: ArrayLike<number>, time: ArrayLike<number>, [first, last, level]: [number, number, number?]): { span: number; mean: number; square: number; peak: number } {
  const bend = (i: number) => {
    if (i < 1 || i >= time.length - 1) return 0;
    return ((values[i + 1] - values[i]) / (time[i + 1] - time[i]) - (values[i] - values[i - 1]) / (time[i] - time[i - 1])) / (time[i + 1] - time[i - 1]);
  };
  let span = 0, mean = 0, square = 0, peak = 0;
  // Over the step from sample i - 1 to sample i.
  const add = (i: number, a: number, b: number, dt: number) => {
    const before = bend(i - 1), after = bend(i);
    const agree = before * after > 0 && Math.abs(before) < 2 * Math.abs(after) && Math.abs(after) < 2 * Math.abs(before);
    const c = agree ? (before + after) / 2 : 0;
    const dt3 = dt * dt * dt;
    span += dt;
    mean += ((a + b) / 2) * dt - (c * dt3) / 6;
    square += ((a * a + a * b + b * b) / 3) * dt - (c * dt3 * (a + b)) / 6 + (c * c * dt3 * dt * dt) / 30;
    peak = Math.max(peak, Math.abs(a), Math.abs(b));
  };
  // Samples first and last are each the first one past a crossing of the level.
  const crossing = (i: number) => (level! - values[i - 1]) / (values[i] - values[i - 1]);
  if (level !== undefined) {
    add(first, level, values[first], (time[first] - time[first - 1]) * (1 - crossing(first)));
    add(last, values[last - 1], level, (time[last] - time[last - 1]) * crossing(last));
  }
  const end = level === undefined ? last : last - 1;
  for (let i = first + 1; i <= end; i++) add(i, values[i - 1], values[i], time[i] - time[i - 1]);
  return span > 0 ? { span, mean: mean / span, square: square / span, peak } : { span, mean: 0, square: 0, peak };
}

/** Below this share of its signal, a mean is solver residue and not a reading. */
const RESIDUE = 1e-7;

/** Time average over the settled samples, which is what a DC meter shows. */
export function settledMean(values: ArrayLike<number>, time: ArrayLike<number>): number {
  const { span, mean, peak } = settledMoments(values, time, settledSpan(values, time));
  if (span <= 0) return values[values.length - 1] ?? 0;
  return Math.abs(mean) < RESIDUE * peak ? 0 : mean;
}

/** RMS over the settled samples with the mean removed. */
export function acRms(values: ArrayLike<number>, time: ArrayLike<number>): number {
  // With no periods yet, as on a slow signal just starting, more of the window is the better guess.
  const { span, mean, square } = settledMoments(values, time, settledSpan(values, time, 0.02, 0.25));
  return span > 0 ? Math.sqrt(Math.max(0, square - mean * mean)) : 0;
}

/** RMS including any DC, over whole periods when the signal repeats and otherwise all of it. */
export function settledRms(values: ArrayLike<number>, time: ArrayLike<number>): number {
  const { span, square } = settledMoments(values, time, settledSpan(values, time, 1));
  return span > 0 ? Math.sqrt(square) : Math.abs(values[0] ?? 0);
}
