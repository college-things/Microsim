// Linear elements, sources, controlled sources, switch and behavioural source.
// Sign conventions: MNA with KCL rows as "sum of currents leaving the node = rhs".

import { BOLTZMANN, Circuit, Device, G_CLAMP, MODE_TRAN, MODE_UIC, R_INDUCTOR_DC, type NoiseSink } from "./circuit";
import { compile, diff, Tape, type Ast, type Evaluator } from "./expr";
import type { Waveform } from "./waveforms";

/** Four slots for a conductance-like element between two nodes. */
export class Pair {
  aa = 0;
  ab = 0;
  ba = 0;
  bb = 0;

  setup(c: Circuit, a: number, b: number): void {
    this.aa = c.mat.slot(a, a);
    this.ab = c.mat.slot(a, b);
    this.ba = c.mat.slot(b, a);
    this.bb = c.mat.slot(b, b);
  }

  add(m: Float64Array, g: number): void {
    m[this.aa]! += g;
    m[this.bb]! += g;
    m[this.ab]! -= g;
    m[this.ba]! -= g;
  }
}

export class Resistor extends Device {
  private readonly p = new Pair();
  private readonly g: number;

  override retargetA(n: number): boolean {
    if (n < 0) return true;
    this.savedA = this.a;
    this.a = n;
    return true;
  }

  constructor(name: string, line: number, private a: number, private readonly b: number, r: number, private readonly tempK = 300.15) {
    super(name, line);
    this.g = 1 / r;
  }

  /** Terminals and resistance, for sensitivities. */
  get resistance(): number {
    return 1 / this.g;
  }

  get nodes(): [number, number] {
    return [this.a, this.b];
  }

  override noise(_f: number, sink: NoiseSink): void {
    sink(this.name, this.a, this.b, 4 * BOLTZMANN * this.tempK * Math.abs(this.g));
  }

  setup(c: Circuit): void {
    this.p.setup(c, this.a, this.b);
  }

  load(c: Circuit): void {
    this.p.add(c.vals, this.g);
  }

  loadAc(c: Circuit): void {
    this.p.add(c.vals, this.g);
  }
}

export class Capacitor extends Device {
  private readonly p = new Pair();
  private o = 0;
  private hist = 0;

  override retargetA(n: number): boolean {
    if (n < 0) return true;
    this.savedA = this.a;
    this.a = n;
    return true;
  }

  constructor(
    name: string,
    line: number,
    private a: number,
    private readonly b: number,
    private readonly cap: number,
    private readonly ic: number | undefined,
  ) {
    super(name, line);
    this.needsAccept = true;
  }

  setup(c: Circuit): void {
    this.p.setup(c, this.a, this.b);
    this.o = c.allocState(2);
  }

  load(c: Circuit): void {
    if (c.mode === MODE_TRAN) {
      const ag0 = c.ag0;
      const st1 = c.st1;
      const o = this.o;
      const hist = -ag0 * st1[o]! - c.trapF * st1[o + 1]!;
      this.hist = hist;
      this.p.add(c.vals, ag0 * this.cap);
      const rhs = c.rhs;
      rhs[this.a]! -= hist;
      rhs[this.b]! += hist;
    } else if (c.mode === MODE_UIC) {
      // Hold the capacitor voltage at t=0, unless a node .ic fixes it and no IC= was given.
      if (this.ic === undefined && (c.icNode(this.a) || c.icNode(this.b))) return;
      const v = this.ic ?? 0;
      this.p.add(c.vals, G_CLAMP);
      c.rhs[this.a]! += G_CLAMP * v;
      c.rhs[this.b]! -= G_CLAMP * v;
    }
  }

  loadAc(c: Circuit): void {
    this.p.add(c.imag, this.cap);
  }

  override accept(c: Circuit): void {
    const v = c.x[this.a]! - c.x[this.b]!;
    const o = this.o;
    if (c.mode === MODE_TRAN) {
      const q = this.cap * v;
      c.st0[o] = q;
      c.st0[o + 1] = c.ag0 * q + this.hist;
    } else {
      c.st0[o] = this.cap * (c.mode === MODE_UIC && this.ic !== undefined ? this.ic : v);
      c.st0[o + 1] = 0;
    }
  }
}

export class Inductor extends Device {
  private ka = 0;
  private kb = 0;
  private ra = 0;
  private rb = 0;
  private rr = 0;
  private o = 0;
  private hist = 0;
  /** Mutual couplings as [other inductor, M]. */
  readonly mutual: { other: Inductor; m: number }[] = [];

  constructor(
    name: string,
    line: number,
    private readonly a: number,
    private readonly b: number,
    readonly ind: number,
    private readonly ic: number | undefined,
  ) {
    super(name, line);
    this.needsAccept = true;
  }

  override allocate(c: Circuit): void {
    this.branch = c.branchUnknown(this.name);
  }

  setup(c: Circuit): void {
    const br = this.branch;
    this.ka = c.mat.slot(this.a, br);
    this.kb = c.mat.slot(this.b, br);
    this.ra = c.mat.slot(br, this.a);
    this.rb = c.mat.slot(br, this.b);
    this.rr = c.mat.slot(br, br);
    this.o = c.allocState(2);
  }

  load(c: Circuit): void {
    const m = c.vals;
    m[this.ka]! += 1;
    m[this.kb]! -= 1;
    if (c.mode === MODE_UIC) {
      m[this.rr]! += 1;
      c.rhs[this.branch] = this.ic ?? 0;
      return;
    }
    m[this.ra]! += 1;
    m[this.rb]! -= 1;
    if (c.mode === MODE_TRAN) {
      const ag0 = c.ag0;
      const o = this.o;
      const hist = -ag0 * c.st1[o]! - c.trapF * c.st1[o + 1]!;
      this.hist = hist;
      m[this.rr]! -= ag0 * this.ind;
      c.rhs[this.branch] = hist;
    } else {
      m[this.rr]! -= R_INDUCTOR_DC;
    }
  }

  loadAc(c: Circuit): void {
    const m = c.vals;
    m[this.ka]! += 1;
    m[this.kb]! -= 1;
    m[this.ra]! += 1;
    m[this.rb]! -= 1;
    c.imag[this.rr]! -= this.ind;
  }

  override accept(c: Circuit): void {
    let phi = this.ind * c.x[this.branch]!;
    for (let i = 0; i < this.mutual.length; i++) {
      const u = this.mutual[i]!;
      phi += u.m * c.x[u.other.branch]!;
    }
    const o = this.o;
    c.st0[o] = phi;
    c.st0[o + 1] = c.mode === MODE_TRAN ? c.ag0 * phi + this.hist : 0;
  }
}

export class MutualInductance extends Device {
  private s12 = 0;
  private s21 = 0;
  private m = 0;

  constructor(
    name: string,
    line: number,
    private readonly resolve: (c: Circuit) => { l1: Inductor; l2: Inductor },
    private readonly k: number,
  ) {
    super(name, line);
  }

  setup(c: Circuit): void {
    const { l1, l2 } = this.resolve(c);
    this.m = this.k * Math.sqrt(l1.ind * l2.ind);
    l1.mutual.push({ other: l2, m: this.m });
    l2.mutual.push({ other: l1, m: this.m });
    this.s12 = c.mat.slot(l1.branch, l2.branch);
    this.s21 = c.mat.slot(l2.branch, l1.branch);
  }

  load(c: Circuit): void {
    if (c.mode === MODE_TRAN) {
      const g = c.ag0 * this.m;
      c.vals[this.s12]! -= g;
      c.vals[this.s21]! -= g;
    }
  }

  loadAc(c: Circuit): void {
    c.imag[this.s12]! -= this.m;
    c.imag[this.s21]! -= this.m;
  }
}

/** Common evaluation for V and I sources. */
export interface SourceSpec {
  dc: number;
  hasDc: boolean;
  acMag: number;
  acPhase: number;
  wave: Waveform | null;
}

/** The value a source holds at a DC solution. */
export function dcSourceValue(s: SourceSpec): number {
  return s.hasDc || !s.wave ? s.dc : s.wave.at(0);
}

function sourceValue(c: Circuit, s: SourceSpec): number {
  let v: number;
  if (c.tranSources) v = s.wave ? s.wave.at(c.t) : s.dc;
  else if (s.hasDc || !s.wave) v = s.dc;
  else v = s.wave.at(0);
  return v * c.srcFactor;
}

export class VoltageSource extends Device {
  private ka = 0;
  private kb = 0;
  private ra = 0;
  private rb = 0;

  constructor(
    name: string,
    line: number,
    readonly a: number,
    readonly b: number,
    readonly spec: SourceSpec,
  ) {
    super(name, line);
  }

  override allocate(c: Circuit): void {
    this.branch = c.branchUnknown(this.name);
  }

  setup(c: Circuit): void {
    const br = this.branch;
    this.ka = c.mat.slot(this.a, br);
    this.kb = c.mat.slot(this.b, br);
    this.ra = c.mat.slot(br, this.a);
    this.rb = c.mat.slot(br, this.b);
  }

  private stamp(m: Float64Array): void {
    m[this.ka]! += 1;
    m[this.kb]! -= 1;
    m[this.ra]! += 1;
    m[this.rb]! -= 1;
  }

  load(c: Circuit): void {
    this.stamp(c.vals);
    c.rhs[this.branch] = sourceValue(c, this.spec);
  }

  loadAc(c: Circuit): void {
    this.stamp(c.vals);
    const ph = (this.spec.acPhase * Math.PI) / 180;
    c.acRe[this.branch] = this.spec.acMag * Math.cos(ph);
    c.acIm[this.branch] = this.spec.acMag * Math.sin(ph);
  }

  override nextBreak(t: number, eps: number): number {
    return this.spec.wave ? this.spec.wave.nextBreak(t, eps) : Infinity;
  }
}

export class CurrentSource extends Device {
  get nodes(): [number, number] {
    return [this.a, this.b];
  }

  override retargetA(n: number): boolean {
    if (n < 0) return true;
    this.savedA = this.a;
    this.a = n;
    return true;
  }

  constructor(
    name: string,
    line: number,
    private a: number,
    private readonly b: number,
    readonly spec: SourceSpec,
  ) {
    super(name, line);
  }

  setup(): void {}

  load(c: Circuit): void {
    const v = sourceValue(c, this.spec);
    c.rhs[this.a]! -= v;
    c.rhs[this.b]! += v;
  }

  loadAc(c: Circuit): void {
    const ph = (this.spec.acPhase * Math.PI) / 180;
    const re = this.spec.acMag * Math.cos(ph);
    const im = this.spec.acMag * Math.sin(ph);
    c.acRe[this.a]! -= re;
    c.acIm[this.a]! -= im;
    c.acRe[this.b]! += re;
    c.acIm[this.b]! += im;
  }

  override nextBreak(t: number, eps: number): number {
    return this.spec.wave ? this.spec.wave.nextBreak(t, eps) : Infinity;
  }
}

/** E: v(a,b) = gain * v(c,d). */
export class VCVS extends Device {
  private slots: number[] = [];

  constructor(
    name: string,
    line: number,
    private readonly a: number,
    private readonly b: number,
    private readonly cp: number,
    private readonly cn: number,
    private readonly gain: number,
  ) {
    super(name, line);
  }

  override allocate(c: Circuit): void {
    this.branch = c.branchUnknown(this.name);
  }

  setup(c: Circuit): void {
    const br = this.branch;
    this.slots = [
      c.mat.slot(this.a, br),
      c.mat.slot(this.b, br),
      c.mat.slot(br, this.a),
      c.mat.slot(br, this.b),
      c.mat.slot(br, this.cp),
      c.mat.slot(br, this.cn),
    ];
  }

  load(c: Circuit): void {
    const s = this.slots;
    const m = c.vals;
    m[s[0]!]! += 1;
    m[s[1]!]! -= 1;
    m[s[2]!]! += 1;
    m[s[3]!]! -= 1;
    m[s[4]!]! -= this.gain;
    m[s[5]!]! += this.gain;
  }

  loadAc(c: Circuit): void {
    this.load(c);
  }
}

/** G: current from a to b = gm * v(c,d). */
export class VCCS extends Device {
  private ac = 0;
  private ad = 0;
  private bc = 0;
  private bd = 0;

  override retargetA(n: number): boolean {
    if (n < 0) return true;
    this.savedA = this.a;
    this.a = n;
    return true;
  }

  constructor(
    name: string,
    line: number,
    private a: number,
    private readonly b: number,
    private readonly cp: number,
    private readonly cn: number,
    private readonly gm: number,
  ) {
    super(name, line);
  }

  setup(c: Circuit): void {
    this.ac = c.mat.slot(this.a, this.cp);
    this.ad = c.mat.slot(this.a, this.cn);
    this.bc = c.mat.slot(this.b, this.cp);
    this.bd = c.mat.slot(this.b, this.cn);
  }

  load(c: Circuit): void {
    const m = c.vals;
    m[this.ac]! += this.gm;
    m[this.ad]! -= this.gm;
    m[this.bc]! -= this.gm;
    m[this.bd]! += this.gm;
  }

  loadAc(c: Circuit): void {
    this.load(c);
  }
}

export type BranchResolver = (c: Circuit) => number;

/** F: current from a to b = gain * i(control). */
export class CCCS extends Device {
  private sa = 0;
  private sb = 0;

  override retargetA(n: number): boolean {
    if (n < 0) return true;
    this.savedA = this.a;
    this.a = n;
    return true;
  }

  constructor(
    name: string,
    line: number,
    private a: number,
    private readonly b: number,
    private readonly control: BranchResolver,
    private readonly gain: number,
  ) {
    super(name, line);
  }

  setup(c: Circuit): void {
    const br = this.control(c);
    this.sa = c.mat.slot(this.a, br);
    this.sb = c.mat.slot(this.b, br);
  }

  load(c: Circuit): void {
    c.vals[this.sa]! += this.gain;
    c.vals[this.sb]! -= this.gain;
  }

  loadAc(c: Circuit): void {
    this.load(c);
  }
}

/** H: v(a,b) = r * i(control). */
export class CCVS extends Device {
  private slots: number[] = [];

  constructor(
    name: string,
    line: number,
    private readonly a: number,
    private readonly b: number,
    private readonly control: BranchResolver,
    private readonly r: number,
  ) {
    super(name, line);
  }

  override allocate(c: Circuit): void {
    this.branch = c.branchUnknown(this.name);
  }

  setup(c: Circuit): void {
    const br = this.branch;
    this.slots = [
      c.mat.slot(this.a, br),
      c.mat.slot(this.b, br),
      c.mat.slot(br, this.a),
      c.mat.slot(br, this.b),
      c.mat.slot(br, this.control(c)),
    ];
  }

  load(c: Circuit): void {
    const s = this.slots;
    const m = c.vals;
    m[s[0]!]! += 1;
    m[s[1]!]! -= 1;
    m[s[2]!]! += 1;
    m[s[3]!]! -= 1;
    m[s[4]!]! -= this.r;
  }

  loadAc(c: Circuit): void {
    this.load(c);
  }
}

/** How a switch reads its control: a node pair, or a branch current for W. */
export type SwitchControl = { kind: "nodes"; cp: number; cn: number } | { kind: "branch"; resolve: BranchResolver };

export interface SwitchParams {
  vt: number;
  vh: number;
  ron: number;
  roff: number;
}

/**
 * Hysteretic switch (SPICE3 S and W). In transient the state is held during a step and flips on
 * accept at a located crossing, which keeps Newton smooth. DC iterates on the state instead,
 * freezing flips late in the solve to stop chatter.
 */
export class Switch extends Device {
  private readonly p = new Pair();
  private on: boolean;
  private acceptedOn: boolean;
  private cp = 0;
  private cn = 0;

  constructor(
    name: string,
    line: number,
    private a: number,
    private readonly b: number,
    private readonly control: SwitchControl,
    private readonly params: SwitchParams,
    initialOn: boolean,
  ) {
    super(name, line);
    this.linear = false;
    this.needsAccept = true;
    this.hasEvents = true;
    this.on = initialOn;
    this.acceptedOn = initialOn;
  }

  override retargetA(n: number): boolean {
    if (n < 0) return true;
    this.savedA = this.a;
    this.a = n;
    return true;
  }

  setup(c: Circuit): void {
    this.p.setup(c, this.a, this.b);
    if (this.control.kind === "nodes") {
      this.cp = this.control.cp;
      this.cn = this.control.cn;
    } else {
      this.cp = this.control.resolve(c);
      this.cn = 0;
    }
  }

  private want(v: number): boolean {
    const { vt, vh } = this.params;
    if (v > vt + vh) return true;
    if (v < vt - vh) return false;
    return this.acceptedOn;
  }

  private stamp(c: Circuit): void {
    this.p.add(c.vals, 1 / (this.on ? this.params.ron : this.params.roff));
  }

  load(c: Circuit): void {
    if (c.mode === MODE_TRAN) {
      this.on = this.acceptedOn;
    } else {
      const want = this.want(c.x[this.cp]! - c.x[this.cn]!);
      if (want !== this.on && c.iter < 20) {
        this.on = want;
        c.noncon++;
      }
    }
    this.stamp(c);
  }

  loadAc(c: Circuit): void {
    this.stamp(c);
  }

  override noise(_f: number, sink: NoiseSink): void {
    sink(this.name, this.a, this.b, (4 * BOLTZMANN * this.tempK) / (this.on ? this.params.ron : this.params.roff));
  }

  /** Temperature for thermal noise, set from the circuit. */
  tempK = 300.15;

  override copyState(old: Device): void {
    const o = old as Switch;
    this.on = o.on;
    this.acceptedOn = o.acceptedOn;
  }

  override checkEvent(c: Circuit, xPrev: Float64Array, t0: number, t1: number): number {
    const v1 = c.x[this.cp]! - c.x[this.cn]!;
    if (this.want(v1) === this.acceptedOn) return Infinity;
    const v0 = xPrev[this.cp]! - xPrev[this.cn]!;
    const th = this.acceptedOn ? this.params.vt - this.params.vh : this.params.vt + this.params.vh;
    if (v1 === v0) return t1;
    const f = (th - v0) / (v1 - v0);
    return t0 + Math.max(0, Math.min(1, f)) * (t1 - t0);
  }

  override accept(c: Circuit): void {
    if (c.mode === MODE_TRAN) {
      const want = this.want(c.x[this.cp]! - c.x[this.cn]!);
      if (want !== this.acceptedOn) {
        this.on = want;
        c.discontinuity = true;
      }
    }
    this.acceptedOn = this.on;
  }
}

/**
 * PSpice S and W: resistance moves smoothly between RON at VON and ROFF at VOFF, with
 * ln R a cubic in the control so that both value and slope are continuous at the ends.
 */
export class SmoothSwitch extends Device {
  private readonly p = new Pair();
  private ac = 0;
  private ad = 0;
  private bc = 0;
  private bd = 0;
  private cp = 0;
  private cn = 0;
  private readonly lm: number;
  private readonly lr: number;
  private readonly vm: number;
  private readonly vd: number;
  private readonly gOn: number;
  private readonly gOff: number;
  private g = 0;
  private dg = 0;
  private vab = 0;
  private lastI = 0;
  private lastG = 0;
  private lastV = 0;
  private lastGc = 0;
  private lastVc = 0;

  constructor(
    name: string,
    line: number,
    private a: number,
    private readonly b: number,
    private readonly control: SwitchControl,
    von: number,
    voff: number,
    ron: number,
    roff: number,
  ) {
    super(name, line);
    this.linear = false;
    this.lm = Math.log(Math.sqrt(ron * roff));
    this.lr = Math.log(ron / roff);
    this.vm = (von + voff) / 2;
    this.vd = von - voff;
    this.gOn = 1 / ron;
    this.gOff = 1 / roff;
  }

  override retargetA(n: number): boolean {
    if (n < 0) return true;
    this.savedA = this.a;
    this.a = n;
    return true;
  }

  setup(c: Circuit): void {
    this.p.setup(c, this.a, this.b);
    this.cp = this.control.kind === "nodes" ? this.control.cp : this.control.resolve(c);
    this.cn = this.control.kind === "nodes" ? this.control.cn : 0;
    this.ac = c.mat.slot(this.a, this.cp);
    this.ad = c.mat.slot(this.a, this.cn);
    this.bc = c.mat.slot(this.b, this.cp);
    this.bd = c.mat.slot(this.b, this.cn);
  }

  private conductance(vc: number): void {
    const u = (vc - this.vm) / this.vd;
    if (u >= 0.5) {
      this.g = this.gOn;
      this.dg = 0;
    } else if (u <= -0.5) {
      this.g = this.gOff;
      this.dg = 0;
    } else {
      this.g = Math.exp(-(this.lm + this.lr * u * (1.5 - 2 * u * u)));
      this.dg = (-this.g * this.lr * (1.5 - 6 * u * u)) / this.vd;
    }
  }

  private stampJacobian(c: Circuit, gc: number): void {
    const m = c.vals;
    this.p.add(m, this.g);
    m[this.ac]! += gc;
    m[this.ad]! -= gc;
    m[this.bc]! -= gc;
    m[this.bd]! += gc;
  }

  load(c: Circuit): void {
    const x = c.x;
    const vc = x[this.cp]! - x[this.cn]!;
    this.conductance(vc);
    const v = x[this.a]! - x[this.b]!;
    this.vab = v;
    const gc = v * this.dg;
    this.stampJacobian(c, gc);
    const i = this.g * v;
    if (c.iter > 0) {
      const hat = this.lastI + this.lastG * (v - this.lastV) + this.lastGc * (vc - this.lastVc);
      if (Math.abs(hat - i) > c.reltol * Math.max(Math.abs(hat), Math.abs(i)) + c.abstol) c.noncon++;
    }
    this.lastI = i;
    this.lastG = this.g;
    this.lastV = v;
    this.lastGc = gc;
    this.lastVc = vc;
    // I = g v is linear in v, so only the control term leaves a constant in the linearisation.
    const ieq = -gc * vc;
    c.rhs[this.a]! -= ieq;
    c.rhs[this.b]! += ieq;
  }

  loadAc(c: Circuit): void {
    this.stampJacobian(c, this.vab * this.dg);
  }

  /** Temperature for thermal noise, set from the circuit. */
  tempK = 300.15;

  override noise(_f: number, sink: NoiseSink): void {
    sink(this.name, this.a, this.b, 4 * BOLTZMANN * this.tempK * this.g);
  }
}

/** One variable of a behavioural expression. */
export type BVar =
  | { kind: "node"; id: number }
  | { kind: "branch"; resolve: BranchResolver }
  | { kind: "time" }
  | { kind: "ag0" }
  | { kind: "invag0" }
  | { kind: "aux" };

/** ddt() and sdt() terms: arg is evaluated, then var receives the result. */
export interface BAux {
  kind: "ddt" | "sdt";
  arg: Ast;
  out: number;
  ic: number;
}

const BEHAVIORAL_LIMIT = 1e30;
const VAR_TIME = -1;
const VAR_AG0 = -2;
const VAR_INV = -3;
const VAR_AUX = -4;

/** B: V=expr or I=expr, with symbolic derivatives. */
export class Behavioral extends Device {
  /** The value, then its derivative with respect to each variable. */
  private readonly tape: Tape;
  private readonly vars: Float64Array;
  private readonly dfVal: Float64Array;
  private idx: Int32Array = new Int32Array(0);
  private dSlotsA: number[] = [];
  private dSlotsB: number[] = [];
  private dSlotsR: number[] = [];
  private ka = 0;
  private kb = 0;
  private ra = 0;
  private rb = 0;
  private readonly auxArg: Evaluator[];
  private auxState = 0;
  private lastVal = 0;
  private readonly lastVars: Float64Array;
  private readonly lastDf: Float64Array;
  private readonly ag0Var: number;

  constructor(
    name: string,
    line: number,
    private a: number,
    private readonly b: number,
    private readonly isVoltage: boolean,
    expr: Ast,
    private readonly varDefs: BVar[],
    private readonly aux: BAux[] = [],
  ) {
    super(name, line);
    this.linear = false;
    const roots = [expr];
    for (let i = 0; i < varDefs.length; i++) roots.push(diff(expr, i));
    this.tape = new Tape(roots);
    this.vars = new Float64Array(varDefs.length);
    this.dfVal = new Float64Array(varDefs.length);
    this.lastVars = new Float64Array(varDefs.length);
    this.lastDf = new Float64Array(varDefs.length);
    this.auxArg = aux.map((u) => compile(u.arg));
    this.ag0Var = varDefs.findIndex((v) => v.kind === "ag0");
  }

  override retargetA(n: number): boolean {
    if (this.isVoltage) return false;
    if (n < 0) return true;
    this.savedA = this.a;
    this.a = n;
    return true;
  }

  override allocate(c: Circuit): void {
    if (this.isVoltage) this.branch = c.branchUnknown(this.name);
  }

  setup(c: Circuit): void {
    const n = this.varDefs.length;
    this.idx = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const d = this.varDefs[i]!;
      switch (d.kind) {
        case "node": this.idx[i] = d.id; break;
        case "branch": this.idx[i] = d.resolve(c); break;
        case "time": this.idx[i] = VAR_TIME; break;
        case "ag0": this.idx[i] = VAR_AG0; break;
        case "invag0": this.idx[i] = VAR_INV; break;
        default: this.idx[i] = VAR_AUX;
      }
      const col = this.idx[i]! > 0 ? this.idx[i]! : 0;
      if (this.isVoltage) {
        this.dSlotsR.push(c.mat.slot(this.branch, col));
      } else {
        this.dSlotsA.push(c.mat.slot(this.a, col));
        this.dSlotsB.push(c.mat.slot(this.b, col));
      }
    }
    if (this.isVoltage) {
      const br = this.branch;
      this.ka = c.mat.slot(this.a, br);
      this.kb = c.mat.slot(this.b, br);
      this.ra = c.mat.slot(br, this.a);
      this.rb = c.mat.slot(br, this.b);
    }
    if (this.aux.length > 0) this.auxState = c.allocState(2 * this.aux.length);
  }

  private fill(c: Circuit): void {
    const { idx, vars } = this;
    const x = c.x;
    for (let i = 0; i < idx.length; i++) {
      const k = idx[i]!;
      if (k >= 0) vars[i] = x[k]!;
      else if (k === VAR_TIME) vars[i] = c.t;
      else if (k === VAR_AG0) vars[i] = c.ag0;
      else if (k === VAR_INV) vars[i] = c.ag0 > 0 ? 1 / c.ag0 : 0;
    }
    const aux = this.aux;
    for (let i = 0; i < aux.length; i++) {
      const u = aux[i]!;
      const arg = this.auxArg[i]!(vars);
      const o = this.auxState + 2 * i;
      if (u.kind === "ddt") {
        vars[u.out] = c.integ(o, arg);
      } else {
        // sdt: the state pair stores integral and integrand, updated by the active method.
        const y = c.ag0 > 0 ? c.st1[o]! + (arg + c.trapF * c.st1[o + 1]!) / c.ag0 : c.reseeding ? c.st1[o]! : u.ic;
        c.st0[o] = y;
        c.st0[o + 1] = arg;
        vars[u.out] = y;
      }
    }
  }

  private evaluate(c: Circuit): number {
    this.fill(c);
    const { idx, vars, dfVal, tape } = this;
    tape.run(vars);
    for (let i = 0; i < idx.length; i++) {
      // A guess outside an expression's domain, such as 0 K at the first iteration, must not poison
      // the matrix: Newton moves on with a flat slope and tends to leave the bad region.
      const d = tape.out(i + 1);
      dfVal[i] = d > -BEHAVIORAL_LIMIT && d < BEHAVIORAL_LIMIT ? d : 0;
    }
    const y = tape.out(0);
    if (y > -BEHAVIORAL_LIMIT && y < BEHAVIORAL_LIMIT) return y;
    return y > 0 ? BEHAVIORAL_LIMIT : y < 0 ? -BEHAVIORAL_LIMIT : 0;
  }

  private stampJacobian(m: Float64Array, withBranch: boolean, dfVal: Float64Array): void {
    const { idx } = this;
    if (this.isVoltage) {
      if (withBranch) {
        m[this.ka]! += 1;
        m[this.kb]! -= 1;
        m[this.ra]! += 1;
        m[this.rb]! -= 1;
      }
      for (let i = 0; i < idx.length; i++) {
        if (idx[i]! > 0) m[this.dSlotsR[i]!]! -= dfVal[i]!;
      }
    } else {
      for (let i = 0; i < idx.length; i++) {
        if (idx[i]! > 0) {
          m[this.dSlotsA[i]!]! += dfVal[i]!;
          m[this.dSlotsB[i]!]! -= dfVal[i]!;
        }
      }
    }
  }

  load(c: Circuit): void {
    const val = this.evaluate(c);
    const { idx, vars, dfVal, lastVars, lastDf } = this;
    let eq = val;
    let hat = this.lastVal;
    for (let i = 0; i < idx.length; i++) {
      if (idx[i]! > 0) {
        eq -= dfVal[i]! * vars[i]!;
        hat += lastDf[i]! * (vars[i]! - lastVars[i]!);
      }
      lastVars[i] = vars[i]!;
      lastDf[i] = dfVal[i]!;
    }
    this.lastVal = val;
    if (c.iter > 0) {
      const big = Math.max(Math.abs(hat), Math.abs(val));
      if (Math.abs(hat - val) > c.reltol * big + (this.isVoltage ? c.vntol : c.abstol)) c.noncon++;
    }
    this.stampJacobian(c.vals, true, dfVal);
    if (this.isVoltage) {
      c.rhs[this.branch] = eq;
    } else {
      c.rhs[this.a]! -= eq;
      c.rhs[this.b]! += eq;
    }
  }

  loadAc(c: Circuit): void {
    this.evaluate(c);
    this.stampJacobian(c.vals, true, this.dfVal);
    if (this.ag0Var >= 0) {
      // ddt() terms are linear in ag0, so the change for ag0 = 1 is the coefficient of j*omega.
      const g = new Float64Array(this.dfVal);
      this.vars[this.ag0Var] = 1;
      const { dfVal, vars, tape } = this;
      tape.run(vars);
      for (let i = 0; i < dfVal.length; i++) dfVal[i] = tape.out(i + 1) - g[i]!;
      this.stampJacobian(c.imag, false, dfVal);
    }
  }
}
