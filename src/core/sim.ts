// Contract between the UI, the agent and the simulation engine.
// The engine consumes SPICE netlist text, so every circuit source shares one path.

export type AnalysisRequest =
  | { type: "op" }
  | { type: "dc"; source: string; start: number; stop: number; step: number }
  | { type: "ac"; sweep: "dec" | "oct" | "lin"; points: number; fstart: number; fstop: number }
  | { type: "tran"; tstep: number; tstop: number; tstart?: number; tmax?: number; uic?: boolean }
  /** output is "v(out)", "v(a,b)" or "i(vname)"; source is an independent V or I source. */
  | { type: "noise"; output: string; source: string; sweep: "dec" | "oct" | "lin"; points: number; fstart: number; fstop: number }
  /** DC small-signal transfer function from source to output. */
  | { type: "transfer"; output: string; source: string }
  /** DC sensitivity of output to every resistor, voltage source and current source value. */
  | { type: "sensitivity"; output: string }
  /** Poles and zeros of v(output[0], output[1]) / input, linearised at the operating point. */
  | { type: "polezero"; input: [string, string]; output: [string, string] };

/** Results of a "noise" analysis. Vectors hold spectral density per root hertz. */
export interface NoiseSummary {
  /** Output noise integrated over the sweep: V rms, or A rms for an i() output. */
  onoiseRms: number;
  /** Input-referred noise integrated over the sweep: V rms for a V source, A rms for an I source. */
  inoiseRms: number;
  /** Each device's share of the output, integrated over the sweep, largest first. */
  contributions: { device: string; rms: number }[];
}

export interface TransferSummary {
  /** d(output) / d(source), in V/V, V/A, A/V or A/A. */
  gain: number;
  /** Ohms seen by the source; Infinity when it drives nothing. */
  inputResistance: number;
  /** Ohms seen at the output. */
  outputResistance: number;
}

export interface SensitivityRow {
  device: string;
  /** "r" for a resistance, "v" for a voltage source value, "i" for a current source value. */
  parameter: "r" | "v" | "i";
  /** The parameter value at the operating point. */
  value: number;
  /** d(output) / d(parameter). */
  absolute: number;
  /** (parameter / output) d(output) / d(parameter); NaN when the output is zero. */
  normalized: number;
}

export interface SimVector {
  /** SPICE-style name: "v(out)", "i(v1)". Node names are lower case. */
  name: string;
  unit: "V" | "A" | "s" | "Hz" | "";
  re: Float64Array;
  /** Present only for AC results and for the "pole" and "zero" vectors of "polezero". */
  im?: Float64Array;
}

export interface SimResult {
  analysis: AnalysisRequest["type"];
  /** Sweep axis: time, frequency or source value. Absent for "op". */
  axis?: SimVector;
  vectors: SimVector[];
  warnings: string[];
  stats: { unknowns: number; iterations: number; steps: number; elapsedMs: number };
  /** Present for "noise". */
  noise?: NoiseSummary;
  /** Present for "transfer". */
  transfer?: TransferSummary;
  /** Present for "sensitivity". */
  sensitivity?: SensitivityRow[];
}

export interface SimOptions {
  onProgress?: (fraction: number) => void;
  /** Checked between solver steps; throw-free cancellation returns partial data. */
  shouldStop?: () => boolean;
}

/** New samples from a running transient, in time order, one array per name in `names`. */
export interface LiveChunk {
  time: Float64Array;
  values: Float64Array[];
}

/** A transient that continues from where it stopped, for continuous simulation. */
export interface LiveSession {
  /** Vector names, such as "v(out)" and "i(v1)", in the order `values` uses. */
  readonly names: string[];
  readonly warnings: string[];
  /** Simulated time reached so far, in seconds. */
  readonly time: number;
  /**
   * Advances until simulated time reaches `untilTime` or `budgetMs` of real time has passed,
   * whichever comes first, and returns the new samples. Throws SimError on failure.
   */
  advance(untilTime: number, budgetMs: number): LiveChunk;
  /**
   * Applies a netlist that differs from the running one only in values, keeping time, voltages,
   * stored charge and flux, digital and flip-flop state, and pending events. Returns false, with
   * the session untouched, when the structure differs or the netlist cannot be read; the caller
   * should then restart. A failure to converge at the new values is thrown by the next advance.
   */
  update(netlist: string): boolean;
}

export class SimError extends Error {
  constructor(
    message: string,
    /** "parse", "unsupported", "singular" or "convergence". */
    readonly code: "parse" | "unsupported" | "singular" | "convergence",
    /** 1-based netlist line, when known. */
    readonly line?: number,
  ) {
    super(message);
    this.name = "SimError";
  }
}
