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
 */
export function settledSpan(values: ArrayLike<number>, time: ArrayLike<number>, fallback = 0.02, noPeriods = fallback): [number, number] {
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
  return [used[0], used[used.length - 1]];
}

/** Time average over the settled samples, which is what a DC meter shows. */
export function settledMean(values: ArrayLike<number>, time: ArrayLike<number>): number {
  const [first, last] = settledSpan(values, time);
  let span = 0, sum = 0;
  for (let i = first + 1; i <= last; i++) {
    const dt = time[i] - time[i - 1];
    sum += ((values[i - 1] + values[i]) / 2) * dt;
    span += dt;
  }
  return span > 0 ? sum / span : values[values.length - 1] ?? 0;
}

/** RMS over the settled samples with the mean removed. */
export function acRms(values: ArrayLike<number>, time: ArrayLike<number>): number {
  // With no periods yet, as on a slow signal just starting, more of the window is the better guess.
  const [first, last] = settledSpan(values, time, 0.02, 0.25);
  let span = 0, mean = 0, square = 0;
  for (let i = first + 1; i <= last; i++) {
    const dt = time[i] - time[i - 1];
    const a = values[i - 1];
    const b = values[i];
    span += dt;
    mean += ((a + b) / 2) * dt;
    square += ((a * a + a * b + b * b) / 3) * dt;
  }
  if (span <= 0) return 0;
  mean /= span;
  return Math.sqrt(Math.max(0, square / span - mean * mean));
}
