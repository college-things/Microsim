// Stateful analog code models: outputs that hold state between steps and change at located events.
// State flips on accept and integration restarts, so Newton only ever sees a smooth circuit.

import { Circuit, Device, MODE_TRAN } from "./circuit";
import { Pair } from "./devices";

/** Crossing time of level between two samples. */
function crossing(v0: number, v1: number, level: number, t0: number, t1: number): number {
  if (v1 === v0) return t1;
  return t0 + Math.max(0, Math.min(1, (level - v0) / (v1 - v0))) * (t1 - t0);
}

/** Output modelled as an ideal voltage source whose value comes from the subclass. */
abstract class VoltageOutput extends Device {
  private ka = 0;
  private kb = 0;
  private ra = 0;
  private rb = 0;

  constructor(name: string, line: number, protected readonly outP: number, protected readonly outN: number) {
    super(name, line);
    this.linear = false;
    this.needsAccept = true;
    this.hasEvents = true;
  }

  override allocate(c: Circuit): void {
    this.branch = c.branchUnknown(this.name);
  }

  setup(c: Circuit): void {
    const br = this.branch;
    this.ka = c.mat.slot(this.outP, br);
    this.kb = c.mat.slot(this.outN, br);
    this.ra = c.mat.slot(br, this.outP);
    this.rb = c.mat.slot(br, this.outN);
  }

  protected stampOutput(m: Float64Array): void {
    m[this.ka]! += 1;
    m[this.kb]! -= 1;
    m[this.ra]! += 1;
    m[this.rb]! -= 1;
  }

  loadAc(c: Circuit): void {
    this.stampOutput(c.vals);
  }
}

/** Ramp between two values, for finite output edges. */
class Ramp {
  from = 0;
  to = 0;
  tStart = 0;
  tEnd = 0;
  at(t: number): number {
    if (t >= this.tEnd) return this.to;
    if (t <= this.tStart) return this.from;
    return this.from + ((this.to - this.from) * (t - this.tStart)) / (this.tEnd - this.tStart);
  }
  go(to: number, t: number, edge: number): void {
    this.from = this.at(t);
    this.to = to;
    this.tStart = t;
    this.tEnd = t + edge;
  }
  set(v: number): void {
    this.from = v;
    this.to = v;
    this.tStart = 0;
    this.tEnd = 0;
  }
}

/** Comparator: high when v(inP) exceeds v(inN), with a located crossing and a finite edge. */
export class Comparator extends VoltageOutput {
  private on = false;
  private readonly ramp = new Ramp();

  override copyState(old: Device): void {
    const o = old as Comparator;
    this.on = o.on;
    this.ramp.from = o.ramp.from;
    this.ramp.to = o.ramp.to;
    this.ramp.tStart = o.ramp.tStart;
    this.ramp.tEnd = o.ramp.tEnd;
  }

  constructor(
    name: string,
    line: number,
    out: number,
    private readonly inP: number,
    private readonly inN: number,
    private readonly level: number,
    private readonly edge: number,
  ) {
    super(name, line, out, 0);
  }

  load(c: Circuit): void {
    this.stampOutput(c.vals);
    if (c.mode === MODE_TRAN) {
      c.rhs[this.branch] = this.ramp.at(c.t);
      return;
    }
    const want = c.x[this.inP]! - c.x[this.inN]! > 0;
    if (want !== this.on && c.iter < 20) {
      this.on = want;
      c.noncon++;
    }
    this.ramp.set(this.on ? this.level : 0);
    c.rhs[this.branch] = this.ramp.to;
  }

  override checkEvent(c: Circuit, xPrev: Float64Array, t0: number, t1: number): number {
    const v1 = c.x[this.inP]! - c.x[this.inN]!;
    if (v1 > 0 === this.on) return Infinity;
    return crossing(xPrev[this.inP]! - xPrev[this.inN]!, v1, 0, t0, t1);
  }

  override accept(c: Circuit): void {
    if (c.mode !== MODE_TRAN) return;
    const want = c.x[this.inP]! - c.x[this.inN]! > 0;
    if (want !== this.on) {
      this.on = want;
      this.ramp.go(want ? this.level : 0, c.t, this.edge);
      c.discontinuity = true;
    }
  }

  override nextBreak(t: number, eps: number): number {
    return this.ramp.tEnd > t + eps ? this.ramp.tEnd : Infinity;
  }
}

/** XSPICE hyst: output follows a rising or a falling ramp, shifted by the hysteresis. */
export class Hysteresis extends VoltageOutput {
  private rising = true;

  override copyState(old: Device): void {
    this.rising = (old as Hysteresis).rising;
  }
  private sIn = 0;
  private sInN = 0;
  private dy = 0;

  constructor(
    name: string,
    line: number,
    outP: number,
    outN: number,
    private readonly inP: number,
    private readonly inN: number,
    private readonly low: number,
    private readonly high: number,
    private readonly hyst: number,
    private readonly outLow: number,
    private readonly outHigh: number,
  ) {
    super(name, line, outP, outN);
    this.hasEvents = false;
  }

  override setup(c: Circuit): void {
    super.setup(c);
    this.sIn = c.mat.slot(this.branch, this.inP);
    this.sInN = c.mat.slot(this.branch, this.inN);
  }

  private curve(v: number): number {
    const a = this.rising ? this.low + this.hyst : this.low - this.hyst;
    const b = this.rising ? this.high + this.hyst : this.high - this.hyst;
    if (v <= a) {
      this.dy = 0;
      return this.outLow;
    }
    if (v >= b) {
      this.dy = 0;
      return this.outHigh;
    }
    this.dy = (this.outHigh - this.outLow) / (b - a);
    return this.outLow + this.dy * (v - a);
  }

  load(c: Circuit): void {
    const v = c.x[this.inP]! - c.x[this.inN]!;
    const y = this.curve(v);
    const m = c.vals;
    this.stampOutput(m);
    m[this.sIn]! -= this.dy;
    m[this.sInN]! += this.dy;
    c.rhs[this.branch] = y - this.dy * v;
  }

  override loadAc(c: Circuit): void {
    this.stampOutput(c.vals);
    c.vals[this.sIn]! -= this.dy;
    c.vals[this.sInN]! += this.dy;
  }

  override accept(c: Circuit): void {
    const v = c.x[this.inP]! - c.x[this.inN]!;
    if (v >= this.high + this.hyst) this.rising = false;
    else if (v <= this.low - this.hyst) this.rising = true;
  }
}

/** XSPICE square: voltage-controlled square wave with integrated phase. */
export class SquareWave extends VoltageOutput {
  private phase = 0;
  private tPhase = 0;
  private freq = 1;

  override copyState(old: Device): void {
    const o = old as SquareWave;
    this.phase = o.phase;
    this.tPhase = o.tPhase;
    this.freq = o.freq;
  }
  private readonly tr: number;
  private readonly tf: number;

  constructor(
    name: string,
    line: number,
    outP: number,
    outN: number,
    private readonly cntlP: number,
    private readonly cntlN: number,
    private readonly cntl: number[],
    private readonly freqs: number[],
    private readonly low: number,
    private readonly high: number,
    private readonly duty: number,
    tr: number,
    tf: number,
  ) {
    super(name, line, outP, outN);
    this.hasEvents = false;
    this.tr = tr;
    this.tf = tf;
  }

  private frequency(c: Circuit): number {
    const v = c.x[this.cntlP]! - c.x[this.cntlN]!;
    const xs = this.cntl;
    const ys = this.freqs;
    const n = xs.length;
    if (n === 0) return 1;
    // Beyond the table the frequency extrapolates from the end segment, as XSPICE does.
    let i = 0;
    while (i < n - 2 && v > xs[i + 1]!) i++;
    if (n === 1) return ys[0]!;
    const dx = xs[i + 1]! - xs[i]!;
    const f = dx > 0 ? ys[i]! + ((ys[i + 1]! - ys[i]!) * (v - xs[i]!)) / dx : ys[i + 1]!;
    return f > 1e-9 ? f : 1e-9;
  }

  private valueAt(t: number): number {
    const p = this.phase + this.freq * (t - this.tPhase);
    const u = p - Math.floor(p);
    const fr = this.tr * this.freq;
    const ff = this.tf * this.freq;
    if (u < fr) return this.low + ((this.high - this.low) * u) / fr;
    if (u < this.duty) return this.high;
    if (u < this.duty + ff) return this.high + ((this.low - this.high) * (u - this.duty)) / ff;
    return this.low;
  }

  load(c: Circuit): void {
    this.stampOutput(c.vals);
    if (c.mode === MODE_TRAN) c.rhs[this.branch] = this.valueAt(c.t);
    else {
      this.freq = this.frequency(c);
      c.rhs[this.branch] = this.low;
    }
  }

  override accept(c: Circuit): void {
    if (c.mode === MODE_TRAN) {
      this.phase += this.freq * (c.t - this.tPhase);
      this.phase -= Math.floor(this.phase);
      this.tPhase = c.t;
    }
    this.freq = this.frequency(c);
  }

  override nextBreak(t: number, eps: number): number {
    const f = this.freq;
    const fr = this.tr * f;
    const ff = this.tf * f;
    const p = this.phase + f * (t - this.tPhase);
    const whole = Math.floor(p);
    const corners = [0, fr, this.duty, this.duty + ff, 1];
    for (let k = 0; k < 2; k++) {
      for (const co of corners) {
        const tc = t + (whole + k + co - p) / f;
        if (tc > t + eps) return tc;
      }
    }
    return Infinity;
  }
}

/** Multisim triggered_pwl: replays a time/value table from each trigger edge. */
export class TriggeredPwl extends VoltageOutput {
  private tTrig = -1;
  private last = 0;

  override copyState(old: Device): void {
    this.tTrig = (old as TriggeredPwl).tTrig;
    this.last = (old as TriggeredPwl).last;
  }

  constructor(
    name: string,
    line: number,
    outP: number,
    outN: number,
    private readonly inP: number,
    private readonly inN: number,
    private readonly times: number[],
    private readonly values: number[],
    private readonly vth: number,
    private readonly edge: string,
    private readonly retrigger: boolean,
    private readonly repeat: boolean,
  ) {
    super(name, line, outP, outN);
  }

  private value(t: number): number {
    const { times, values } = this;
    const n = times.length;
    if (this.tTrig < 0 || n === 0) return values[0] ?? 0;
    let u = t - this.tTrig;
    const span = times[n - 1]!;
    if (this.repeat && span > 0) u -= Math.floor(u / span) * span;
    if (u >= span) return values[n - 1]!;
    let i = 0;
    while (i < n - 2 && u >= times[i + 1]!) i++;
    const dt = times[i + 1]! - times[i]!;
    return dt > 0 ? values[i]! + ((values[i + 1]! - values[i]!) * (u - times[i]!)) / dt : values[i + 1]!;
  }

  private triggers(v0: number, v1: number): boolean {
    const up = v0 <= this.vth && v1 > this.vth;
    const down = v0 >= this.vth && v1 < this.vth;
    const e = this.edge;
    if (e.startsWith("bi")) return up || down;
    if (e.startsWith("f")) return down;
    return up;
  }

  private armed(t: number): boolean {
    if (this.tTrig < 0 || this.retrigger) return true;
    return !this.repeat && t - this.tTrig >= (this.times[this.times.length - 1] ?? 0);
  }

  load(c: Circuit): void {
    this.stampOutput(c.vals);
    c.rhs[this.branch] = c.mode === MODE_TRAN ? this.value(c.t) : this.values[0] ?? 0;
  }

  override checkEvent(c: Circuit, xPrev: Float64Array, t0: number, t1: number): number {
    const v0 = xPrev[this.inP]! - xPrev[this.inN]!;
    const v1 = c.x[this.inP]! - c.x[this.inN]!;
    if (!this.armed(t1) || !this.triggers(v0, v1)) return Infinity;
    return crossing(v0, v1, this.vth, t0, t1);
  }

  override accept(c: Circuit): void {
    const v = c.x[this.inP]! - c.x[this.inN]!;
    if (c.mode === MODE_TRAN && this.armed(c.t) && this.triggers(this.last, v)) {
      this.tTrig = c.t;
      c.discontinuity = true;
    }
    this.last = v;
  }

  override nextBreak(t: number, eps: number): number {
    if (this.tTrig < 0) return Infinity;
    const u = t - this.tTrig;
    for (const tc of this.times) if (tc > u + eps / 2) return this.tTrig + tc;
    return Infinity;
  }
}

/** Phase-angle controller: a gate pulse a set angle after each rising zero crossing of sync. */
export class PhaseController extends VoltageOutput {
  private tFire = Infinity;
  private tEnd = Infinity;
  private last = 0;

  override copyState(old: Device): void {
    const o = old as PhaseController;
    this.tFire = o.tFire;
    this.tEnd = o.tEnd;
    this.last = o.last;
  }
  private readonly period: number;
  private readonly edge: number;

  constructor(
    name: string,
    line: number,
    outP: number,
    outN: number,
    private readonly syncP: number,
    private readonly syncN: number,
    private readonly alpha: number,
    freq: number,
    private readonly widthDeg: number,
    private readonly amplitude: number,
  ) {
    super(name, line, outP, outN);
    this.period = 1 / freq;
    this.edge = this.period * 1e-5;
  }

  private value(t: number): number {
    const { tFire, tEnd, edge, amplitude } = this;
    if (t <= tFire) return 0;
    if (t < tFire + edge) return (amplitude * (t - tFire)) / edge;
    if (t <= tEnd) return amplitude;
    if (t < tEnd + edge) return amplitude * (1 - (t - tEnd) / edge);
    return 0;
  }

  load(c: Circuit): void {
    this.stampOutput(c.vals);
    c.rhs[this.branch] = c.mode === MODE_TRAN ? this.value(c.t) : 0;
  }

  override checkEvent(c: Circuit, xPrev: Float64Array, t0: number, t1: number): number {
    const v0 = xPrev[this.syncP]! - xPrev[this.syncN]!;
    const v1 = c.x[this.syncP]! - c.x[this.syncN]!;
    if (v0 <= 0 && v1 > 0) return crossing(v0, v1, 0, t0, t1);
    return Infinity;
  }

  override accept(c: Circuit): void {
    const v = c.x[this.syncP]! - c.x[this.syncN]!;
    if (c.mode === MODE_TRAN && this.last <= 0 && v > 0) {
      const delay = (c.x[this.alpha]! / 360) * this.period;
      this.tFire = c.t + Math.max(delay, 0);
      this.tEnd = this.tFire + (this.widthDeg / 360) * this.period;
      c.discontinuity = true;
    }
    this.last = v;
  }

  override nextBreak(t: number, eps: number): number {
    for (const tc of [this.tFire, this.tFire + this.edge, this.tEnd, this.tEnd + this.edge]) {
      if (tc > t + eps) return tc;
    }
    return Infinity;
  }
}

/**
 * Multisim linear_diode and transistor_ideal1: a piecewise-linear switch that reports its state,
 * current and blocking voltage on three outputs for the thermal loss models.
 */
export class IdealSwitch extends Device {
  private readonly p = new Pair();
  private on = false;

  override copyState(old: Device): void {
    this.on = (old as IdealSwitch).on;
  }
  private readonly slots: number[] = [];
  private branches: number[] = [];

  constructor(
    name: string,
    line: number,
    private readonly a: number,
    private readonly b: number,
    private readonly gate: number | null,
    private readonly vth: number,
    private readonly drop: number,
    private readonly ron: number,
    private readonly roff: number,
    private readonly outs: [number, number, number],
  ) {
    super(name, line);
    this.linear = false;
    this.needsAccept = true;
    this.hasEvents = true;
  }

  override allocate(c: Circuit): void {
    this.branches = this.outs.map((_, i) => c.branchUnknown(`${this.name}#out${i}`));
  }

  setup(c: Circuit): void {
    this.p.setup(c, this.a, this.b);
    this.outs.forEach((node, i) => {
      const br = this.branches[i]!;
      this.slots.push(c.mat.slot(node, br), c.mat.slot(br, node), c.mat.slot(br, this.a), c.mat.slot(br, this.b));
    });
  }

  private want(x: Float64Array): boolean {
    const v = x[this.a]! - x[this.b]!;
    if (v <= this.drop) return false;
    return this.gate === null ? true : x[this.gate]! > this.vth;
  }

  private stamp(c: Circuit, rhs: boolean): void {
    const m = c.vals;
    const g = 1 / (this.on ? this.ron : this.roff);
    const offset = this.on ? this.drop : 0;
    this.p.add(m, g);
    if (rhs) {
      c.rhs[this.a]! += g * offset;
      c.rhs[this.b]! -= g * offset;
    }
    const s = this.slots;
    for (let i = 0; i < 12; i += 4) {
      m[s[i]!]! += 1;
      m[s[i + 1]!]! += 1;
    }
    // Output 1 reports the device current, output 2 the voltage while blocking.
    m[s[6]!]! -= g;
    m[s[7]!]! += g;
    if (!this.on) {
      m[s[10]!]! -= 1;
      m[s[11]!]! += 1;
    }
    if (rhs) {
      c.rhs[this.branches[0]!] = this.on ? 1 : 0;
      c.rhs[this.branches[1]!] = -g * offset;
      c.rhs[this.branches[2]!] = 0;
    }
  }

  load(c: Circuit): void {
    if (c.mode !== MODE_TRAN) {
      const want = this.want(c.x);
      if (want !== this.on && c.iter < 20) {
        this.on = want;
        c.noncon++;
      }
    }
    this.stamp(c, true);
  }

  loadAc(c: Circuit): void {
    this.stamp(c, false);
  }

  override checkEvent(c: Circuit, xPrev: Float64Array, t0: number, t1: number): number {
    if (this.want(c.x) === this.on) return Infinity;
    const v0 = xPrev[this.a]! - xPrev[this.b]! - this.drop;
    const v1 = c.x[this.a]! - c.x[this.b]! - this.drop;
    if (v0 > 0 !== v1 > 0) return crossing(v0, v1, 0, t0, t1);
    if (this.gate !== null) return crossing(xPrev[this.gate]!, c.x[this.gate]!, this.vth, t0, t1);
    return t1;
  }

  override accept(c: Circuit): void {
    if (c.mode !== MODE_TRAN) return;
    const want = this.want(c.x);
    if (want !== this.on) {
      this.on = want;
      c.discontinuity = true;
    }
  }
}

/**
 * Multisim switching_loss_generator: energy per edge from current-indexed tables, scaled by the
 * blocked voltage, delivered as the average power into a thermal node over a sliding window.
 */
export class SwitchingLoss extends Device {
  private on = false;
  private power = 0;
  private lastV = 0;
  private lastI = 0;
  private edges: { t: number; e: number }[] = [];

  override copyState(old: Device): void {
    const o = old as SwitchingLoss;
    this.on = o.on;
    this.power = o.power;
    this.lastV = o.lastV;
    this.lastI = o.lastI;
    this.edges = o.edges.slice();
  }

  constructor(
    name: string,
    line: number,
    private readonly hot: number,
    private readonly ref: number,
    private readonly current: number,
    private readonly vblock: number,
    private readonly state: number,
    private readonly table: { i: number[]; on: number[]; off: number[] },
    private readonly vnom: number,
    private readonly scale: number,
    private readonly window: number,
  ) {
    super(name, line);
    this.linear = false;
    this.needsAccept = true;
  }

  setup(): void {}

  load(c: Circuit): void {
    c.rhs[this.hot]! += this.power;
    c.rhs[this.ref]! -= this.power;
  }

  loadAc(): void {}

  private energy(column: number[], i: number): number {
    const xs = this.table.i;
    const n = Math.min(xs.length, column.length);
    if (n === 0) return 0;
    if (i <= xs[0]!) return column[0]!;
    for (let k = 1; k < n; k++) {
      if (i <= xs[k]!) {
        const dx = xs[k]! - xs[k - 1]!;
        return dx > 0 ? column[k - 1]! + ((column[k]! - column[k - 1]!) * (i - xs[k - 1]!)) / dx : column[k]!;
      }
    }
    return column[n - 1]!;
  }

  override accept(c: Circuit): void {
    const on = c.x[this.state]! > 0.5;
    const v = Math.abs(c.x[this.vblock]!);
    const i = Math.abs(c.x[this.current]!);
    if (c.mode === MODE_TRAN && on !== this.on) {
      const column = on ? this.table.on : this.table.off;
      const milliJoule = this.energy(column, Math.max(i, this.lastI));
      const energy = 1e-3 * milliJoule * this.scale * (Math.max(v, this.lastV) / this.vnom);
      this.edges.push({ t: c.t, e: energy });
      while (this.edges.length > 0 && this.edges[0]!.t < c.t - this.window) this.edges.shift();
      let sum = 0;
      for (const edge of this.edges) sum += edge.e;
      this.power = sum / this.window;
    }
    this.on = on;
    this.lastV = v;
    this.lastI = i;
  }
}
