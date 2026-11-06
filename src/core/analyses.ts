// Higher-level analyses built on repeated engine runs, independent of the UI.
import { buildNetlist, parseValue } from "./netlist";
import type { Schematic } from "./schematic";
import type { AnalysisPlan, AnalysisRequest, BatchEntry, Measurement, MonteCarloOptions, SimResult, SimVector, SweepAxis, ToleranceOptions } from "./sim";
export type { AnalysisPlan, BatchEntry, Measurement, MeasurementKind, MonteCarloOptions, SweepAxis, ToleranceOptions } from "./sim";

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
  if (!(fundamental > 0) || !Number.isFinite(fundamental) || !Number.isInteger(harmonics) || harmonics < 1 || harmonics > 128) throw new Error("Enter a positive fundamental and 1 to 128 harmonics.");
  if (time.length < 2 || time.length !== values.length) throw new Error("Fourier needs at least two transient samples.");
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
  settings?: Record<string, number>;
  measurement?: number;
  summary?: string[];
  histogram?: { edges: number[]; counts: number[] };
}

function setParam(doc: Schematic, refDes: string, param: string, value: string): void {
  const comp = doc.components.find((c) => c.refDes.toUpperCase() === refDes.toUpperCase());
  if (!comp) throw new Error(`No component named ${refDes}.`);
  // Imported parts keep their main value under a file-specific key.
  const key = param === "value" && comp.valueKey ? comp.valueKey : param;
  if (!(key in comp.params)) {
    const names = Object.keys(comp.params).filter((k) => !/^p\d+$/.test(k));
    throw new Error(`${refDes} has no parameter "${param}"${names.length ? `. Try: ${names.join(", ")}.` : "."}`);
  }
  comp.params[key] = value;
}

function withParam(doc: Schematic, refDes: string, param: string, value: string): Schematic {
  const copy: Schematic = structuredClone(doc);
  setParam(copy, refDes, param, value);
  return copy;
}

export async function parameterSweep(
  doc: Schematic, refDes: string, param: string, start: number, stop: number, steps: number,
  request: AnalysisRequest, run: Runner,
): Promise<SweepRun[]> {
  return nestedSweep(doc, [{ kind: "parameter", refDes, param, values: sweepValues(start, stop, steps) }], request, run);
}

/** Repeats an analysis across temperatures, using the netlist's own .temp directive. */
export async function temperatureSweep(
  netlist: string, start: number, stop: number, steps: number, request: AnalysisRequest, run: Runner,
): Promise<SweepRun[]> {
  const output: SweepRun[] = [];
  for (const temp of sweepValues(start, stop, steps)) {
    output.push({ label: `${parseFloat(temp.toPrecision(4))} C`, result: await run(withTemperature(netlist, temp), request), settings: { temperature: temp } });
  }
  return output;
}

/** Inclusive, evenly spaced values. Explicit lists can instead be passed straight to a SweepAxis. */
export function sweepValues(start: number, stop: number, steps: number): number[] {
  if (!Number.isInteger(steps) || steps < 1 || steps > 100000) throw new Error("Enter at least one step (a whole number, up to 100000).");
  if (!Number.isFinite(start) || !Number.isFinite(stop)) throw new Error("Enter finite sweep limits.");
  return Array.from({ length: steps }, (_, i) => steps === 1 ? start : start + (stop - start) * i / (steps - 1));
}

export function withTemperature(netlist: string, temperature: number): string {
  if (!Number.isFinite(temperature) || temperature <= -273.15) throw new Error("Enter a temperature above absolute zero.");
  const cleaned = netlist.replace(/^[ \t]*\.temp\b[^\n]*$/gim, "");
  const newline = cleaned.indexOf("\n");
  return newline < 0 ? `${cleaned}\n.temp ${temperature}\n` : `${cleaned.slice(0, newline + 1)}.temp ${temperature}\n${cleaned.slice(newline + 1)}`;
}

function checkedNetlist(doc: Schematic): string {
  const netlist = buildNetlist(doc);
  if (netlist.errors.length) throw new Error(netlist.errors.join(" "));
  return netlist.text;
}

/** Axes are outermost first; list order and duplicates are preserved. */
export async function nestedSweep(
  doc: Schematic, axes: SweepAxis[], request: AnalysisRequest, run: Runner, measurement?: Measurement,
): Promise<SweepRun[]> {
  if (!axes.length) throw new Error("Choose a sweep axis.");
  const keys = axes.map(a => a.kind === "temperature" ? "temperature" : `${a.refDes.toLowerCase()}.${a.param.toLowerCase()}`);
  if (new Set(keys).size !== keys.length) throw new Error("Choose different parameters for the sweep axes.");
  let count = 1;
  for (const axis of axes) {
    if (!axis.values.length || axis.values.some(v => !Number.isFinite(v))) throw new Error("Enter a nonempty list of finite sweep values.");
    count *= axis.values.length;
  }
  if (count > 100000) throw new Error("Choose at most 100000 sweep runs.");
  const output: SweepRun[] = [];
  const visit = async (index: number, circuit: Schematic, settings: Record<string, number>, labels: string[], temperature?: number): Promise<void> => {
    if (index === axes.length) {
      let text = checkedNetlist(circuit);
      if (temperature !== undefined) text = withTemperature(text, temperature);
      const result = await run(text, request);
      output.push({ label: labels.join(", "), result, settings, measurement: measurement ? measure(result, measurement) : undefined });
      return;
    }
    const axis = axes[index];
    for (const value of axis.values) {
      const key = axis.kind === "temperature" ? "temperature" : `${axis.refDes}.${axis.param}`;
      const label = axis.kind === "temperature" ? `${parseFloat(value.toPrecision(4))} C` : `${key}=${parseFloat(value.toPrecision(4))}`;
      await visit(index + 1, axis.kind === "parameter" ? withParam(circuit, axis.refDes, axis.param, String(value)) : circuit,
        { ...settings, [key]: value }, [...labels, label], axis.kind === "temperature" ? value : temperature);
    }
  };
  await visit(0, doc, {}, []);
  return output;
}

const TOLERANCED = new Set(["resistor", "capacitor", "inductor"]);

/** Deterministic 32-bit generator; seed zero is valid. */
export function seededRandom(seed: number): () => number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Enter a seed from 0 to 4294967295.");
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tolerancedParts(doc: Schematic, options: ToleranceOptions) {
  const overrides = new Map(Object.entries(options.tolerances ?? {}).map(([ref, value]) => [ref.toLowerCase(), value]));
  for (const ref of overrides.keys()) {
    if (!doc.components.some(c => c.refDes.toLowerCase() === ref && TOLERANCED.has(c.family ?? c.kind))) throw new Error(`No passive part named ${ref}.`);
  }
  const valid = (t: number) => Number.isFinite(t) && t >= 0 && t < 100;
  if (!valid(options.defaultTolerance)) throw new Error("Enter a tolerance from 0 up to, but below, 100 percent.");
  const parts = doc.components.filter(c => TOLERANCED.has(c.family ?? c.kind)).map(c => {
    const tolerance = overrides.get(c.refDes.toLowerCase()) ?? (c.params.tolerance !== undefined ? Number(c.params.tolerance.trim().replace(/%$/, "")) : options.defaultTolerance);
    const value = parseValue(c.params[c.valueKey ?? "value"]);
    if (!valid(tolerance)) throw new Error(`Enter a tolerance below 100 percent for ${c.refDes}.`);
    if (!(value > 0) || !Number.isFinite(value)) throw new Error(`Enter a positive value for ${c.refDes}.`);
    return { refDes: c.refDes, value, tolerance };
  });
  if (!parts.length) throw new Error("Monte Carlo varies resistors, capacitors and inductors, and this circuit has none it can change.");
  return parts;
}

/** Gaussian tolerance denotes three standard deviations; draws are not clipped. */
export async function monteCarlo(
  doc: Schematic, runs: number, tolerancePercent: number, request: AnalysisRequest, run: Runner,
  random: () => number = Math.random, options?: MonteCarloOptions, measurement?: Measurement,
): Promise<SweepRun[]> {
  if (!Number.isInteger(runs) || runs < 1 || runs > 100000) throw new Error("Enter at least one run (a whole number, up to 100000).");
  const parts = tolerancedParts(doc, options ?? { defaultTolerance: tolerancePercent });
  if (options) {
    if (!["uniform", "gaussian"].includes(options.distribution)) throw new Error("Choose a uniform or Gaussian distribution.");
    random = seededRandom(options.seed);
  }
  const output: SweepRun[] = [];
  for (let i = 0; i < runs; i++) {
    const copy = structuredClone(doc);
    const settings: Record<string, number> = {};
    for (const part of parts) {
      const deviation = options?.distribution === "gaussian"
        ? Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, random()))) * Math.cos(2 * Math.PI * random()) / 3
        : 2 * random() - 1;
      const value = part.value * (1 + deviation * part.tolerance / 100);
      if (!(value > 0)) throw new Error("A Gaussian draw produced a nonpositive value. Reduce the tolerance or change the seed.");
      setParam(copy, part.refDes, "value", String(value));
      settings[part.refDes] = value;
    }
    const result = await run(checkedNetlist(copy), request);
    output.push({ label: `run ${i + 1}`, result, settings, measurement: measurement ? measure(result, measurement) : undefined });
  }
  return output;
}

export interface WorstCaseResult { nominal: SweepRun; high: SweepRun; low: SweepRun }

/** Local sensitivity predicts two corners. This is not an exhaustive global search. */
export async function worstCase(
  doc: Schematic, options: ToleranceOptions, request: AnalysisRequest, measurement: Measurement, run: Runner,
): Promise<WorstCaseResult> {
  const parts = tolerancedParts(doc, options).filter(p => p.tolerance > 0);
  const evaluate = async (label: string, settings: Record<string, number>): Promise<SweepRun> => {
    const copy = structuredClone(doc);
    for (const [ref, value] of Object.entries(settings)) setParam(copy, ref, "value", String(value));
    const result = await run(checkedNetlist(copy), request);
    return { label, settings, result, measurement: measure(result, measurement) };
  };
  const nominal = await evaluate("nominal", Object.fromEntries(parts.map(p => [p.refDes, p.value])));
  const high: Record<string, number> = {}, low: Record<string, number> = {};
  for (const p of parts) {
    const probe = await evaluate(p.refDes, { [p.refDes]: p.value * (1 + p.tolerance / 100) });
    const direction = probe.measurement! >= nominal.measurement! ? 1 : -1;
    high[p.refDes] = p.value * (1 + direction * p.tolerance / 100);
    low[p.refDes] = p.value * (1 - direction * p.tolerance / 100);
  }
  const upper = await evaluate("worst high (predicted corner)", high);
  const lower = await evaluate("worst low (predicted corner)", low);
  const [highRun, lowRun] = upper.measurement! >= lower.measurement! ? [upper, lower] : [lower, upper];
  highRun.label = "worst high (predicted corner)";
  lowRun.label = "worst low (predicted corner)";
  return { nominal, high: highRun, low: lowRun };
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

function interpolate(x: ArrayLike<number>, y: ArrayLike<number>, at: number): number {
  if (!Number.isFinite(at) || at < x[0] || at > x[x.length - 1]) throw new Error("The measurement position is outside the run.");
  let lo = 0, hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (x[mid] <= at) lo = mid; else hi = mid;
  }
  return x.length === 1 ? y[0] : y[lo] + (y[hi] - y[lo]) * (at - x[lo]) / (x[hi] - x[lo]);
}

/** AC measurements use magnitude. Averages and RMS are weighted by the axis spacing. */
export function measure(result: SimResult, measurement: Measurement): number {
  const vector = findVector(result, measurement.vector);
  if (!vector?.re.length) throw new Error(`No samples for ${measurement.vector}.`);
  const y = vector.im ? Float64Array.from(vector.re, (v, i) => Math.hypot(v, vector.im![i])) : vector.re;
  const x = result.axis?.re;
  let low = Infinity, high = -Infinity;
  for (const value of y) { low = Math.min(low, value); high = Math.max(high, value); }
  let answer: number;
  switch (measurement.kind) {
    case "max": answer = high; break;
    case "min": answer = low; break;
    case "peakToPeak": answer = high - low; break;
    case "rms": answer = x ? rms(y, x) : Math.abs(y[0]); break;
    case "average": {
      let area = 0;
      if (x) for (let i = 1; i < x.length; i++) area += (y[i] + y[i - 1]) / 2 * (x[i] - x[i - 1]);
      answer = x && x.length > 1 ? area / (x[x.length - 1] - x[0]) : y[0];
      break;
    }
    case "at":
    case "gain": {
      if (!x) {
        if (measurement.kind === "gain") throw new Error("Gain needs an AC sweep.");
        answer = y[0];
      } else answer = interpolate(x, y, measurement.at!);
      if (measurement.kind === "gain") {
        if (result.analysis !== "ac") throw new Error("Gain needs an AC sweep.");
        const input = findVector(result, measurement.input ?? "");
        if (!input) throw new Error("Choose an input vector for gain.");
        const magnitude = Float64Array.from(input.re, (v, i) => Math.hypot(v, input.im?.[i] ?? 0));
        answer /= interpolate(x!, magnitude, measurement.at!);
      }
      break;
    }
    case "riseTime": {
      if (result.analysis !== "tran" || !x || !(high > low)) throw new Error("Rise time needs a rising transient signal.");
      const crossing = (level: number, from: number) => {
        for (let i = Math.max(1, from); i < y.length; i++) if (y[i - 1] <= level && y[i] > level) {
          return { index: i, time: x[i - 1] + (x[i] - x[i - 1]) * (level - y[i - 1]) / (y[i] - y[i - 1]) };
        }
        throw new Error("The signal does not cross both rise-time thresholds.");
      };
      const first = crossing(low + 0.1 * (high - low), 1);
      answer = crossing(low + 0.9 * (high - low), first.index).time - first.time;
      break;
    }
    case "bandwidth": {
      if (result.analysis !== "ac" || !x || !(high > 0)) throw new Error("Bandwidth needs an AC sweep with a signal.");
      const peak = y.indexOf(high), level = high / Math.SQRT2;
      const cross = (i: number) => x[i - 1] + (x[i] - x[i - 1]) * (level - y[i - 1]) / (y[i] - y[i - 1]);
      let left = x[0], right = NaN;
      for (let i = peak; i > 0; i--) if (y[i - 1] < level && y[i] >= level) { left = cross(i); break; }
      for (let i = peak + 1; i < y.length; i++) if (y[i] <= level && y[i - 1] > level) { right = cross(i); break; }
      if (!Number.isFinite(right)) throw new Error("Extend the AC sweep beyond the -3 dB crossing.");
      // A low-pass sweep begins in its passband: its bandwidth is the upper cutoff.
      answer = y[0] >= level ? right : right - left;
      break;
    }
    default: throw new Error("Choose a supported measurement.");
  }
  if (!Number.isFinite(answer)) throw new Error("The measurement is not finite. Check the signal and sweep range.");
  return answer;
}

export interface Statistics { mean: number; standardDeviation: number; minimum: number; maximum: number }
/** Population standard deviation for the completed ensemble. */
export function statistics(values: number[]): Statistics {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error("Statistics need finite measurements.");
  let mean = 0, square = 0, minimum = Infinity, maximum = -Infinity;
  values.forEach((v, i) => {
    const delta = v - mean;
    mean += delta / (i + 1);
    square += delta * (v - mean);
    minimum = Math.min(minimum, v); maximum = Math.max(maximum, v);
  });
  return { mean, standardDeviation: Math.sqrt(Math.max(0, square / values.length)), minimum, maximum };
}

export function histogram(values: number[], bins = Math.ceil(Math.sqrt(values.length))): { edges: number[]; counts: number[] } {
  const { minimum, maximum } = statistics(values);
  if (!Number.isInteger(bins) || bins < 1 || bins > 1000) throw new Error("Choose 1 to 1000 histogram bins.");
  const span = maximum - minimum || Math.abs(minimum) * 0.01 || 1;
  const start = maximum === minimum ? minimum - span / 2 : minimum;
  const edges = Array.from({ length: bins + 1 }, (_, i) => start + span * i / bins);
  const counts = Array<number>(bins).fill(0);
  for (const value of values) counts[Math.min(bins - 1, Math.floor((value - start) / span * bins))]++;
  return { edges, counts };
}

/** Fourier distortion, including each harmonic as percent of the fundamental. */
export function distortion(result: SimResult, vector: string, fundamental: number, harmonics = 9) {
  if (result.analysis !== "tran" || !result.axis) throw new Error("Distortion needs a transient run.");
  const signal = findVector(result, vector);
  if (!signal) throw new Error(`No signal named ${vector}.`);
  const output = fourier(result.axis.re, signal.re, fundamental, harmonics);
  if (!(output.rows[0].magnitude > 1e-15)) throw new Error("No fundamental signal to measure distortion against.");
  return { ...output, rows: output.rows.map(row => ({ ...row, relativePercent: row.magnitude / output.rows[0].magnitude * 100 })) };
}

/** Simultaneous sine/cosine fit separates the two carriers and second/third order products. */
export function intermodulation(result: SimResult, vector: string, f1: number, f2: number, start = 0) {
  const signal = findVector(result, vector), time = result.axis?.re;
  if (result.analysis !== "tran" || !signal || !time || !(f1 > 0) || !(f2 > 0) || f1 === f2) throw new Error("IMD needs a transient signal and two different positive frequencies.");
  if (!Number.isFinite(f1 + f2 + start) || start < time[0] || time[time.length - 1] - start < 1 / Math.abs(f2 - f1)) throw new Error("Use at least one beat period after the IMD settling time.");
  const products = [...new Set([Math.abs(f2 - f1), f1 + f2, Math.abs(2 * f1 - f2), Math.abs(2 * f2 - f1), 2 * f1 + f2, 2 * f2 + f1])].filter(f => f > 0 && f !== f1 && f !== f2);
  const frequencies = [...new Set([f1, f2, ...products, 2 * f1, 2 * f2, 3 * f1, 3 * f2])];
  const size = frequencies.length * 2 + 1;
  const matrix = Array.from({ length: size }, () => new Float64Array(size + 1));
  // Bounded work, with interpolated uniform samples, even on adaptive transient steps.
  const end = time[time.length - 1];
  const samples = Math.max(4096, Math.ceil(8 * (end - start) * Math.max(...frequencies)));
  if (samples > 262144) throw new Error("The IMD window needs too many samples. Use fewer beat periods or more widely spaced tones.");
  let at = 0;
  for (let i = 0; i < samples; i++) {
    const t = start + (i + 0.5) * (end - start) / samples;
    while (at < time.length - 2 && time[at + 1] < t) at++;
    const value = signal.re[at] + (signal.re[at + 1] - signal.re[at]) * (t - time[at]) / (time[at + 1] - time[at]);
    const row = [1, ...frequencies.flatMap(f => [Math.cos(2 * Math.PI * f * t), Math.sin(2 * Math.PI * f * t)])];
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) matrix[a][b] += row[a] * row[b];
      matrix[a][size] += row[a] * value;
    }
  }
  for (let a = 0; a < size; a++) {
    let pivot = a;
    for (let b = a + 1; b < size; b++) if (Math.abs(matrix[b][a]) > Math.abs(matrix[pivot][a])) pivot = b;
    [matrix[a], matrix[pivot]] = [matrix[pivot], matrix[a]];
    if (Math.abs(matrix[a][a]) < 1e-8) throw new Error("The IMD tones cannot be separated in this window.");
    const scale = matrix[a][a];
    for (let b = a; b <= size; b++) matrix[a][b] /= scale;
    for (let b = 0; b < size; b++) if (b !== a) {
      const factor = matrix[b][a];
      for (let c = a; c <= size; c++) matrix[b][c] -= factor * matrix[a][c];
    }
  }
  const magnitude = (f: number) => {
    const index = frequencies.indexOf(f) * 2 + 1;
    return Math.hypot(matrix[index][size], matrix[index + 1][size]);
  };
  const reference = Math.hypot(magnitude(f1), magnitude(f2));
  if (!(reference > 1e-15)) throw new Error("No carrier signal to measure IMD against.");
  const rows = products.map(frequency => ({ frequency, magnitude: magnitude(frequency), relativePercent: magnitude(frequency) / reference * 100 }));
  return { rows, imd: Math.hypot(...rows.map(r => r.magnitude)) / reference * 100 };
}

/** Total input-referred noise includes the source resistor's noise. The circuit must contain it. */
export function noiseFigure(result: SimResult, sourceResistance: number): SimResult {
  if (result.analysis !== "noise" || !result.axis || !(sourceResistance > 0) || !Number.isFinite(sourceResistance)) throw new Error("Noise figure needs a noise run and a positive source resistance.");
  const input = findVector(result, "inoise");
  if (!input) throw new Error("The noise run has no input-referred density.");
  const thermal = 4 * 1.380649e-23 * 290 * sourceResistance;
  return { ...result, vectors: [{ name: "noise figure (dB)", unit: "", re: Float64Array.from(input.re, v => 10 * Math.log10(v * v / thermal)) }] };
}

/** The same orchestration serves individual analyses, saved batches and the worker. */
export async function executeAnalysisPlan(netlist: string, plan: AnalysisPlan, run: Runner, doc?: Schematic): Promise<SweepRun[]> {
  const circuit = () => {
    if (!doc) throw new Error("This analysis needs the current schematic.");
    return doc;
  };
  switch (plan.type) {
    case "sweep": return nestedSweep(circuit(), plan.axes, plan.request, run, plan.measurement);
    case "montecarlo": {
      const runs = await monteCarlo(circuit(), plan.options.runs, plan.options.defaultTolerance, plan.request, run, undefined, plan.options, plan.measurement);
      const values = runs.map(r => r.measurement!);
      const stats = statistics(values);
      runs[0].summary = [`Mean: ${stats.mean}`, `Standard deviation (population): ${stats.standardDeviation}`, `Minimum: ${stats.minimum}`, `Maximum: ${stats.maximum}`];
      runs[0].histogram = histogram(values);
      return runs;
    }
    case "worstcase": {
      const out = await worstCase(circuit(), plan.options, plan.request, plan.measurement, run);
      return [out.nominal, out.high, out.low];
    }
    case "distortion": {
      const result = await run(netlist, plan.request);
      const out = distortion(result, plan.vector, plan.fundamental, plan.harmonics);
      return [{ label: plan.vector, result, summary: [`DC: ${out.dc}`, `THD: ${out.thd.toFixed(5)} %`, ...out.rows.map(r => `#${r.harmonic} (${r.frequency} Hz): ${r.magnitude.toPrecision(7)}, ${r.relativePercent.toFixed(5)} % of fundamental, ${r.phaseDeg.toFixed(2)} deg`)] }];
    }
    case "imd": {
      const result = await run(netlist, plan.request);
      const out = intermodulation(result, plan.vector, plan.f1, plan.f2, plan.start);
      return [{ label: plan.vector, result, summary: [`IMD (2nd/3rd order products, RSS / RSS carriers): ${out.imd.toFixed(5)} %`, ...out.rows.map(r => `${r.frequency} Hz: ${r.relativePercent.toFixed(5)} %`)] }];
    }
    case "noisefigure": return [{ label: "Noise figure (dB)", result: await noiseFigureAnalysis(netlist, plan.request, plan.sourceResistance, run) }];
    case "batch": return batchAnalyses(netlist, plan.entries, run, doc);
    case "op": case "dc": case "ac": case "tran": case "noise": case "transfer": case "sensitivity": case "polezero":
      return [{ label: "", result: await run(netlist, plan) }];
    default: throw new Error("Choose a supported analysis.");
  }
}

/** Saved requests share the current circuit. Stop on the first failed run. */
export async function batchAnalyses(netlist: string, entries: BatchEntry[], run: Runner, doc?: Schematic): Promise<SweepRun[]> {
  if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw new Error("Add 1 to 1000 analyses to the batch.");
  const output: SweepRun[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.label !== "string" || !entry.request || (entry.request as AnalysisPlan).type === "batch") throw new Error("Enter named analyses without nested batches.");
    const runs = await executeAnalysisPlan(netlist, entry.request, run, doc);
    for (const r of runs) output.push({ ...r, label: [entry.label, r.label].filter(Boolean).join(": ") });
  }
  return output;
}

/** Noise figure requires a voltage input and all source resistance noise in the circuit. */
export async function noiseFigureAnalysis(netlist: string, request: Extract<AnalysisRequest, { type: "noise" }>, sourceResistance: number, run: Runner): Promise<SimResult> {
  if (!/^v/i.test(request.source)) throw new Error("Noise figure needs a voltage input source.");
  return noiseFigure(await run(withTemperature(netlist, 16.85), request), sourceResistance);
}
