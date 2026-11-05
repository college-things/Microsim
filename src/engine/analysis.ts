// Analyses: operating point with convergence aids, DC sweep, AC and adaptive transient.

import { SimError, type AnalysisRequest, type SensitivityRow, type SimOptions, type SimResult, type SimVector } from "../core/sim";
import { Circuit, G_CLAMP, MODE_DC, MODE_TRAN, MODE_UIC, type Clamp, type Device } from "./circuit";
import { Capacitor, CurrentSource, dcSourceValue, Inductor, Resistor, SmoothSwitch, Switch, VoltageSource, type SourceSpec } from "./devices";
import { EigenFailure, pencilEigenvalues, SingularPencil, type Complex, type PencilEntry } from "./pencil";
import { LU_NONFINITE, LU_OK, LU_SINGULAR, SparseLU } from "./sparse";

const GMIN_START = 1e-2;
const SOURCE_STEP_MIN = 1e-6;
const RESCUE_GSHUNT = 1e-9;
/** The share of a node's conductance GMIN may be before its voltage is noticeably off. */
const GMIN_SHARE = 1e-3;
/** Limits that make an unreasonable run fail in bounded time instead of hanging the worker. */
const MAX_SWEEP_POINTS = 10_000_000;
/** A transient stops here and returns what it has, so a very long stored run still gives results. */
const MAX_TRAN_STEPS = 20_000_000;
/** A run this far beyond the step limit can only be a mistake, and is refused before it starts. */
const ABSURD_TRAN_STEPS = 1e12;
const MAX_WORK = 1e10;
/** A transient returns partial results a little before the work limit would refuse it. */
const WORK_STOP = 0.95 * MAX_WORK;
/** Dense eigenvalue work grows with the cube of the size; beyond this it is not worth trusting. */
const MAX_POLEZERO_UNKNOWNS = 300;
/** Step limit from the circuit's dynamics: size, resolution and what it may cost. */
const MAX_DYNAMICS_UNKNOWNS = 200;
const LIGHTLY_DAMPED_Q = 5;
const STEPS_PER_CYCLE = 30;
const MAX_GROWTH_STEPS = 1_000_000;
const MAX_RINGING_STEPS = 200_000;
/** Truncation error ratio below which a lightly damped mode counts as not ringing. */
const RINGING_RATIO = 0.02;
/** A live session runs without a stop time. */
const LIVE_DEFAULT_TMAX = 1e-3;
const LIVE_HORIZON = 1e30;
/** How far ahead the step guard looks for a live session, whose real limit is the time budget. */
const LIVE_HORIZON_FOR_GUARD = 1e-3;
/** Each stepping solve gets at least this many iterations, whatever .options itl1 says. */
const STEP_ITER_FLOOR = 50;

/** Unwinds a solve when shouldStop fires; the analysis returns what it has. */
class StopRun extends Error {}

interface OutputSpec {
  name: string;
  unit: "V" | "A";
  index: number;
}

/** All the state of a transient between steps, so that a run can stop and continue. */
export interface TranRun {
  t: number;
  t1: number;
  t2: number;
  order: number;
  nHist: number;
  beHold: number;
  h: number;
  hLast: number;
  orderLast: number;
  eventRetries: number;
  rejected: boolean;
  softBp: number;
  nextBp: number;
  x1: Float64Array;
  x2: Float64Array;
  x3: Float64Array;
  peak: Float64Array;
  lteMask: Uint8Array;
  tmax: number;
  tCap: number;
  hLteFloor: number;
  tstart: number;
  tstop: number;
  epsBase: number;
  /** The tmax asked for, before limits from the circuit. */
  requested: number;
  /** Step needed while a lightly damped mode rings, in a live session. */
  ringCap: number;
  ringing: boolean;
  quietSteps: number;
  /** How near until counts as reached: a fixed run lands on tstop, a live one passes it. */
  closeTo: number;
  limited: boolean;
  span: number;
  lastProgress: number;
}

/** Stored values across all vectors before a run starts dropping points, about 320 MB. */
const MAX_STORED_VALUES = 40_000_000;

/**
 * Growable sample storage, one Float64Array per vector. When storage reaches its limit every
 * second sample is dropped and later samples are kept at half the rate, so a long run keeps its
 * whole time span at a coarser resolution instead of exhausting memory.
 */
export class Collector {
  private readonly data: Float64Array[];
  private readonly dataIm: Float64Array[];
  private axis: Float64Array;
  private cap: number;
  private readonly maxSamples: number;
  private stride = 1;
  private skipped = 0;
  private gap = 1;
  private scatter = 0;
  private lastAxis = NaN;
  private lastX: Float64Array | null = null;
  decimated = false;
  count = 0;

  constructor(
    readonly specs: { name: string; unit: "V" | "A"; index: number }[],
    expected: number,
    private readonly complex: boolean,
    maxValues = MAX_STORED_VALUES,
  ) {
    this.maxSamples = Math.max(16, Math.floor(maxValues / Math.max(1, specs.length + 1)));
    this.cap = Math.min(this.maxSamples, Math.max(8, expected));
    this.axis = new Float64Array(this.cap);
    this.data = specs.map(() => new Float64Array(this.cap));
    this.dataIm = complex ? specs.map(() => new Float64Array(this.cap)) : [];
  }

  /** Goes around 0 to 1 without settling into a pattern, so what's kept doesn't either. */
  private nextScatter(): number {
    this.scatter = (this.scatter + 0.6180339887498949) % 1;
    return this.scatter;
  }

  /**
   * Halves what's stored, by keeping either point of each pair. A fixed pattern could land on the
   * same part of every period of a steady waveform, and plot it as a flat line.
   */
  private decimate(): void {
    const picks = new Int32Array((this.count + 1) >> 1);
    for (let k = 1; k < picks.length; k++) picks[k] = Math.min(2 * k + (this.nextScatter() < 0.5 ? 0 : 1), this.count - 1);
    const keep = (a: Float64Array): void => {
      for (let k = 0; k < picks.length; k++) a[k] = a[picks[k]!]!;
    };
    keep(this.axis);
    for (const d of this.data) keep(d);
    for (const d of this.dataIm) keep(d);
    this.count = (this.count + 1) >> 1;
    this.stride *= 2;
    this.decimated = true;
  }

  /** Make sure the most recent sample survives thinning, so a run ends at its final time. */
  finish(): void {
    if (this.skipped > 0 && this.lastX) this.store(this.lastAxis, this.lastX);
    this.skipped = 0;
  }

  private grow(): void {
    this.cap = Math.min(this.maxSamples, this.cap * 2);
    const up = (a: Float64Array): Float64Array => {
      const b = new Float64Array(this.cap);
      b.set(a);
      return b;
    };
    this.axis = up(this.axis);
    for (let i = 0; i < this.data.length; i++) this.data[i] = up(this.data[i]!);
    for (let i = 0; i < this.dataIm.length; i++) this.dataIm[i] = up(this.dataIm[i]!);
  }

  push(axis: number, x: Float64Array, xIm?: Float64Array): void {
    if (this.stride > 1) {
      if (++this.skipped < this.gap) {
        this.lastAxis = axis;
        if (!this.lastX) this.lastX = new Float64Array(x.length);
        this.lastX.set(x);
        return;
      }
      this.skipped = 0;
      this.gap = 1 + Math.floor(this.nextScatter() * (2 * this.stride - 1));
    }
    this.store(axis, x, xIm);
  }

  private store(axis: number, x: Float64Array, xIm?: Float64Array): void {
    if (this.count === this.cap) {
      if (this.cap < this.maxSamples) this.grow();
      else this.decimate();
    }
    const k = this.count++;
    this.axis[k] = axis;
    const specs = this.specs;
    for (let i = 0; i < specs.length; i++) this.data[i]![k] = x[specs[i]!.index]!;
    if (this.complex && xIm) {
      for (let i = 0; i < specs.length; i++) this.dataIm[i]![k] = xIm[specs[i]!.index]!;
    }
  }

  vectors(): SimVector[] {
    return this.specs.map((s, i) => {
      const v: SimVector = { name: s.name, unit: s.unit, re: this.data[i]!.slice(0, this.count) };
      if (this.complex) v.im = this.dataIm[i]!.slice(0, this.count);
      return v;
    });
  }

  axisValues(): Float64Array {
    return this.axis.slice(0, this.count);
  }
}

export class Analysis {
  private readonly lu: SparseLU;
  private readonly specs: OutputSpec[];
  private iterations = 0;
  private steps = 0;
  /** Matrix entries processed so far, the budget that bounds a run. */
  private work = 0;
  /** The most steps one transient may take. */
  stepLimit = MAX_TRAN_STEPS;
  private clamps: Clamp[] = [];
  private gshunt = 0;
  private lastSingular = false;
  private worst = 0;
  private reuseFactor = false;
  /** Newton polls shouldStop only during DC solves; transient polls between steps. */
  private watchStop = false;
  private sawFloating = false;
  private readonly acceptList: Device[];
  private readonly linear: boolean;
  private readonly eventList: Device[];

  constructor(private readonly c: Circuit, private readonly opts: SimOptions) {
    this.lu = new SparseLU(c.mat, false);
    this.specs = this.outputs();
    this.acceptList = c.devices.filter((d) => d.needsAccept);
    this.linear = c.devices.every((d) => d.linear);
    this.eventList = c.devices.filter((d) => d.hasEvents);
  }

  private outputs(): OutputSpec[] {
    const c = this.c;
    const specs: OutputSpec[] = [];
    const named = (top: boolean): void => {
      for (let i = 1; i < c.names.length; i++) {
        const nm = c.names[i]!;
        if (!c.isNode[i] || nm.includes("#")) continue;
        if (c.isTopNode[i] === top) specs.push({ name: `v(${nm})`, unit: "V", index: i });
      }
    };
    named(true);
    named(false);
    for (const d of c.devices) {
      if ((d instanceof VoltageSource || d instanceof Inductor) && !d.name.includes("#")) {
        specs.push({ name: `i(${d.name})`, unit: "A", index: d.branch });
      }
    }
    return specs;
  }

  private assemble(): void {
    const c = this.c;
    c.vals.fill(0);
    c.rhs.fill(0);
    const devices = c.devices;
    for (let i = 0; i < devices.length; i++) devices[i]!.load(c);
    c.rhs[0] = 0;
    const g = c.gmin + this.gshunt;
    if (g !== 0) {
      const slots = this.gshunt !== 0 ? c.nodeSlots : c.gminSlots;
      const v = c.vals;
      for (let i = 0; i < slots.length; i++) v[slots[i]!]! += g;
    }
    const clamps = this.clamps;
    for (let i = 0; i < clamps.length; i++) {
      const cl = clamps[i]!;
      c.vals[c.mat.slot(cl.node, cl.node)]! += G_CLAMP;
      c.rhs[cl.node]! += G_CLAMP * cl.value;
    }
  }

  /** Damped Newton. With damp, node steps are scaled so none exceeds a few volts. */
  private newton(maxIter: number, damp: boolean): boolean {
    const c = this.c;
    const n = c.n;
    const isNode = c.isNode;
    this.lastSingular = false;
    let lastNoncon = 1;
    for (let iter = 0; iter < maxIter; iter++) {
      if (this.watchStop && this.stop()) throw new StopRun();
      this.work += this.lu.fillNonzeros + n + 16;
      if (this.work > MAX_WORK) {
        throw new SimError("The run exceeded the engine's work limit; shorten it or simplify the circuit", "unsupported");
      }
      c.iter = iter;
      c.noncon = 0;
      this.assemble();
      this.iterations++;
      if (!this.reuseFactor) {
        const st = this.lu.factor();
        if (this.lu.boostedNode !== 0) {
          c.warn(`${c.unknownName(this.lu.boostedNode)} floats behind very large conductances; its voltage is not reliable`);
          this.lu.boostedNode = 0;
          this.sawFloating = true;
        }
        if (st !== LU_OK) {
          this.lastSingular = st === LU_SINGULAR;
          c.initJct = false;
          return false;
        }
      }
      const x = c.x;
      const xNew = c.xNew;
      this.lu.solve(c.rhs, xNew);
      xNew[0] = 0;

      let conv = c.noncon === 0 && (iter > 0 || this.linear);
      let maxDelta = 0;
      let worstRatio = 0;
      const reltol = c.reltol;
      for (let i = 1; i <= n; i++) {
        const nw = xNew[i]!;
        const old = x[i]!;
        const d = nw > old ? nw - old : old - nw;
        const an = nw < 0 ? -nw : nw;
        const ao = old < 0 ? -old : old;
        const tol = reltol * (an > ao ? an : ao) + (isNode[i] ? c.vntol : c.abstol);
        if (!(d <= tol)) {
          if (!Number.isFinite(nw)) {
            c.initJct = false;
            this.worst = i;
            return false;
          }
          conv = false;
          const r = d / tol;
          if (r > worstRatio) {
            worstRatio = r;
            this.worst = i;
          }
        }
        if (isNode[i] && d > maxDelta) maxDelta = d;
      }
      // Every nonlinear device agreeing with its linearisation twice running means what still moves is
      // rounding noise, as in a floating node behind large conductances, and not an unsolved circuit.
      const quiet = c.noncon === 0 && iter >= 2 && lastNoncon === 0;
      lastNoncon = c.noncon;
      if (conv || quiet || this.linear) {
        c.x = xNew;
        c.xNew = x;
        c.initJct = false;
        return true;
      }
      if (damp && maxDelta > 3) {
        const a = 3 / maxDelta;
        for (let i = 1; i <= n; i++) x[i]! += a * (xNew[i]! - x[i]!);
      } else {
        c.x = xNew;
        c.xNew = x;
      }
      c.initJct = false;
    }
    return false;
  }

  private resetX(): void {
    this.c.x.fill(0);
    this.c.xNew.fill(0);
    this.c.initJct = true;
  }

  private gminStepping(): boolean {
    const c = this.c;
    const limit = Math.max(c.itl1, STEP_ITER_FLOOR);
    // Larger shunts make the starting solve easier when the usual one fails.
    let gs = GMIN_START;
    let ok = false;
    for (; gs <= 1e2 && !ok; gs *= 100) {
      this.resetX();
      this.gshunt = gs;
      ok = this.newton(limit, false);
      if (ok) break;
    }
    if (!ok) {
      this.gshunt = 0;
      return false;
    }
    const good = new Float64Array(c.x);
    let factor = 10;
    const floor = Math.max(c.gmin, 1e-15);
    for (;;) {
      const next = gs / factor <= floor ? 0 : gs / factor;
      this.gshunt = next;
      c.x.set(good);
      ok = this.newton(limit, false);
      if (ok) {
        good.set(c.x);
        gs = next;
        if (next === 0) return true;
        factor = Math.min(10, factor * 1.5);
      } else {
        factor = Math.sqrt(factor);
        if (factor < 1.001) {
          this.gshunt = 0;
          return false;
        }
      }
    }
  }

  private sourceStepping(): boolean {
    const c = this.c;
    this.resetX();
    this.gshunt = 0;
    c.srcFactor = 0;
    const limit = Math.max(c.itl1, STEP_ITER_FLOOR);
    if (!this.newton(limit, false)) {
      c.srcFactor = 1;
      return false;
    }
    const good = new Float64Array(c.x);
    let f = 0;
    let raise = 0.1;
    while (f < 1) {
      const next = Math.min(1, f + raise);
      c.srcFactor = next;
      c.x.set(good);
      if (this.newton(limit, false)) {
        good.set(c.x);
        f = next;
        raise = Math.min(0.5, raise * 1.5);
      } else {
        raise /= 4;
        if (raise < SOURCE_STEP_MIN) {
          c.srcFactor = 1;
          return false;
        }
      }
    }
    c.srcFactor = 1;
    return true;
  }

  private throwSingular(context: string): never {
    const c = this.c;
    const col = c.unknownName(this.lu.failCol);
    const row = c.unknownName(this.lu.failRow);
    const who = col === row ? col : `${col} / ${row}`;
    const isBranch = !c.isNode[this.lu.failCol] || !c.isNode[this.lu.failRow];
    const hint = isBranch
      ? "check for a loop of voltage sources or inductors"
      : "the node has no usable path to the rest of the circuit";
    throw new SimError(`Singular matrix during ${context} at ${who}: ${hint}`, "singular");
  }

  /** Solve the DC system. Warm uses the current x as the initial guess. */
  private solveDc(warm: boolean, context: string): void {
    this.watchStop = true;
    try {
      this.solveDcInner(warm, context);
    } finally {
      this.watchStop = false;
    }
  }

  private solveDcInner(warm: boolean, context: string): void {
    const c = this.c;
    const start = this.iterations;
    if (warm) {
      c.initJct = false;
      if (this.newton(c.itl1, false)) return;
    } else if (c.nodesets.length > 0) {
      // A first solve with nodes held at their nodesets gives the real solve its guess.
      const saved = this.clamps;
      this.clamps = saved.concat(c.nodesets);
      this.resetX();
      const held = this.newton(c.itl1, false);
      this.clamps = saved;
      if (held && this.newton(c.itl1, false)) return;
    }
    this.resetX();
    if (this.newton(c.itl1, false)) return;
    if (this.lastSingular && this.linear) this.throwSingular(context);
    if (this.linear) {
      throw new SimError(`${context}: linear solve produced non-finite values`, "convergence");
    }
    this.resetX();
    if (this.newton(2 * c.itl1, true)) return;
    if (this.gminStepping()) return;
    if (this.sourceStepping()) return;
    if (this.lastSingular) this.throwSingular(context);
    const used = this.iterations - start;
    throw new SimError(
      `${context} did not converge after ${used} Newton iterations, including GMIN and source stepping; ` +
        `largest update at ${c.unknownName(this.worst)}`,
      "convergence",
    );
  }

  /** Re-evaluate devices exactly at x, without limiting, then commit. */
  private settleAtSolution(): void {
    const c = this.c;
    c.iter = 0;
    c.noncon = 0;
    c.initJct = false;
    this.assemble();
    for (let i = 0; i < this.acceptList.length; i++) this.acceptList[i]!.accept(c);
  }

  /**
   * A circuit with semiconductors keeps GMIN on every node, so says where it changes a reading:
   * on a node of the circuit where nothing conducts much better than a very large resistor. Inside
   * a model, and on a pin left unconnected, there is no reading to change.
   */
  private warnGminReading(): void {
    const c = this.c;
    if (c.gminSlots.length < c.nodeSlots.length || this.linear && !c.digital) return;
    for (const d of c.devices) {
      if (!(d instanceof Resistor) || d.resistance * c.gmin <= GMIN_SHARE) continue;
      for (const node of d.nodes) {
        if (node === 0 || !c.isTopNode[node] || /(^|.)nc_/.test(c.names[node]!)) continue;
        const others = c.vals[c.mat.slot(node, node)]! - c.gmin;
        if (c.gmin > GMIN_SHARE * others) c.warn(`${d.name.toUpperCase()} is so large that the ${c.gmin} S the solver keeps from every node to ground changes ${c.unknownName(node)}. Circuits with semiconductors need that path, so treat this reading as approximate`);
      }
    }
  }

  /** Alternate the digital settle and the analog solve until they agree. */
  private solveMixed(warm: boolean, context: string): void {
    const c = this.c;
    const digital = c.digital;
    if (!digital) {
      this.solveDc(warm, context);
      return;
    }
    digital.settle(c);
    this.solveDc(warm, context);
    for (let i = 0; i < 16; i++) {
      if (!digital.settle(c)) return;
      this.solveDc(true, context);
    }
    c.warn(`${context}: digital and analog parts did not agree after 16 passes`);
  }

  private solveOp(context: string): void {
    const c = this.c;
    c.mode = MODE_DC;
    c.ag0 = 0;
    c.trapF = 0;
    try {
      this.solveMixed(false, context);
    } catch (e) {
      if (!(e instanceof SimError) || e.code !== "convergence" || c.ics.length === 0 || this.clamps.length > 0) throw e;
      // A machine or integrator can have no equilibrium at all: a commutated motor keeps turning, so
      // no DC solution exists for its shaft angle. Holding the .ic nodes gives the state the
      // circuit starts from, the same point a transient would begin at.
      this.clamps = c.ics;
      try {
        this.solveMixed(false, context);
        c.warn(`${context}: no free DC solution exists, so this is the solution with the .ic nodes held at their values`);
      } catch {
        throw e;
      } finally {
        this.clamps = [];
      }
    }
    this.settleAtSolution();
    this.warnGminReading();
    for (let i = 1; i <= c.n; i++) {
      const a = Math.abs(c.x[i]!);
      if (c.isNode[i] && a > 1e9) {
        c.warn(`${c.unknownName(i)} reached ${c.x[i]!.toExponential(3)} V; the node is probably floating`);
      } else if (!c.isNode[i] && a > 1e5) {
        c.warn(`${c.unknownName(i)} reached ${c.x[i]!.toExponential(3)} A in the DC solution; check for a source across an ideal inductor`);
      }
    }
  }

  private result(
    analysis: AnalysisRequest["type"],
    vectors: SimVector[],
    axis: SimVector | undefined,
    start: number,
  ): SimResult {
    const res: SimResult = {
      analysis,
      vectors,
      warnings: this.c.warnings,
      stats: {
        unknowns: this.c.n,
        iterations: this.iterations,
        steps: this.steps,
        elapsedMs: now() - start,
      },
    };
    if (axis) res.axis = axis;
    return res;
  }

  private stop(): boolean {
    return this.opts.shouldStop ? this.opts.shouldStop() : false;
  }

  /** Run a solve; false when shouldStop interrupted it, with a warning recorded. */
  private stoppable(solve: () => void): boolean {
    try {
      solve();
      return true;
    } catch (e) {
      if (!(e instanceof StopRun)) throw e;
      this.c.warn("Stopped during the DC solve; results are partial");
      return false;
    }
  }

  private progress(f: number): void {
    if (this.opts.onProgress) this.opts.onProgress(f);
  }

  op(start: number): SimResult {
    const col = new Collector(this.specs, 1, false);
    if (this.stoppable(() => this.solveOp("Operating point"))) {
      this.steps = 1;
      col.push(0, this.c.x);
    }
    this.progress(1);
    return this.result("op", col.vectors(), undefined, start);
  }

  dc(req: Extract<AnalysisRequest, { type: "dc" }>, start: number): SimResult {
    const c = this.c;
    const name = req.source.toLowerCase();
    const dev = c.named.get(name);
    if (!(dev instanceof VoltageSource || dev instanceof CurrentSource)) {
      throw new SimError(`DC sweep source '${req.source}' is not an independent source in this circuit`, "parse");
    }
    if (req.step === 0) throw new SimError("DC sweep step must not be zero", "parse");
    const span = req.stop - req.start;
    const step = span < 0 ? -Math.abs(req.step) : Math.abs(req.step);
    if (!Number.isFinite(req.start) || !Number.isFinite(req.stop) || !Number.isFinite(req.step)) {
      throw new SimError("DC sweep limits must be finite", "parse");
    }
    const count = Math.floor(Math.abs(span / step) + 1e-9) + 1;
    if (!(count <= MAX_SWEEP_POINTS)) {
      throw new SimError(`DC sweep would take ${count} points; the limit is ${MAX_SWEEP_POINTS}`, "unsupported");
    }
    const col = new Collector(this.specs, count, false);
    const spec: SourceSpec = dev.spec;
    spec.hasDc = true;
    c.mode = MODE_DC;
    c.ag0 = 0;
    c.trapF = 0;
    c.tranSources = false;
    let solved = false;
    for (let k = 0; k < count; k++) {
      if (this.stop()) {
        c.warn("Stopped before the DC sweep finished; results are partial");
        break;
      }
      const v = req.start + k * step;
      spec.dc = v;
      if (!this.stoppable(() => this.solveMixed(solved, `DC sweep at ${req.source} = ${v}`))) break;
      solved = true;
      this.settleAtSolution();
      col.push(v, c.x);
      this.steps++;
      this.progress((k + 1) / count);
    }
    col.finish();
    const axis: SimVector = {
      name: name,
      unit: dev instanceof VoltageSource ? "V" : "A",
      re: col.axisValues(),
    };
    return this.result("dc", col.vectors(), axis, start);
  }

  private frequencies(req: { sweep: "dec" | "oct" | "lin"; points: number; fstart: number; fstop: number }): Float64Array {
    const { sweep, points, fstart, fstop } = req;
    if (!Number.isFinite(fstart) || !Number.isFinite(fstop) || !Number.isFinite(points)) {
      throw new SimError("Sweep limits must be finite", "parse");
    }
    if (!(fstart > 0) && sweep !== "lin") {
      throw new SimError("AC sweep start frequency must be above zero for dec and oct sweeps", "parse");
    }
    if (!(fstop >= fstart) || !(points >= 1)) {
      throw new SimError("AC sweep needs fstop >= fstart and at least one point", "parse");
    }
    const out: number[] = [];
    const expected = sweep === "lin" ? points : (Math.log(fstop / fstart) / Math.log(sweep === "dec" ? 10 : 2)) * points + 1;
    if (!(expected <= MAX_SWEEP_POINTS)) {
      throw new SimError(`Frequency sweep would take ${Math.round(expected)} points; the limit is ${MAX_SWEEP_POINTS}`, "unsupported");
    }
    if (sweep === "lin") {
      if (points === 1) return new Float64Array([fstart]);
      const df = (fstop - fstart) / (points - 1);
      for (let i = 0; i < points; i++) out.push(fstart + i * df);
    } else {
      const ratio = sweep === "dec" ? Math.pow(10, 1 / points) : Math.pow(2, 1 / points);
      const total = Math.floor(Math.log(fstop / fstart) / Math.log(ratio) + 1e-9) + 1;
      for (let i = 0; i < total; i++) out.push(fstart * Math.pow(ratio, i));
    }
    return new Float64Array(out);
  }

  ac(req: Extract<AnalysisRequest, { type: "ac" }>, start: number): SimResult {
    const c = this.c;
    const freqs = this.frequencies(req);
    const axisOf = (col: Collector): SimVector => ({ name: "frequency", unit: "Hz", re: col.axisValues() });
    if (!this.stoppable(() => this.solveOp("AC operating point"))) {
      const empty = new Collector(this.specs, 1, true);
      return this.result("ac", empty.vectors(), axisOf(empty), start);
    }

    const B = this.stampSmallSignal(true);

    const lu = new SparseLU(c.mat, true);
    const col = new Collector(this.specs, freqs.length, true);
    const xr = new Float64Array(c.n + 1);
    const xi = new Float64Array(c.n + 1);
    let hasStimulus = false;
    for (let i = 1; i <= c.n; i++) if (c.acRe[i] !== 0 || c.acIm[i] !== 0) hasStimulus = true;
    if (!hasStimulus) c.warn("AC analysis has no source with an AC magnitude; all results are zero");

    for (let k = 0; k < freqs.length; k++) {
      if (this.stop()) {
        c.warn("Stopped before the AC sweep finished; results are partial");
        break;
      }
      const f = freqs[k]!;
      const w = 2 * Math.PI * f;
      const im = c.imag;
      for (let s = 1; s < im.length; s++) im[s] = w * B[s]!;
      const st = lu.factor();
      if (st === LU_SINGULAR) {
        const who = c.unknownName(lu.failCol);
        throw new SimError(`Singular AC matrix at ${f} Hz at ${who}`, "singular");
      }
      if (st === LU_NONFINITE) throw new SimError(`Non-finite AC matrix at ${f} Hz`, "convergence");
      lu.solveComplex(c.acRe, c.acIm, xr, xi);
      col.push(f, xr, xi);
      this.steps++;
      this.progress((k + 1) / freqs.length);
    }
    col.finish();
    const axis: SimVector = { name: "frequency", unit: "Hz", re: col.axisValues() };
    return this.result("ac", col.vectors(), axis, start);
  }

  /** Stamp G + j*w*B at the operating point, with G and B fixed, and return a copy of B (w = 1). */
  private stampSmallSignal(withGmin: boolean): Float64Array {
    const c = this.c;
    c.vals.fill(0);
    c.imag.fill(0);
    c.acRe.fill(0);
    c.acIm.fill(0);
    const devices = c.devices;
    for (let i = 0; i < devices.length; i++) devices[i]!.loadAc(c);
    c.acRe[0] = 0;
    c.acIm[0] = 0;
    if (withGmin) {
      const g = c.gmin;
      for (let i = 0; i < c.gminSlots.length; i++) c.vals[c.gminSlots[i]!]! += g;
    }
    return new Float64Array(c.imag);
  }

  /** Coefficients that read an output: "v(a)", "v(a,b)" or "i(vname)". */
  private readOutput(spec: string): { plus: number; minus: number; isCurrent: boolean; label: string } {
    const c = this.c;
    const text = spec.trim().toLowerCase();
    const m = /^([vi])\s*\(\s*([^,()\s]+)\s*(?:,\s*([^,()\s]+)\s*)?\)$/.exec(text);
    if (!m) throw new SimError(`Output '${spec}' should look like v(out), v(a,b) or i(v1)`, "parse");
    if (m[1] === "i") {
      const d = c.named.get(m[2]!);
      if (!d || d.branch <= 0) throw new SimError(`Output '${spec}' is not the current of a voltage source or inductor`, "parse");
      return { plus: d.branch, minus: 0, isCurrent: true, label: text };
    }
    const plus = c.findNode(m[2]!);
    const minus = m[3] === undefined ? 0 : c.findNode(m[3]);
    if (plus < 0 || minus < 0) throw new SimError(`Output '${spec}' names a node that is not in the circuit`, "parse");
    return { plus, minus, isCurrent: false, label: text };
  }

  private independentSource(name: string): VoltageSource | CurrentSource {
    const d = this.c.named.get(name.trim().toLowerCase());
    if (d instanceof VoltageSource || d instanceof CurrentSource) return d;
    throw new SimError(`'${name}' is not an independent source in this circuit`, "parse");
  }

  /** Solve the operating point and factor its Jacobian for DC adjoint work. */
  private factorAtOp(context: string): void {
    this.solveOp(context);
    const st = this.lu.factor();
    if (st === LU_SINGULAR) this.throwSingular(context);
    if (st !== LU_OK) throw new SimError(`${context}: the operating point matrix is not finite`, "convergence");
  }

  noise(req: Extract<AnalysisRequest, { type: "noise" }>, start: number): SimResult {
    const c = this.c;
    const freqs = this.frequencies(req);
    const output = this.readOutput(req.output);
    const source = this.independentSource(req.source);
    for (const d of c.devices) {
      if (d instanceof Switch || d instanceof SmoothSwitch) d.tempK = c.temp + 273.15;
    }
    const axisOf = (values: Float64Array): SimVector => ({ name: "frequency", unit: "Hz", re: values });
    if (!this.stoppable(() => this.solveOp("Noise operating point"))) {
      return this.result("noise", [], axisOf(new Float64Array(0)), start);
    }
    const B = this.stampSmallSignal(true);
    const lu = new SparseLU(c.mat, true);
    const size = c.n + 1;
    const eRe = new Float64Array(size);
    const eIm = new Float64Array(size);
    if (output.plus > 0) eRe[output.plus] = 1;
    if (output.minus > 0) eRe[output.minus] = -1;
    const zr = new Float64Array(size);
    const zi = new Float64Array(size);

    const nf = freqs.length;
    const onoise = new Float64Array(nf);
    const inoise = new Float64Array(nf);
    const perDevice = new Map<string, Float64Array>();
    let row: Float64Array | null = null;
    let rowName = "";
    let psdTotal = 0;
    const sink = (device: string, a: number, b: number, psd: number): void => {
      if (device !== rowName) {
        rowName = device;
        row = perDevice.get(device) ?? null;
        if (!row) {
          row = new Float64Array(nf);
          perDevice.set(device, row);
        }
      }
      const dr = zr[a]! - zr[b]!;
      const di = zi[a]! - zi[b]!;
      const out = psd * (dr * dr + di * di);
      psdTotal += out;
      row![currentPoint]! += out;
    };
    let currentPoint = 0;
    let done = 0;
    for (let k = 0; k < nf; k++) {
      if (this.stop()) {
        c.warn("Stopped before the noise sweep finished; results are partial");
        break;
      }
      const f = freqs[k]!;
      const w = 2 * Math.PI * f;
      const im = c.imag;
      for (let s = 1; s < im.length; s++) im[s] = w * B[s]!;
      const st = lu.factor();
      if (st === LU_SINGULAR) throw new SimError(`Singular noise matrix at ${f} Hz at ${c.unknownName(lu.failCol)}`, "singular");
      if (st !== LU_OK) throw new SimError(`Non-finite noise matrix at ${f} Hz`, "convergence");
      lu.solveTransposeComplex(eRe, eIm, zr, zi);
      zr[0] = 0;
      zi[0] = 0;
      currentPoint = k;
      psdTotal = 0;
      const devices = c.devices;
      for (let i = 0; i < devices.length; i++) devices[i]!.noise(f, sink);
      onoise[k] = psdTotal;
      // Gain from the source by the same adjoint: its stimulus enters the right-hand side.
      let hr: number;
      let hi: number;
      if (source instanceof VoltageSource) {
        hr = zr[source.branch]!;
        hi = zi[source.branch]!;
      } else {
        const [sa, sb] = source.nodes;
        hr = zr[sb]! - zr[sa]!;
        hi = zi[sb]! - zi[sa]!;
      }
      const gain2 = hr * hr + hi * hi;
      inoise[k] = gain2 > 0 ? psdTotal / gain2 : Infinity;
      this.work += lu.fillNonzeros + size;
      this.steps++;
      done = k + 1;
      this.progress((k + 1) / nf);
    }

    const axis = freqs.slice(0, done);
    const contributions: { device: string; rms: number }[] = [];
    const vectors: SimVector[] = [
      { name: "onoise", unit: "", re: rootOf(onoise, done) },
      { name: "inoise", unit: "", re: rootOf(inoise, done) },
    ];
    for (const [device, psd] of perDevice) {
      vectors.push({ name: `onoise(${device})`, unit: "", re: rootOf(psd, done) });
      contributions.push({ device, rms: Math.sqrt(integrateDensity(axis, psd)) });
    }
    contributions.sort((p, q) => q.rms - p.rms);
    const res = this.result("noise", vectors, axisOf(axis), start);
    res.noise = {
      onoiseRms: Math.sqrt(integrateDensity(axis, onoise)),
      inoiseRms: Math.sqrt(integrateDensity(axis, inoise)),
      contributions,
    };
    return res;
  }

  transfer(req: Extract<AnalysisRequest, { type: "transfer" }>, start: number): SimResult {
    const c = this.c;
    const output = this.readOutput(req.output);
    const source = this.independentSource(req.source);
    if (!this.stoppable(() => this.factorAtOp("Transfer function operating point"))) {
      return this.result("transfer", [], undefined, start);
    }
    const size = c.n + 1;
    const b = new Float64Array(size);
    const x = new Float64Array(size);
    let inputR: number;
    if (source instanceof VoltageSource) {
      b[source.branch] = 1;
      this.lu.solve(b, x);
      x[0] = 0;
      // One volt drives -x[branch] amperes out of the source's positive terminal.
      inputR = x[source.branch] === 0 ? Infinity : -1 / x[source.branch]!;
    } else {
      const [sa, sb] = source.nodes;
      b[sa] = -1;
      b[sb] = 1;
      b[0] = 0;
      this.lu.solve(b, x);
      x[0] = 0;
      inputR = x[sb]! - x[sa]!;
    }
    const gain = x[output.plus]! - x[output.minus]!;

    b.fill(0);
    let outputR: number;
    if (output.isCurrent) {
      // A one volt test source in series with the output branch gives its admittance.
      b[output.plus] = 1;
      this.lu.solve(b, x);
      outputR = x[output.plus] === 0 ? Infinity : -1 / x[output.plus]!;
    } else {
      if (output.plus > 0) b[output.plus] = 1;
      if (output.minus > 0) b[output.minus] = -1;
      this.lu.solve(b, x);
      x[0] = 0;
      outputR = x[output.plus]! - x[output.minus]!;
    }
    this.steps = 1;
    this.progress(1);
    const one = (name: string, value: number, unit: SimVector["unit"]): SimVector => ({ name, unit, re: new Float64Array([value]) });
    const res = this.result(
      "transfer",
      [one("transfer_function", gain, ""), one("input_resistance", inputR, ""), one("output_resistance", outputR, "")],
      undefined,
      start,
    );
    res.transfer = { gain, inputResistance: inputR, outputResistance: outputR };
    return res;
  }

  sensitivity(req: Extract<AnalysisRequest, { type: "sensitivity" }>, start: number): SimResult {
    const c = this.c;
    const output = this.readOutput(req.output);
    if (!this.stoppable(() => this.factorAtOp("Sensitivity operating point"))) {
      return this.result("sensitivity", [], undefined, start);
    }
    const size = c.n + 1;
    const e = new Float64Array(size);
    const z = new Float64Array(size);
    if (output.plus > 0) e[output.plus] = 1;
    if (output.minus > 0) e[output.minus] = -1;
    this.lu.solveTranspose(e, z);
    z[0] = 0;
    const x = c.x;
    const out = x[output.plus]! - x[output.minus]!;
    const rows: SensitivityRow[] = [];
    const add = (device: string, parameter: SensitivityRow["parameter"], value: number, absolute: number): void => {
      if (device.includes("#")) return;
      rows.push({ device, parameter, value, absolute, normalized: out !== 0 ? (value / out) * absolute : NaN });
    };
    for (const d of c.devices) {
      if (d instanceof Resistor) {
        const [a, b] = d.nodes;
        const r = d.resistance;
        add(d.name, "r", r, ((z[a]! - z[b]!) * (x[a]! - x[b]!)) / (r * r));
      } else if (d instanceof VoltageSource) {
        add(d.name, "v", dcSourceValue(d.spec), z[d.branch]!);
      } else if (d instanceof CurrentSource) {
        const [a, b] = d.nodes;
        add(d.name, "i", dcSourceValue(d.spec), z[b]! - z[a]!);
      }
    }
    this.steps = 1;
    this.progress(1);
    const vectors: SimVector[] = rows.map((row) => ({ name: `sens(${row.device})`, unit: "", re: new Float64Array([row.absolute]) }));
    const res = this.result("sensitivity", vectors, undefined, start);
    res.sensitivity = rows;
    return res;
  }

  polezero(req: Extract<AnalysisRequest, { type: "polezero" }>, start: number): SimResult {
    const c = this.c;
    if (c.n + 1 > MAX_POLEZERO_UNKNOWNS) {
      throw new SimError(
        `Pole-zero analysis is limited to ${MAX_POLEZERO_UNKNOWNS - 1} unknowns because it uses dense eigenvalue methods; this circuit has ${c.n}`,
        "unsupported",
      );
    }
    const node = (name: string): number => {
      const id = c.findNode(name.trim().toLowerCase());
      if (id < 0) throw new SimError(`Pole-zero node '${name}' is not in the circuit`, "parse");
      return id;
    };
    const [inA, inB] = [node(req.input[0]), node(req.input[1])];
    const [outC, outD] = [node(req.output[0]), node(req.output[1])];
    if (!this.stoppable(() => this.solveOp("Pole-zero operating point"))) {
      return this.result("polezero", [], undefined, start);
    }
    const n = c.n;
    const collect = (withGmin: boolean): PencilEntry[] => {
      const C = this.stampSmallSignal(withGmin);
      const list: PencilEntry[] = [];
      const { slotRow, slotCol } = c.mat;
      for (let s = 1; s < slotRow.length; s++) {
        const g = c.vals[s]!;
        const cap = C[s]!;
        if (g !== 0 || cap !== 0) list.push({ row: slotRow[s]!, col: slotCol[s]!, g, c: cap });
      }
      return list;
    };

    // The stimulus: a voltage source across the input if there is one, otherwise a test current.
    const stimulus = new Map<number, number>();
    const driver = c.devices.find(
      (d) => d instanceof VoltageSource && !d.name.includes("#") && ((d.a === inA && d.b === inB) || (d.a === inB && d.b === inA)),
    ) as VoltageSource | undefined;
    if (driver) {
      stimulus.set(driver.branch - 1, 1);
    } else {
      if (inA > 0) stimulus.set(inA - 1, 1);
      if (inB > 0) stimulus.set(inB - 1, -1);
      c.warn("Pole-zero: no voltage source spans the input, so zeros are of output voltage per input current");
    }

    const eigen = (size: number, entries: PencilEntry[], what: string): Complex[] => {
      try {
        return pencilEigenvalues(size, entries);
      } catch (e) {
        if (e instanceof EigenFailure) throw new SimError(`Pole-zero: the eigenvalue iteration did not converge for the ${what}`, "convergence");
        throw e;
      }
    };
    const solveAll = (entries: PencilEntry[]): { poles: Complex[]; zeros: Complex[] } => {
      const poles = eigen(n, entries, "poles");
      // Zeros are the finite eigenvalues of the system bordered by the stimulus and output.
      const bordered = entries.slice();
      for (const [row, v] of stimulus) bordered.push({ row, col: n, g: v, c: 0 });
      if (outC > 0) bordered.push({ row: n, col: outC - 1, g: 1, c: 0 });
      if (outD > 0) bordered.push({ row: n, col: outD - 1, g: -1, c: 0 });
      let zeros: Complex[] = [];
      if (outC !== outD && stimulus.size > 0) {
        try {
          zeros = eigen(n + 1, bordered, "zeros");
        } catch (e) {
          if (!(e instanceof SingularPencil)) throw e;
          c.warn("Pole-zero: the output does not depend on the input, so there are no zeros to report");
        }
      }
      return { poles, zeros };
    };

    let found: { poles: Complex[]; zeros: Complex[] };
    try {
      found = solveAll(collect(false));
    } catch (e) {
      if (!(e instanceof SingularPencil)) throw e;
      // A node with neither conductance nor capacitance: GMIN gives it a harmless far-left pole.
      try {
        found = solveAll(collect(true));
      } catch (e2) {
        if (!(e2 instanceof SingularPencil)) throw e2;
        throw new SimError("Pole-zero: the circuit matrix is singular at every frequency", "singular");
      }
    }
    this.steps = 1;
    this.progress(1);
    const vec = (name: string, list: Complex[]): SimVector => ({
      name,
      unit: "",
      re: Float64Array.from(list, (s) => s.re),
      im: Float64Array.from(list, (s) => s.im),
    });
    return this.result("polezero", [vec("pole", found.poles), vec("zero", found.zeros)], undefined, start);
  }

  private nextBreak(t: number, eps: number): number {
    let best = Infinity;
    const devs = this.c.devices;
    for (let i = 0; i < devs.length; i++) {
      const b = devs[i]!.nextBreak(t, eps);
      if (b < best) best = b;
    }
    return best;
  }

  /**
   * A node that floats behind very large conductances leaves rounding noise in the starting
   * solution, which the first implicit step can amplify into divergence. A transient needs a
   * defined path for such a node, so it re-solves with a small shunt on every node and keeps it.
   */
  private anchorFloatingNodes(): void {
    if (!this.sawFloating || this.gshunt !== 0) return;
    const c = this.c;
    this.gshunt = RESCUE_GSHUNT;
    c.warn(`Floating nodes were found at the start of the transient; it runs with ${RESCUE_GSHUNT} S from every node to ground`);
    this.solveDc(true, "Transient operating point");
    this.settleAtSolution();
  }

  private initialiseTran(uic: boolean): void {
    const c = this.c;
    c.tranSources = true;
    c.t = 0;
    if (uic) {
      c.mode = MODE_UIC;
      c.ag0 = 0;
      c.trapF = 0;
      this.clamps = c.ics;
      this.resetX();
      if (c.digital) c.digital.settle(c);
      const ok = this.newton(c.itl1, false);
      this.clamps = [];
      if (!ok) {
        if (this.lastSingular) this.throwSingular("the initial condition solve");
        c.warn("The initial condition solve did not converge; starting from .ic values and zeros");
        c.x.fill(0);
        for (const ic of c.ics) c.x[ic.node] = ic.value;
      }
      this.settleAtSolution();
    } else {
      this.clamps = c.ics;
      this.solveOp("Transient operating point");
      this.anchorFloatingNodes();
      this.clamps = [];
    }
    c.st1.set(c.st0);
    c.st2.set(c.st0);
  }

  private checkRequestWaves(tstep: number, tstop: number): void {
    const c = this.c;
    for (const d of c.devices) {
      if ((d instanceof VoltageSource || d instanceof CurrentSource) && d.spec.wave) d.spec.wave.setDefaults(tstep, tstop);
    }
  }

  /** The largest step that keeps every source's fastest waveform visible to error control. */
  private waveStepLimit(): number {
    let limit = Infinity;
    for (const d of this.c.devices) {
      if ((d instanceof VoltageSource || d instanceof CurrentSource) && d.spec.wave) limit = Math.min(limit, d.spec.wave.maxStep());
    }
    return limit;
  }

  /**
   * The largest step that can follow the circuit's own dynamics, from the poles at the starting
   * point: growth (right half plane) must be resolved or an oscillator never starts, and a
   * lightly damped mode must be resolved or integration quietly erases its ringing. Well damped
   * poles need no limit, because truncation error control sees them whenever they are excited.
   * The horizon is how far the run goes, so a guard can refuse a limit that costs too many steps.
   */
  private dynamicsStepLimit(horizon: number): { growth: number; ringing: number } {
    const c = this.c;
    const none = { growth: Infinity, ringing: Infinity };
    const passive = c.devices.every((d) => d instanceof Resistor || d instanceof Capacitor || d instanceof VoltageSource || d instanceof CurrentSource);
    if (passive) return none;
    if (c.n > MAX_DYNAMICS_UNKNOWNS) {
      c.warn(`Dynamics check skipped: ${c.n} unknowns is above its limit of ${MAX_DYNAMICS_UNKNOWNS}, so fast dynamics may not be resolved unless tmax is small enough`);
      return none;
    }
    const C = this.stampSmallSignal(true);
    const entries: PencilEntry[] = [];
    const { slotRow, slotCol } = c.mat;
    for (let s = 1; s < slotRow.length; s++) {
      if (c.vals[s] !== 0 || C[s] !== 0) entries.push({ row: slotRow[s]!, col: slotCol[s]!, g: c.vals[s]!, c: C[s]! });
    }
    const growth = (s: Complex): boolean => s.re > 1e-9 * Math.hypot(s.re, s.im) && s.re * horizon > 0.1;
    const ringing = (s: Complex): boolean => s.re <= 0 && Math.abs(s.im) >= LIGHTLY_DAMPED_Q * 2 * Math.abs(s.re) && Math.abs(s.im) > 0;
    let poles: Complex[];
    try {
      poles = pencilEigenvalues(c.n, entries, (s) => growth(s) || ringing(s));
    } catch (e) {
      if (e instanceof SingularPencil || e instanceof EigenFailure) {
        c.warn("Dynamics check could not analyse the circuit at its starting point, so fast dynamics may not be resolved unless tmax is small enough");
        return none;
      }
      throw e;
    }
    let growthLimit = Infinity;
    let ringingLimit = Infinity;
    const refuse = (needed: number, hz: number, kind: string): void => {
      c.warn(
        `${kind} near ${formatHz(hz)} needs steps of ${needed.toExponential(2)} s, which would cost more than the step guard allows over this run, so it may not be resolved`,
      );
    };
    for (const s of poles) {
      const hz = Math.abs(s.im) / (2 * Math.PI);
      if (growth(s)) {
        const needed = s.im !== 0 ? Math.min(2 * Math.PI / (STEPS_PER_CYCLE * Math.abs(s.im)), 0.25 / s.re) : 0.25 / s.re;
        // A step limit above the mode's needs would cost steps without resolving it, so a mode
        // that is too fast to afford gets a warning and no limit at all.
        if (horizon / needed > MAX_GROWTH_STEPS) {
          refuse(needed, hz, "An unstable mode");
        } else {
          growthLimit = Math.min(growthLimit, needed);
        }
      } else if (ringing(s)) {
        const needed = (2 * Math.PI) / (STEPS_PER_CYCLE * Math.abs(s.im));
        if (horizon / needed > MAX_RINGING_STEPS) refuse(needed, hz, "A lightly damped mode");
        else ringingLimit = Math.min(ringingLimit, needed);
      }
    }
    return { growth: growthLimit, ringing: ringingLimit };
  }

  private startRun(c: Circuit, opts: { tstart: number; tstop: number; tmaxRequested: number; epsBase: number; limited: boolean; horizon: number; col: Collector | null }): TranRun {
    let tCap = Math.min(opts.tmaxRequested, this.waveStepLimit());
    const dynamics = this.dynamicsStepLimit(opts.horizon);
    tCap = Math.min(tCap, dynamics.growth);
    // A fixed run pays for its ringing modes throughout. A live session only pays while they ring.
    const ringCap = opts.limited ? Infinity : dynamics.ringing;
    if (opts.limited) tCap = Math.min(tCap, dynamics.ringing);
    c.mode = MODE_TRAN;
    const n = c.n;
    const lteMask = new Uint8Array(n + 1);
    for (let i = 1; i <= n; i++) if (c.isNode[i] && !c.digitalNodes.has(i)) lteMask[i] = 1;
    for (const d of c.devices) if (d instanceof Inductor) lteMask[d.branch] = 2;
    const run: TranRun = {
      t: 0, t1: 0, t2: 0, order: 1, nHist: 1, beHold: 0, h: 0, hLast: -1, orderLast: -1, eventRetries: 0, rejected: false,
      softBp: Infinity, nextBp: Infinity, x1: new Float64Array(0), x2: new Float64Array(0), x3: new Float64Array(0),
      peak: new Float64Array(n + 1), lteMask, tmax: tCap, tCap, hLteFloor: Math.min(tCap, ringCap) * 1e-4,
      requested: opts.tmaxRequested, ringCap, ringing: false, quietSteps: 0,
      tstart: opts.tstart, tstop: opts.tstop, epsBase: opts.epsBase, closeTo: opts.limited ? opts.epsBase : 0,
      limited: opts.limited, span: opts.tstop, lastProgress: 0,
    };
    if (c.digital) {
      c.digital.arm(c);
      if (c.digital.process(c, 0, opts.epsBase) && opts.tstart === 0 && opts.col) opts.col.push(1e-21, c.x);
      run.softBp = c.digital.softBreak(0, opts.epsBase);
    }
    run.x1 = new Float64Array(c.x);
    run.x2 = new Float64Array(c.x);
    run.x3 = new Float64Array(c.x);
    run.nextBp = this.runBreak(run, 0, opts.epsBase);
    run.h = Math.min(0.01 * tCap, 0.1 * run.nextBp);
    return run;
  }

  private runBreak(run: TranRun, from: number, eps: number): number {
    let b = this.nextBreak(from, eps);
    if (run.tstart > from + eps && run.tstart < b) b = run.tstart;
    return Math.min(b, run.tstop);
  }

  tran(req: Extract<AnalysisRequest, { type: "tran" }>, start: number): SimResult {
    const c = this.c;
    const { tstep, tstop } = req;
    const tstart = req.tstart ?? 0;
    if (!(tstep > 0) || !(tstop > 0) || !Number.isFinite(tstep) || !Number.isFinite(tstop)) {
      throw new SimError("Transient needs finite tstep and tstop above zero", "parse");
    }
    if (!(tstart >= 0) || !(tstart < tstop)) throw new SimError("Transient tstart must be within 0..tstop", "parse");
    const tmaxGiven = req.tmax !== undefined && req.tmax > 0 ? req.tmax : Math.min(tstep, tstop / 50);
    this.checkRequestWaves(tstep, tstop);
    const minimumSteps = tstop / tmaxGiven;
    if (!(minimumSteps <= ABSURD_TRAN_STEPS)) {
      throw new SimError(`Transient would take at least ${minimumSteps.toExponential(2)} steps; the limit is ${this.stepLimit}. Raise tstep or tmax, or shorten tstop`, "unsupported");
    }
    for (const d of c.devices) {
      if ((d instanceof VoltageSource || d instanceof CurrentSource) && d.spec.wave) {
        const corners = d.spec.wave.corners(tstop);
        if (corners > ABSURD_TRAN_STEPS / 1e4) {
          throw new SimError(`Source '${d.name}' has ${corners.toExponential(2)} waveform corners before tstop; the limit is ${ABSURD_TRAN_STEPS / 1e4}`, "unsupported");
        }
      }
    }

    // Stepping over a source that it can't follow would give numbers with no meaning, so a run too
    // long to follow it is refused. Anything shorter is resolved, and only what's stored is thinned.
    const sourceSteps = tstop / this.waveStepLimit();
    if (sourceSteps > this.stepLimit) {
      throw new SimError(`At this stop time, following the fastest source would take ${sourceSteps.toExponential(1)} steps, and a transient may take ${this.stepLimit}. Shorten the stop time to at most ${(tstop * this.stepLimit / sourceSteps).toPrecision(2)} s`, "unsupported");
    }

    if (!this.stoppable(() => this.initialiseTran(req.uic === true))) {
      const empty = new Collector(this.specs, 1, false);
      return this.result("tran", empty.vectors(), { name: "time", unit: "s", re: empty.axisValues() }, start);
    }
    const expected = Math.min(4096, Math.ceil((tstop - tstart) / tmaxGiven) + 16);
    const col = new Collector(this.specs, expected, false);
    if (tstart === 0) col.push(0, c.x);
    const run = this.startRun(c, {
      tstart, tstop, tmaxRequested: Math.min(tstep, tmaxGiven), epsBase: tstop * 1e-13, limited: true, horizon: tstop, col,
    });
    // Stepping may use tmax itself when it is above tstep, so keep the caller's upper bound.
    if (tmaxGiven > tstep && run.tCap === tstep) run.tmax = tmaxGiven;
    this.integrate(run, tstop, Infinity, col);
    col.finish();
    if (col.decimated) {
      c.warn(`The run produced more points than memory allows; stored waveforms were thinned to ${col.count} points`);
    }
    this.progress(1);
    const axis: SimVector = { name: "time", unit: "s", re: col.axisValues() };
    return this.result("tran", col.vectors(), axis, start);
  }

  /** Vector names in collector order, for a live session. */
  outputNames(): string[] {
    return this.specs.map((s) => s.name);
  }

  /** Solve the start of a live session and prepare to integrate from it. */
  startLive(tmax: number | undefined, uic: boolean): TranRun {
    const c = this.c;
    const requested = tmax !== undefined && tmax > 0 ? tmax : LIVE_DEFAULT_TMAX;
    if (!Number.isFinite(requested)) throw new SimError("Live session tmax must be finite", "parse");
    // There is no stop time: a PULSE or SIN default that depends on one becomes "very long".
    this.checkRequestWaves(requested, LIVE_HORIZON);
    this.initialiseTran(uic);
    const run = this.startRun(c, {
      tstart: 0, tstop: Infinity, tmaxRequested: requested, epsBase: requested * 1e-10, limited: false, horizon: LIVE_HORIZON_FOR_GUARD, col: null,
    });
    // A uic start is a jump, so anything lightly damped may ring from it.
    run.ringing = uic && run.ringCap < Infinity;
    return run;
  }

  /** Take one chunk of a live session. Work limits apply per chunk, because a session has no end. */
  liveChunk(run: TranRun, first: boolean, until: number, budgetMs: number): Collector {
    const c = this.c;
    this.work = 0;
    const col = new Collector(this.specs, 256, false);
    if (first) col.push(0, c.x);
    const deadline = now() + Math.max(0, budgetMs);
    this.integrate(run, until, deadline, col);
    return col;
  }

  liveTime(run: TranRun): number {
    return run.t;
  }

  /**
   * Continue a live session in this circuit, which has the same structure as old and new values.
   * Everything stored moves across; reactive elements then re-seed from the present voltages and
   * currents, so a capacitor keeps its voltage when its value changes and an inductor its current.
   * Integration restarts at the present time, which handles the jump the change may cause.
   */
  resumeFrom(old: Analysis, run: TranRun): void {
    const c = this.c;
    const o = old.c;
    c.x.set(o.x);
    c.xNew.set(o.xNew);
    c.st0.set(o.st0);
    c.st1.set(o.st1);
    c.st2.set(o.st2);
    c.t = o.t;
    c.tranSources = true;
    c.ag0 = 0;
    c.trapF = 0;
    this.gshunt = old.gshunt;
    this.sawFloating = old.sawFloating;
    this.checkRequestWaves(run.requested, LIVE_HORIZON);
    for (let i = 0; i < c.devices.length; i++) c.devices[i]!.copyState(o.devices[i]!);
    if (c.digital) c.digital.copyStateFrom(o.digital!);
    const t = run.t;
    if (c.digital) c.digital.resume(c, t);

    c.mode = MODE_DC;
    c.reseeding = true;
    this.settleAtSolution();
    c.reseeding = false;
    c.st1.set(c.st0);
    c.st2.set(c.st0);

    const wave = this.waveStepLimit();
    const dynamics = this.dynamicsStepLimit(LIVE_HORIZON_FOR_GUARD);
    c.mode = MODE_TRAN;
    if (c.digital) {
      c.digital.process(c, t, Math.max(run.epsBase, t * 1e-13));
      run.softBp = c.digital.softBreak(t, Math.max(run.epsBase, t * 1e-13));
    }

    const tCap = Math.min(run.requested, wave, dynamics.growth);
    run.tmax = tCap;
    run.tCap = tCap;
    run.ringCap = dynamics.ringing;
    run.hLteFloor = Math.min(tCap, dynamics.ringing) * 1e-4;
    run.ringing = dynamics.ringing < Infinity;
    run.quietSteps = 0;
    run.x1.set(c.x);
    run.x2.set(c.x);
    run.x3.set(c.x);
    run.t1 = t;
    run.t2 = t;
    run.order = 1;
    run.nHist = 1;
    run.beHold = 0;
    run.hLast = -1;
    run.orderLast = -1;
    run.eventRetries = 0;
    run.rejected = false;
    const eps = Math.max(run.epsBase, t * 1e-13);
    run.nextBp = this.runBreak(run, t, eps);
    run.h = Math.max(Math.min(0.01 * tCap, 0.1 * (run.nextBp - t)), 2 * (eps / 10));
  }

  /** Integrate until simulated time reaches until or the deadline passes. All state lives in run. */
  private integrate(run: TranRun, until: number, deadline: number, col: Collector): void {
    const c = this.c;
    const n = c.n;
    const digital = c.digital;
    const { lteMask, peak, tCap, hLteFloor } = run;
    let { t, t1, t2, order, nHist, beHold, h, hLast, orderLast, eventRetries, rejected, softBp, nextBp, x1, x2, x3 } = run;
    const firstBreak = (from: number, e: number): number => this.runBreak(run, from, e);

    let attempts = 0;
    let accepted = 0;
    while (t < until - run.closeTo) {
      if (this.stop()) {
        c.warn(`Stopped at t = ${t}; results are partial`);
        break;
      }
      // The budget is read between steps. A call always makes progress unless it is stuck in retries.
      if ((accepted > 0 || ++attempts > 256) && deadline < Infinity && now() > deadline) break;
      const eps = Math.max(run.epsBase, t * 1e-13);
      const hmin = eps / 10;
      // Fit the step to tmax and the next breakpoint.
      const tmax = run.ringing ? Math.min(run.tmax, run.ringCap) : run.tmax;
      let hTry = Math.min(h, tmax);
      const target = Math.min(nextBp, softBp);
      const rem = target - t;
      let hit = false;
      // Stretching a step onto a break point is skipped on a retry, or the same step would repeat.
      if (rem <= hTry * (rejected ? 1 : 1.25)) {
        if (rem <= tmax) {
          hTry = rem;
          hit = true;
        } else {
          hTry = rem / 2;
        }
      }
      if (hTry < hmin) {
        throw new SimError(
          `Transient timestep too small (${hTry.toExponential(3)} s) at t = ${t.toExponential(6)} s near ${c.unknownName(this.worst)}`,
          "convergence",
        );
      }

      const tNew = hit ? target : t + hTry;
      c.ag0 = order === 1 ? 1 / hTry : 2 / hTry;
      c.trapF = order === 1 ? 0 : 1;
      c.t = tNew;
      c.x.set(x1);
      this.reuseFactor = this.linear && hTry === hLast && order === orderLast;
      const ok = this.newton(c.itl4, false);
      this.reuseFactor = false;
      if (!ok) {
        if (this.lastSingular && this.linear) this.throwSingular(`transient at t = ${tNew}`);
        hLast = -1;
        h = hTry / 8;
        order = 1;
        beHold = 3;
        if (h < hmin) {
          if (this.lastSingular) this.throwSingular(`transient at t = ${tNew}`);
          throw new SimError(
            `Transient did not converge at t = ${t.toExponential(6)} s (timestep ${h.toExponential(3)} s) near ${c.unknownName(this.worst)}`,
            "convergence",
          );
        }
        continue;
      }
      hLast = hTry;
      orderLast = order;

      // Local truncation error from divided differences over the solution history.
      const x0 = c.x;
      let ratio = 0;
      let checked = false;
      const h1 = hTry;
      const h2 = t - t1;
      const h3 = t1 - t2;
      const rel = 0.25 * c.reltol;
      const absV = c.vntol;
      const absI = Math.max(c.abstol, 1e-9);
      if (order === 2 && nHist >= 3 && h2 > 0 && h3 > 0) {
        checked = true;
        const a = 1 / h1;
        const b = 1 / h2;
        const d = 1 / h3;
        const s12 = 1 / (h1 + h2);
        const s23 = 1 / (h2 + h3);
        const s123 = 1 / (h1 + h2 + h3);
        const coef = 0.5 * h1 * h1 * h1 * s123;
        for (let i = 1; i <= n; i++) {
          const mask = lteMask[i]!;
          if (mask === 0) continue;
          const v0 = x0[i]!;
          const v1 = x1[i]!;
          const v2 = x2[i]!;
          const v3 = x3[i]!;
          const d01 = (v0 - v1) * a;
          const d12 = (v1 - v2) * b;
          const d23 = (v2 - v3) * d;
          const dd = (d01 - d12) * s12 - (d12 - d23) * s23;
          const lte = coef * (dd < 0 ? -dd : dd);
          const av = v0 < 0 ? -v0 : v0;
          if (av > peak[i]!) peak[i] = av;
          const tol = rel * peak[i]! + (mask === 1 ? absV : absI);
          const r = lte / tol;
          if (r > ratio) ratio = r;
        }
      } else if (order === 1 && nHist >= 2 && h2 > 0) {
        checked = true;
        const s12 = 1 / (h1 + h2);
        const coef = h1 * h1 * s12;
        for (let i = 1; i <= n; i++) {
          const mask = lteMask[i]!;
          if (mask === 0) continue;
          const v0 = x0[i]!;
          const d01 = (v0 - x1[i]!) / h1;
          const d12 = (x1[i]! - x2[i]!) / h2;
          const dd = d01 - d12;
          const lte = coef * (dd < 0 ? -dd : dd);
          const av = v0 < 0 ? -v0 : v0;
          if (av > peak[i]!) peak[i] = av;
          const tol = rel * peak[i]! + (mask === 1 ? absV : absI);
          const r = lte / tol;
          if (r > ratio) ratio = r;
        }
      }
      const p = order + 1;
      let factor = 2;
      if (checked && ratio > 0) factor = 0.9 * Math.pow(ratio, -1 / p);

      let discontinuity = false;
      if (checked && ratio > 1) {
        if (hTry > hLteFloor) {
          h = hTry * Math.max(0.25, Math.min(factor, 0.9));
          rejected = true;
          continue;
        }
        // Accepting a step this small means a jump the waveform corners did not announce.
        discontinuity = true;
      }

      // Move the step onto a state change inside it, so its time is located and not rounded.
      if (this.eventList.length > 0 && hTry > hLteFloor && eventRetries < 8) {
        let tEv = Infinity;
        for (let i = 0; i < this.eventList.length; i++) {
          const e = this.eventList[i]!.checkEvent(c, x1, t, tNew);
          if (e < tEv) tEv = e;
        }
        if (tEv < tNew - hLteFloor) {
          h = Math.max(tEv - t + 0.5 * hLteFloor, 2 * hmin);
          eventRetries++;
          rejected = true;
          continue;
        }
      }
      eventRetries = 0;
      rejected = false;

      // Accept.
      c.discontinuity = false;
      for (let i = 0; i < this.acceptList.length; i++) this.acceptList[i]!.accept(c);
      if (c.discontinuity) discontinuity = true;
      const stOld = c.st2;
      c.st2 = c.st1;
      c.st1 = c.st0;
      c.st0 = stOld;
      const xOld = x3;
      x3 = x2;
      x2 = x1;
      x1 = xOld;
      x1.set(c.x);
      t2 = t1;
      t1 = t;
      t = tNew;
      this.steps++;
      accepted++;
      if (run.limited && (this.steps >= this.stepLimit || this.work > WORK_STOP)) {
        // Keep what was computed. A stored 5000 s run at 100 us is really "run until stopped".
        c.warn(
          `The run stopped at t = ${t.toExponential(3)} s of ${run.tstop.toExponential(3)} s after ${this.steps} steps, the most one transient may take, so results are partial. Raise tmax or shorten tstop to cover the whole run, or use a live session`,
        );
        if (t >= run.tstart - eps) col.push(t, c.x);
        break;
      }
      if (t >= run.tstart - eps) col.push(t, c.x);
      if (digital) {
        // A second sample just after the event keeps digital edges square in the waveform.
        c.discontinuity = false;
        this.work += digital.takeEvents();
        if (digital.process(c, t, eps)) {
          x1.set(c.x);
          if (t >= run.tstart - eps) col.push(t + Math.max(4e-16 * t, 1e-21), c.x);
        }
        if (c.discontinuity) discontinuity = true;
        softBp = digital.softBreak(t, eps);
      }
      if (!checked) {
        for (let i = 1; i <= n; i++) {
          const a = Math.abs(c.x[i]!);
          if (a > peak[i]!) peak[i] = a;
        }
      }

      if (run.limited) {
        const fraction = t / run.span;
        if (fraction - run.lastProgress >= 0.01) {
          run.lastProgress = fraction;
          this.progress(Math.min(1, fraction));
        }
      }

      // A lightly damped mode gets its small steps only while it is measurably ringing: truncation
      // error at that step size stands well above nothing for a mode that any corner has excited.
      if (run.ringing && checked && hTry >= 0.5 * run.ringCap) {
        run.quietSteps = ratio < RINGING_RATIO ? run.quietSteps + 1 : 0;
        if (run.quietSteps >= 2 * STEPS_PER_CYCLE) run.ringing = false;
      }
      const softOnly = hit && target !== nextBp && !discontinuity;
      if (softOnly) {
        // Purely digital event: the analog waveform is unaffected, so keep the integration going.
        if (hTry < 0.25 * h) nHist = Math.min(nHist, 2);
        else nHist++;
        hLast = -1;
        order = beHold > 0 ? 1 : nHist >= 2 ? 2 : 1;
      } else if (hit || discontinuity) {
        if (run.ringCap < Infinity) {
          run.ringing = true;
          run.quietSteps = 0;
        }
        nextBp = firstBreak(t, eps);
        const gap = nextBp - t;
        const basis = hit ? Math.min(h, hTry * 16) : tCap;
        h = Math.min(0.1 * basis, 0.01 * tCap, 0.1 * gap);
        if (discontinuity) h = Math.max(h, hLteFloor);
        h = Math.max(h, 2 * hmin);
        order = 1;
        nHist = 1;
        hLast = -1;
      } else {
        if (factor >= 1 && factor < 1.2) h = hTry;
        else h = hTry * Math.min(factor, 2);
        nHist++;
        if (beHold > 0) {
          beHold--;
          order = 1;
        } else {
          order = 2;
        }
      }
    }
    run.t = t;
    run.t1 = t1;
    run.t2 = t2;
    run.order = order;
    run.nHist = nHist;
    run.beHold = beHold;
    run.h = h;
    run.hLast = hLast;
    run.orderLast = orderLast;
    run.eventRetries = eventRetries;
    run.rejected = rejected;
    run.softBp = softBp;
    run.nextBp = nextBp;
    run.x1 = x1;
    run.x2 = x2;
    run.x3 = x3;
  }
}

function formatHz(hz: number): string {
  return hz > 0 ? `${hz.toPrecision(3)} Hz` : "zero frequency";
}

function rootOf(a: Float64Array, count: number): Float64Array {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.sqrt(a[i]!);
  return out;
}

/** Integrate a density over frequency, as a power law between points so that few points suffice. */
function integrateDensity(f: Float64Array, s: Float64Array): number {
  let total = 0;
  for (let i = 1; i < f.length; i++) {
    const f0 = f[i - 1]!;
    const f1 = f[i]!;
    const s0 = s[i - 1]!;
    const s1 = s[i]!;
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) continue;
    if (s0 > 0 && s1 > 0 && f0 > 0) {
      const n = Math.log(s1 / s0) / Math.log(f1 / f0);
      if (Math.abs(n + 1) < 1e-6) total += s0 * f0 * Math.log(f1 / f0);
      else total += (s0 * f0 * (Math.pow(f1 / f0, n + 1) - 1)) / (n + 1);
    } else {
      total += 0.5 * (s0 + s1) * (f1 - f0);
    }
  }
  return total;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function currentTime(): number {
  return now();
}
