// Event-driven digital domain coupled to the analog solver.
//
// Nets touched only by digital ports carry a logic value and show up as a voltage through a
// unit-conductance row in the matrix, so v(net) works everywhere without a separate result path.
// Nets that also touch analog devices are bridged: outputs drive them through a Norton source with
// a ramp and inputs read them through a threshold. Time advances only as the analog solver
// reaches event times, which the transient loop treats as break points.

import { SimError } from "../core/sim";
import { Circuit, Device, MODE_TRAN, type DigitalHook } from "./circuit";

export const L0 = 0;
export const L1 = 1;
export const LX = 2;
export const LZ = 3;

const STRONG = 2;
const WEAK = 1;

/**
 * Input thresholds and output levels of a logic family. An input with hold set is a Schmitt
 * trigger: between its thresholds it keeps its state, where a plain input with separate
 * thresholds reads unknown.
 */
export interface LogicLevels {
  low: number;
  high: number;
  hold: boolean;
  vLow: number;
  vHigh: number;
  /** Warning for when these levels decide an analog boundary and were not stated in the netlist. */
  note: string | null;
}

export const DEFAULT_LEVELS: LogicLevels = {
  low: 2.5,
  high: 2.5,
  hold: false,
  vLow: 0,
  vHigh: 5,
  note: null,
};

const AUTO_ROUT = 10;
/** Chatter guard: flips this close to a plain threshold, this many times, get a small hysteresis. */
const CHATTER_FLIPS = 64;
const CHATTER_BAND = 0.1;
const WEAK_ROUT = 1e4;
const AUTO_EDGE = 1e-9;
const MAX_DELTAS = 100000;

export interface DigitalModel {
  inputs: number[];
  /** Respond to a change on trig, or -1 when arming at the start of a run. */
  evaluate(d: DigitalDomain, trig: number): void;
  /** Take over stored state from the same model in an earlier circuit. */
  copyState?(old: DigitalModel): void;
}

/** Voltage ramp produced by an output on an analog net. */
class AnalogDrive {
  value = LZ;
  slot = 0;
  from = 0;
  to = 0;
  tStart = 0;
  tEnd = 0;
  g = 0;

  constructor(
    readonly node: number,
    private readonly gDriven: number,
    private readonly vLow: number,
    private readonly vHigh: number,
    private readonly vX: number,
    private readonly tRise: number,
    private readonly tFall: number,
  ) {}

  gOf(): number {
    return this.gDriven;
  }

  /** Move the ramp's end after a supply change, from wherever the output is now. */
  retarget(target: number, t: number): void {
    const edge = target > this.to ? this.tRise : this.tFall;
    this.from = this.at(t);
    this.to = target;
    this.tStart = t;
    this.tEnd = t + edge;
  }

  level(v: number): number {
    return v === L1 ? this.vHigh : v === L0 ? this.vLow : this.vX;
  }

  at(t: number): number {
    if (t >= this.tEnd) return this.to;
    if (t <= this.tStart) return this.from;
    return this.from + ((this.to - this.from) * (t - this.tStart)) / (this.tEnd - this.tStart);
  }

  set(v: number, t: number, instant: boolean): void {
    this.value = v;
    this.g = v === LZ ? 0 : this.gDriven;
    const target = this.level(v);
    this.from = instant ? target : this.at(t);
    this.to = target;
    this.tStart = t;
    const edge = instant ? 0 : target > this.from ? this.tRise : this.tFall;
    this.tEnd = t + edge;
  }
}

interface Reader {
  node: number;
  low: number;
  high: number;
  hold: boolean;
  driver: number;
  state: number;
  rise: number;
  fall: number;
  /** Extra hysteresis added by the chatter guard, on each side. */
  band: number;
  flips: number;
  /** False for an input with its own hysteresis, which has no threshold to chatter at. */
  guarded: boolean;
  /** Furthest the input has been from its threshold since the last flip. */
  excursion: number;
}

export class DigitalDomain extends Device implements DigitalHook {
  readonly netNode: number[] = [];
  readonly netValue: number[] = [];
  /** Output voltage shown for logic high on each digital-only net. */
  private readonly netHigh: number[] = [];
  private readonly netDrivers: number[][] = [];
  private readonly netFanout: DigitalModel[][] = [];

  private readonly drvNet: number[] = [];
  private readonly drvStrength: number[] = [];
  private readonly drvValue: number[] = [];
  private readonly drvPend: number[] = [];
  private readonly drvSeq: number[] = [];
  private readonly drvAnalog: (AnalogDrive | null)[] = [];
  private readonly analogDrives: AnalogDrive[] = [];

  private readonly readers: Reader[] = [];
  private readonly models: DigitalModel[] = [];
  private readonly nodeToNet = new Map<number, number>();
  private readonly readerNet = new Map<string, number>();
  private pureSlots: number[] = [];
  private pureNets: number[] = [];

  // Pending events as a binary heap in parallel arrays.
  private readonly hTime: number[] = [];
  private readonly hSeq: number[] = [];
  private readonly hDrv: number[] = [];
  private seq = 0;

  private dirty: DigitalModel[] = [];
  private readonly dirtyTrig = new Map<DigitalModel, number>();

  now = 0;
  initMode = false;
  private x: Float64Array | null = null;
  private analogChanged = false;
  private pureChanged = false;

  constructor() {
    super("#digital", 0);
    this.hasEvents = true;
  }

  private newNet(node: number): number {
    const id = this.netNode.length;
    this.netNode.push(node);
    this.netValue.push(LZ);
    this.netHigh.push(DEFAULT_LEVELS.vHigh);
    this.netDrivers.push([]);
    this.netFanout.push([]);
    return id;
  }

  /** Internal net with no matrix row, for chip wires. */
  internalNet(): number {
    const id = this.newNet(-1);
    this.netValue[id] = L0;
    return id;
  }

  private isAnalog(c: Circuit, node: number): boolean {
    return node > 0 && c.pins[node]! > 0;
  }

  private pureNet(c: Circuit, node: number): number {
    let id = this.nodeToNet.get(node);
    if (id === undefined) {
      id = this.newNet(node);
      this.nodeToNet.set(node, id);
      if (node === 0) this.netValue[id] = L0;
      else c.digitalNodes.add(node);
    }
    return id;
  }

  isPureNode(c: Circuit, node: number): boolean {
    return !this.isAnalog(c, node);
  }

  pureNetOf(c: Circuit, node: number): number {
    return this.pureNet(c, node);
  }

  /** Net to read for an input port. An analog net gets one threshold reader shared by its ports. */
  inputNet(c: Circuit, node: number, levels: LogicLevels = DEFAULT_LEVELS): number {
    if (!this.isAnalog(c, node)) return this.pureNet(c, node);
    if (levels.note) c.warn(levels.note);
    const key = `${node}|${levels.low}|${levels.high}|${levels.hold}`;
    let id = this.readerNet.get(key);
    if (id === undefined) {
      id = this.internalNet();
      this.readerNet.set(key, id);
      this.addReader(node, levels.low, levels.high, id, 0, 0, levels.hold);
    }
    return id;
  }

  /** Threshold reader driving a digital net; shared logic for adc_bridge and automatic bridges. */
  addReader(node: number, low: number, high: number, net: number, rise: number, fall: number, hold = false): void {
    const driver = this.addDriver(net, STRONG);
    this.readers.push({ node, low, high, hold, driver, state: L0, rise, fall, band: 0, flips: 0, guarded: !hold && low === high, excursion: 0 });
  }

  addDriver(net: number, strength: number): number {
    const d = this.drvNet.length;
    this.drvNet.push(net);
    this.drvStrength.push(strength);
    this.drvValue.push(LZ);
    this.drvPend.push(-1);
    this.drvSeq.push(0);
    this.drvAnalog.push(null);
    this.netDrivers[net]!.push(d);
    return d;
  }

  /** Driver for an output port, bridged automatically when the net touches analog devices. */
  outputDriver(c: Circuit, node: number, weak = false, levels: LogicLevels = DEFAULT_LEVELS): number {
    if (node === 0) return this.addDriver(this.pureNet(c, 0), WEAK);
    if (!this.isAnalog(c, node)) {
      const net = this.pureNet(c, node);
      this.netHigh[net] = levels.vHigh;
      return this.addDriver(net, weak ? WEAK : STRONG);
    }
    if (levels.note) c.warn(levels.note);
    const g = 1 / (weak ? WEAK_ROUT : AUTO_ROUT);
    return this.analogDriver(node, g, levels.vLow, levels.vHigh, (levels.vLow + levels.vHigh) / 2, AUTO_EDGE, AUTO_EDGE);
  }

  /** Driver with an explicit analog output, used by dac_bridge. */
  analogDriver(node: number, g: number, vLow: number, vHigh: number, vX: number, rise: number, fall: number): number {
    const d = this.drvNet.length;
    this.drvNet.push(-1);
    this.drvStrength.push(STRONG);
    this.drvValue.push(LZ);
    this.drvPend.push(-1);
    this.drvSeq.push(0);
    const a = new AnalogDrive(node, g, vLow, vHigh, vX, rise, fall);
    this.drvAnalog.push(a);
    this.analogDrives.push(a);
    return d;
  }

  addModel(m: DigitalModel): void {
    this.models.push(m);
    for (const net of m.inputs) {
      if (!this.netFanout[net]!.includes(m)) this.netFanout[net]!.push(m);
    }
  }

  /** Logic value of a net; an undriven input floats high, as a TTL input does. */
  val(net: number): number {
    const v = this.netValue[net]!;
    if (v === LZ) return this.netDrivers[net]!.length === 0 && this.netNode[net] !== 0 ? L1 : LX;
    return v;
  }

  /** Logic value for active-high controls such as set and reset, inactive when undriven. */
  valCtl(net: number): number {
    const v = this.netValue[net]!;
    if (v === LZ) return this.netDrivers[net]!.length === 0 ? L0 : LX;
    return v;
  }

  /** Request an output value after a delay, with inertial cancellation of a superseded change. */
  schedule(drv: number, value: number, delay: number): void {
    if (this.initMode) {
      this.commit(drv, value);
      return;
    }
    if (this.drvPend[drv] === value) return;
    if (this.drvPend[drv]! >= 0) {
      this.drvSeq[drv] = ++this.seq;
      this.drvPend[drv] = -1;
    }
    if (value === this.drvValue[drv]) return;
    this.drvPend[drv] = value;
    const s = ++this.seq;
    this.drvSeq[drv] = s;
    this.heapPush(this.now + delay, s, drv);
  }

  private heapPush(t: number, s: number, drv: number): void {
    const T = this.hTime;
    const S = this.hSeq;
    const D = this.hDrv;
    let i = T.length;
    T.push(t);
    S.push(s);
    D.push(drv);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (T[p]! < t || (T[p] === t && S[p]! < s)) break;
      T[i] = T[p]!;
      S[i] = S[p]!;
      D[i] = D[p]!;
      i = p;
    }
    T[i] = t;
    S[i] = s;
    D[i] = drv;
  }

  private heapPopInto(): void {
    const T = this.hTime;
    const S = this.hSeq;
    const D = this.hDrv;
    const t = T.pop()!;
    const s = S.pop()!;
    const d = D.pop()!;
    const n = T.length;
    if (n === 0) return;
    let i = 0;
    for (;;) {
      let k = 2 * i + 1;
      if (k >= n) break;
      if (k + 1 < n && (T[k + 1]! < T[k]! || (T[k + 1] === T[k] && S[k + 1]! < S[k]!))) k++;
      if (t < T[k]! || (t === T[k] && s < S[k]!)) break;
      T[i] = T[k]!;
      S[i] = S[k]!;
      D[i] = D[k]!;
      i = k;
    }
    T[i] = t;
    S[i] = s;
    D[i] = d;
  }

  private markFanout(net: number): void {
    const fan = this.netFanout[net]!;
    for (let i = 0; i < fan.length; i++) {
      const m = fan[i]!;
      if (!this.dirtyTrig.has(m)) this.dirty.push(m);
      this.dirtyTrig.set(m, net);
    }
  }

  private resolve(net: number): number {
    const drivers = this.netDrivers[net]!;
    let strong = -1;
    let weak = -1;
    for (let i = 0; i < drivers.length; i++) {
      const d = drivers[i]!;
      const v = this.drvValue[d]!;
      if (v === LZ) continue;
      if (this.drvStrength[d] === STRONG) strong = strong === -1 || strong === v ? v : LX;
      else weak = weak === -1 || weak === v ? v : LX;
    }
    if (strong >= 0) return strong;
    if (weak >= 0) return weak;
    return LZ;
  }

  sameStructure(other: DigitalHook): boolean {
    const o = other as DigitalDomain;
    const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!same(this.netNode, o.netNode) || !same(this.drvNet, o.drvNet)) return false;
    if (this.readers.length !== o.readers.length || this.analogDrives.length !== o.analogDrives.length) return false;
    if (this.models.length !== o.models.length) return false;
    for (let i = 0; i < this.models.length; i++) {
      if (this.models[i]!.constructor !== o.models[i]!.constructor) return false;
      if (!same(this.models[i]!.inputs, o.models[i]!.inputs)) return false;
    }
    for (let i = 0; i < this.readers.length; i++) {
      if (this.readers[i]!.node !== o.readers[i]!.node) return false;
    }
    return true;
  }

  copyStateFrom(other: DigitalHook): void {
    const o = other as DigitalDomain;
    const copy = (to: number[], from: readonly number[]): void => {
      to.length = 0;
      for (const v of from) to.push(v);
    };
    copy(this.netValue, o.netValue);
    copy(this.drvValue, o.drvValue);
    copy(this.drvPend, o.drvPend);
    copy(this.drvSeq, o.drvSeq);
    copy(this.hTime, o.hTime);
    copy(this.hSeq, o.hSeq);
    copy(this.hDrv, o.hDrv);
    this.seq = o.seq;
    this.now = o.now;
    for (let i = 0; i < this.readers.length; i++) {
      const r = this.readers[i]!;
      const f = o.readers[i]!;
      r.state = f.state;
      r.band = f.band;
      r.flips = f.flips;
      r.excursion = f.excursion;
      // Hysteresis the chatter guard added stays; a Schmitt input's own setting comes from the model.
      r.hold = r.hold || f.band > 0;
    }
    for (let i = 0; i < this.analogDrives.length; i++) {
      const a = this.analogDrives[i]!;
      const f = o.analogDrives[i]!;
      a.value = f.value;
      a.g = f.value === LZ ? 0 : a.gOf();
      a.from = f.from;
      a.to = f.to;
      a.tStart = f.tStart;
      a.tEnd = f.tEnd;
    }
    for (let i = 0; i < this.models.length; i++) {
      const m = this.models[i]!;
      if (m.copyState) m.copyState(o.models[i]!);
    }
  }

  resume(c: Circuit, t: number): void {
    this.x = c.x;
    this.now = t;
    // A changed supply moves the level of a digital net and the target of a driven analog net.
    this.writePure(c.x);
    for (const a of this.analogDrives) {
      const target = a.level(a.value);
      if (target !== a.to) a.retarget(target, t);
    }
    for (let i = 0; i < this.models.length; i++) this.models[i]!.evaluate(this, -1);
  }

  takeEvents(): number {
    const n = this.events;
    this.events = 0;
    return n;
  }

  private events = 0;

  private commit(drv: number, value: number): void {
    this.events++;
    this.drvPend[drv] = -1;
    if (this.drvValue[drv] === value) return;
    this.drvValue[drv] = value;
    const analog = this.drvAnalog[drv];
    if (analog) {
      analog.set(value, this.now, this.initMode);
      this.analogChanged = true;
      return;
    }
    const net = this.drvNet[drv]!;
    const nv = this.resolve(net);
    if (nv === this.netValue[net]) return;
    this.netValue[net] = nv;
    const node = this.netNode[net]!;
    if (node > 0 && this.x) {
      this.x[node] = logicVoltage(nv, this.netHigh[net]!);
      this.pureChanged = true;
    }
    this.markFanout(net);
  }

  private flush(): void {
    while (this.dirty.length > 0) {
      const list = this.dirty;
      this.dirty = [];
      const trig = new Map(this.dirtyTrig);
      this.dirtyTrig.clear();
      for (let i = 0; i < list.length; i++) list[i]!.evaluate(this, trig.get(list[i]!) ?? -1);
      if (!this.initMode) return;
      if (++this.flushes > 64) return;
    }
  }

  private flushes = 0;

  private digitize(r: Reader, v: number): number {
    if (r.hold) {
      if (v > r.high + r.band) return L1;
      if (v < r.low - r.band) return L0;
      return r.state;
    }
    if (r.low === r.high) return v > r.high ? L1 : L0;
    if (v < r.low) return L0;
    if (v > r.high) return L1;
    return LX;
  }

  // Analog coupling.

  override setup(c: Circuit): void {
    for (let net = 0; net < this.netNode.length; net++) {
      const node = this.netNode[net]!;
      if (node > 0) {
        this.pureNets.push(net);
        this.pureSlots.push(c.mat.slot(node, node));
      }
    }
    for (const a of this.analogDrives) a.slot = c.mat.slot(a.node, a.node);
  }

  load(c: Circuit): void {
    const m = c.vals;
    const rhs = c.rhs;
    const pure = this.pureNets;
    for (let i = 0; i < pure.length; i++) {
      const net = pure[i]!;
      m[this.pureSlots[i]!]! += 1;
      rhs[this.netNode[net]!] = logicVoltage(this.netValue[net]!, this.netHigh[net]!);
    }
    const tran = c.mode === MODE_TRAN;
    const drives = this.analogDrives;
    for (let i = 0; i < drives.length; i++) {
      const a = drives[i]!;
      if (a.g === 0) continue;
      m[a.slot]! += a.g;
      rhs[a.node]! += a.g * (tran ? a.at(c.t) : a.to);
    }
  }

  loadAc(c: Circuit): void {
    const m = c.vals;
    for (let i = 0; i < this.pureSlots.length; i++) m[this.pureSlots[i]!]! += 1;
    for (const a of this.analogDrives) if (a.g !== 0) m[a.slot]! += a.g;
  }

  override checkEvent(c: Circuit, xPrev: Float64Array, t0: number, t1: number): number {
    let best = Infinity;
    const readers = this.readers;
    for (let i = 0; i < readers.length; i++) {
      const r = readers[i]!;
      const v1 = c.x[r.node]!;
      const next = this.digitize(r, v1);
      if (next === r.state) continue;
      const v0 = xPrev[r.node]!;
      if (v1 === v0) continue;
      // The threshold crossed last on the way from the old state to the new one.
      const th = v1 > v0 ? (next === L1 ? r.high + r.band : r.low) : next === L0 ? r.low - r.band : r.high;
      const f = Math.max(0, Math.min(1, (th - v0) / (v1 - v0)));
      const te = t0 + f * (t1 - t0);
      if (te < best) best = te;
    }
    return best;
  }

  override nextBreak(t: number, eps: number): number {
    let best = Infinity;
    const drives = this.analogDrives;
    for (let i = 0; i < drives.length; i++) {
      const e = drives[i]!.tEnd;
      if (e > t + eps && e < best) best = e;
    }
    return best;
  }

  softBreak(t: number, eps: number): number {
    while (this.hTime.length > 0) {
      const d = this.hDrv[0]!;
      if (this.hSeq[0] === this.drvSeq[d] && this.drvPend[d]! >= 0) break;
      this.heapPopInto();
    }
    if (this.hTime.length === 0) return Infinity;
    const next = this.hTime[0]!;
    return next > t + eps ? next : t + 2 * eps;
  }

  /**
   * A plain gate in a feedback loop with an RC sits at its threshold and flips at the gate's own
   * delay, costing millions of steps to move the node by nothing. A real gate biases there as a
   * linear amplifier. After enough flips near the threshold the input gets a small hysteresis,
   * which bounds the step count and leaves the node within a tenth of a volt of the threshold.
   */
  private guardChatter(c: Circuit, r: Reader, v: number): void {
    if (!r.guarded) return;
    // A signal that really crosses the threshold moves well away from it between flips.
    const quiet = r.excursion <= CHATTER_BAND + r.band;
    r.excursion = Math.abs(v - r.high);
    if (!quiet) {
      r.flips = 0;
      return;
    }
    if (++r.flips < CHATTER_FLIPS || r.band >= CHATTER_BAND) return;
    r.flips = 0;
    r.band = r.band === 0 ? CHATTER_BAND / 8 : Math.min(CHATTER_BAND, r.band * 2);
    r.hold = true;
    c.warn(`The digital input on ${c.unknownName(r.node)} chatters at its threshold through analog feedback; it now has up to ${CHATTER_BAND} V of hysteresis to bound the step count`);
  }

  /** Read every threshold into its driver. */
  private readAll(c: Circuit): void {
    const readers = this.readers;
    for (let i = 0; i < readers.length; i++) {
      const r = readers[i]!;
      const v = c.x[r.node]!;
      if (r.guarded) {
        const away = Math.abs(v - r.high);
        if (away > r.excursion) r.excursion = away;
      }
      const next = this.digitize(r, v);
      if (next !== r.state || this.drvValue[r.driver] === LZ) {
        const rising = next === L1;
        if (!this.initMode) this.guardChatter(c, r, v);
        r.state = next;
        this.schedule(r.driver, next, rising ? r.rise : r.fall);
      }
    }
  }

  /** Zero-delay evaluation for a DC solution. Returns true when analog nets must be re-solved. */
  settle(c: Circuit): boolean {
    this.x = c.x;
    this.initMode = true;
    this.analogChanged = false;
    this.flushes = 0;
    for (let net = 0; net < this.netValue.length; net++) {
      if (this.netValue[net] === LZ && this.netDrivers[net]!.length > 0) this.netValue[net] = L0;
    }
    this.readAll(c);
    // Gauss-Seidel passes break the symmetry of feedback loops such as rings of inverters.
    for (let pass = 0; pass < 8; pass++) {
      this.flushes = 0;
      const before = this.drvValue.slice();
      for (let i = 0; i < this.models.length; i++) this.models[i]!.evaluate(this, -1);
      this.flush();
      let same = true;
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== this.drvValue[i]) {
          same = false;
          break;
        }
      }
      if (same) break;
    }
    this.dirty = [];
    this.dirtyTrig.clear();
    this.initMode = false;
    this.writePure(c.x);
    return this.analogChanged;
  }

  private writePure(x: Float64Array): void {
    for (let net = 0; net < this.netNode.length; net++) {
      const node = this.netNode[net]!;
      if (node > 0) x[node] = logicVoltage(this.netValue[net]!, this.netHigh[net]!);
    }
  }

  /** Start timed simulation from the settled state. */
  arm(c: Circuit): void {
    this.x = c.x;
    this.now = 0;
    for (let i = 0; i < this.models.length; i++) this.models[i]!.evaluate(this, -1);
  }

  /** Apply everything due by time t. Returns true when any net or analog drive changed. */
  process(c: Circuit, t: number, eps: number): boolean {
    this.x = c.x;
    this.now = t;
    this.analogChanged = false;
    this.pureChanged = false;
    this.readAll(c);
    let deltas = 0;
    for (;;) {
      while (this.hTime.length > 0 && this.hTime[0]! <= t + eps) {
        const d = this.hDrv[0]!;
        const s = this.hSeq[0]!;
        this.heapPopInto();
        if (s !== this.drvSeq[d] || this.drvPend[d]! < 0) continue;
        this.commit(d, this.drvPend[d]!);
      }
      if (this.dirty.length === 0) break;
      this.flush();
      if (++deltas > MAX_DELTAS) {
        throw new SimError(`Digital logic did not settle at t = ${t}; a zero-delay feedback loop is oscillating`, "convergence");
      }
    }
    if (this.analogChanged) c.discontinuity = true;
    return this.analogChanged || this.pureChanged;
  }
}

export function logicVoltage(v: number, high: number): number {
  return v === L1 ? high : v === L0 ? 0 : high / 2;
}

// Gate models.

export type GateKind = "and" | "nand" | "or" | "nor" | "xor" | "xnor" | "buffer" | "inverter";

export class Gate implements DigitalModel {
  constructor(
    readonly inputs: number[],
    private readonly drv: number,
    private readonly kind: GateKind,
    private readonly rise: number,
    private readonly fall: number,
  ) {}

  evaluate(d: DigitalDomain): void {
    const v = gateValue(this.kind, this.inputs, d);
    d.schedule(this.drv, v, v === L1 ? this.rise : v === L0 ? this.fall : Math.max(this.rise, this.fall));
  }
}

function gateValue(kind: GateKind, inputs: number[], d: DigitalDomain): number {
  let anyX = false;
  let any1 = false;
  let any0 = false;
  let parity = 0;
  for (let i = 0; i < inputs.length; i++) {
    const v = d.val(inputs[i]!);
    if (v === L1) {
      any1 = true;
      parity ^= 1;
    } else if (v === L0) any0 = true;
    else anyX = true;
  }
  const not = (v: number): number => (v === L1 ? L0 : v === L0 ? L1 : LX);
  switch (kind) {
    case "buffer":
      return anyX ? LX : any1 ? L1 : L0;
    case "inverter":
      return anyX ? LX : any1 ? L0 : L1;
    case "and":
      return any0 ? L0 : anyX ? LX : L1;
    case "nand":
      return not(any0 ? L0 : anyX ? LX : L1);
    case "or":
      return any1 ? L1 : anyX ? LX : L0;
    case "nor":
      return not(any1 ? L1 : anyX ? LX : L0);
    case "xor":
      return anyX ? LX : parity ? L1 : L0;
    case "xnor":
      return anyX ? LX : parity ? L0 : L1;
  }
}

/** Fixed source for d_constsource, and weak pull for d_pullup and d_pulldown. */
export class Constant implements DigitalModel {
  readonly inputs: number[] = [];
  constructor(private readonly drv: number, private readonly value: number) {}
  evaluate(d: DigitalDomain): void {
    d.schedule(this.drv, this.value, 0);
  }
}

export class Tristate implements DigitalModel {
  constructor(
    readonly inputs: number[],
    private readonly drv: number,
    private readonly delay: number,
  ) {}
  evaluate(d: DigitalDomain): void {
    const data = d.val(this.inputs[0]!);
    const en = d.val(this.inputs[1]!);
    const v = en === L1 ? (data === L1 || data === L0 ? data : LX) : en === L0 ? LZ : LX;
    d.schedule(this.drv, v, this.delay);
  }
}

export class Clock implements DigitalModel {
  readonly inputs: number[];
  private armed = false;

  copyState(old: DigitalModel): void {
    this.armed = (old as Clock).armed;
  }
  constructor(
    net: number,
    private readonly drv: number,
    private readonly high: number,
    private readonly low: number,
    private readonly delay: number,
  ) {
    this.inputs = [net];
  }
  evaluate(d: DigitalDomain, trig: number): void {
    if (d.initMode) {
      d.schedule(this.drv, L0, 0);
      return;
    }
    if (!this.armed) {
      this.armed = true;
      d.schedule(this.drv, L1, this.delay);
      return;
    }
    if (trig < 0) return;
    if (d.val(this.inputs[0]!) === L1) d.schedule(this.drv, L0, this.high);
    else d.schedule(this.drv, L1, this.low);
  }
}

export type FlopKind = "d" | "t" | "jk" | "sr" | "dlatch" | "srlatch";

export interface FlopTiming {
  clk: number;
  set: number;
  reset: number;
  rise: number;
  fall: number;
}

/**
 * Flip-flops and latches. data holds the data inputs in port order, clk is the clock or enable.
 * Set and reset override and are active high; their delays add to the output delay.
 */
export class Flop implements DigitalModel {
  readonly inputs: number[];
  private state: number;
  private prevClk = L0;

  copyState(old: DigitalModel): void {
    this.state = (old as Flop).state;
    this.prevClk = (old as Flop).prevClk;
  }

  constructor(
    private readonly kind: FlopKind,
    private readonly data: number[],
    private readonly clk: number,
    private readonly set: number,
    private readonly reset: number,
    private readonly out: number,
    private readonly nout: number,
    private readonly t: FlopTiming,
    ic: number,
  ) {
    this.inputs = [...data, clk, set, reset];
    this.state = ic;
  }

  private next(d: DigitalDomain): number {
    const q = this.state;
    switch (this.kind) {
      case "d":
      case "dlatch":
        return norm(d.val(this.data[0]!));
      case "t": {
        const t = d.val(this.data[0]!);
        return t === L0 ? q : t === L1 ? (q === L1 ? L0 : q === L0 ? L1 : LX) : LX;
      }
      case "jk": {
        const j = d.val(this.data[0]!);
        const k = d.val(this.data[1]!);
        if (j === LX || k === LX) return LX;
        if (j === L1 && k === L1) return q === L1 ? L0 : q === L0 ? L1 : LX;
        if (j === L1) return L1;
        if (k === L1) return L0;
        return q;
      }
      default: {
        const s = d.val(this.data[0]!);
        const r = d.val(this.data[1]!);
        if (s === LX || r === LX) return LX;
        if (s === L1 && r === L1) return LX;
        if (s === L1) return L1;
        if (r === L1) return L0;
        return q;
      }
    }
  }

  evaluate(d: DigitalDomain, trig: number): void {
    const clk = d.val(this.clk);
    const set = d.valCtl(this.set);
    const reset = d.valCtl(this.reset);
    const level = this.kind === "dlatch" || this.kind === "srlatch";
    let delay = this.t.clk;
    let changed = false;
    if (set === L1 && reset === L1) {
      this.state = LX;
      changed = true;
      delay = Math.max(this.t.set, this.t.reset);
    } else if (set === L1) {
      changed = this.state !== L1;
      this.state = L1;
      delay = this.t.set;
    } else if (reset === L1) {
      changed = this.state !== L0;
      this.state = L0;
      delay = this.t.reset;
    } else if (level) {
      if (clk === L1) {
        const n = this.next(d);
        changed = n !== this.state;
        this.state = n;
      }
    } else if (!d.initMode && trig === this.clk && this.prevClk === L0 && clk === L1) {
      const n = this.next(d);
      changed = n !== this.state;
      this.state = n;
    }
    if (trig === this.clk || trig < 0) this.prevClk = clk;
    if (!changed && trig >= 0 && !d.initMode) return;
    const q = this.state;
    const dr = delay + (q === L1 ? this.t.rise : this.t.fall);
    const df = delay + (q === L1 ? this.t.fall : this.t.rise);
    d.schedule(this.out, q, dr);
    d.schedule(this.nout, q === L1 ? L0 : q === L0 ? L1 : LX, df);
  }
}

function norm(v: number): number {
  return v === L1 || v === L0 ? v : LX;
}

/** Threshold-free digital-to-analog: follow the input on an analog driver. */
export class DacDrive implements DigitalModel {
  readonly inputs: number[];
  constructor(input: number, private readonly drv: number) {
    this.inputs = [input];
  }
  evaluate(d: DigitalDomain): void {
    d.schedule(this.drv, norm(d.val(this.inputs[0]!)), 0);
  }
}

export class Ram implements DigitalModel {
  readonly inputs: number[];
  private memory = new Map<number, number[]>();

  copyState(old: DigitalModel): void {
    this.memory = new Map((old as Ram).memory);
  }

  constructor(
    private readonly dataIn: number[],
    private readonly dataOut: number[],
    private readonly addr: number[],
    private readonly we: number,
    private readonly select: number[],
    private readonly selectValue: number,
    private readonly readDelay: number,
    private readonly drivers: number[],
  ) {
    this.inputs = [...dataIn, ...addr, we, ...select];
  }

  evaluate(d: DigitalDomain): void {
    let selected = true;
    for (let i = 0; i < this.select.length; i++) {
      const want = (this.selectValue >> i) & 1;
      if (d.val(this.select[i]!) !== (want ? L1 : L0)) selected = false;
    }
    let address = 0;
    let known = true;
    for (let i = 0; i < this.addr.length; i++) {
      const v = d.val(this.addr[i]!);
      if (v === L1) address |= 1 << i;
      else if (v !== L0) known = false;
    }
    const we = d.val(this.we);
    if (selected && we === L1 && known) {
      this.memory.set(address, this.dataIn.map((n) => norm(d.val(n))));
    }
    for (let i = 0; i < this.dataOut.length; i++) {
      let v = LZ;
      if (selected && we !== L1) {
        const word = known ? this.memory.get(address) : undefined;
        v = word ? word[i]! : LX;
      }
      d.schedule(this.drivers[i]!, v, this.readDelay);
    }
  }
}

// Truth-table chips.

interface ChipDelay {
  rise: number;
  fall: number;
}

interface ChipModule {
  name: string;
  inputs: string[];
  outputs: string[];
  clock: { pin: number; rising: boolean; flags: number; sync: ChipRow[]; async: ChipRow[] } | null;
  table: ChipRow[];
  delays: Map<string, ChipDelay>;
}

interface ChipRow {
  cells: Uint8Array;
  out: string[];
}

interface ChipInstance {
  module: ChipModule;
  ports: string[];
}

export interface ChipDef {
  inputs: string[];
  outputs: string[];
  wires: string[];
  instances: ChipInstance[];
  /** Delays stated at the chip level, by input and output pin of the whole chip. */
  delays: Map<string, ChipDelay>;
}

const CHIP_DEFAULT_DELAY = 1e-9;
const CELL_ANY = 2;

function isCellGroup(tok: string): boolean {
  return /^[hlx01]+$/.test(tok);
}

/** Parse a truth-table behaviour description. Throws Error with a message when it cannot. */
export function parseChip(text: string, parseValue: (tok: string) => number): ChipDef {
  const tokens: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "");
    for (const t of line.split(/\s+/)) if (t) tokens.push(t);
  }
  let at = 0;
  const isKey = (t: string | undefined): boolean => t !== undefined && t[0] === "/" && t.length > 1;
  const names = (): string[] => {
    const out: string[] = [];
    while (at < tokens.length && !isKey(tokens[at])) out.push(tokens[at++]!);
    return out;
  };
  const rows = (count: number, width: number, outs: number): ChipRow[] => {
    const list: ChipRow[] = [];
    for (let r = 0; r < count; r++) {
      const cells: number[] = [];
      while (cells.length < width) {
        const tok = tokens[at++];
        if (tok === undefined || !isCellGroup(tok)) throw new Error(`bad table cell '${tok}'`);
        for (const ch of tok) cells.push(ch === "h" || ch === "1" ? L1 : ch === "l" || ch === "0" ? L0 : CELL_ANY);
      }
      const out: string[] = [];
      for (let k = 0; k < outs; k++) {
        const tok = tokens[at++];
        if (tok === undefined || isKey(tok)) throw new Error("short table row");
        out.push(tok);
      }
      list.push({ cells: Uint8Array.from(cells), out });
    }
    return list;
  };
  const readDelays = (m: { delays: Map<string, ChipDelay> }): void => {
    const items = names();
    const count = parseInt(items[0] ?? "0", 10);
    for (let i = 0; i < count; i++) {
      const base = 1 + 4 * i;
      const input = items[base];
      const output = items[base + 1];
      if (input === undefined || output === undefined) break;
      m.delays.set(`${input}|${output}`, { rise: parseValue(items[base + 2] ?? "0"), fall: parseValue(items[base + 3] ?? "0") });
    }
  };
  const newModule = (name: string, inputs: string[], outputs: string[]): ChipModule => ({
    name, inputs, outputs, clock: null, table: [], delays: new Map(),
  });

  const def: ChipDef = { inputs: [], outputs: [], wires: [], instances: [], delays: new Map() };
  const modules = new Map<string, ChipModule>();
  let top: ChipModule | null = null;
  let current: ChipModule | null = null;

  while (at < tokens.length) {
    const key = tokens[at++]!;
    if (!isKey(key)) continue;
    switch (key) {
      case "/inputs":
        if (current) current.inputs = names();
        else def.inputs = names();
        break;
      case "/outputs":
        if (current) current.outputs = names();
        else def.outputs = names();
        break;
      case "/wires":
        def.wires = names();
        break;
      case "/module":
        current = newModule(tokens[at++] ?? "", [], []);
        modules.set(current.name, current);
        break;
      case "/endmodule":
        current = null;
        break;
      case "/clock":
      case "/table": {
        const owner: ChipModule = current ?? (top ??= newModule("#top", def.inputs, def.outputs));
        if (key === "/clock") {
          const pinName = tokens[at++]!;
          const edge = tokens[at++]!;
          const flags = parseInt(tokens[at++]!, 10);
          const nSync = parseInt(tokens[at++]!, 10);
          const nAsync = parseInt(tokens[at++]!, 10);
          const width = owner.inputs.length + flags;
          const pin = owner.inputs.indexOf(pinName);
          if (pin < 0) throw new Error(`unknown clock pin '${pinName}'`);
          const sync = rows(nSync, width, flags);
          const asyncRows = rows(nAsync, width, flags);
          owner.clock = { pin, rising: edge !== "-", flags, sync, async: asyncRows };
        } else {
          const count = parseInt(tokens[at++]!, 10);
          const width = owner.inputs.length + (owner.clock ? owner.clock.flags : 0);
          owner.table = rows(count, width, owner.outputs.length);
        }
        break;
      }
      case "/delay":
        // A chip-level /delay block is timing alone: it must not create an empty module, whose
        // output table would drive every pin unknown against the real modules.
        readDelays(current ?? def);
        break;
      case "/instance": {
        const name = tokens[at++]!;
        const m = modules.get(name);
        if (!m) throw new Error(`unknown module '${name}'`);
        def.instances.push({ module: m, ports: names() });
        break;
      }
      default:
        // /constraint and /conditional_delay describe checks and refinements only.
        names();
    }
  }
  if (top) {
    for (const [key, value] of def.delays) top.delays.set(key, value);
    def.instances.push({ module: top, ports: [...def.inputs, ...def.outputs] });
  }
  return def;
}

class ChipUnit implements DigitalModel {
  readonly inputs: number[];
  private readonly flags: Uint8Array;
  private prevClk = L0;

  copyState(old: DigitalModel): void {
    const o = old as ChipUnit;
    this.flags.set(o.flags);
    this.prevClk = o.prevClk;
  }

  constructor(
    private readonly m: ChipModule,
    private readonly inNets: number[],
    private readonly drivers: number[],
    /** Chip-level delays, read by the pin names this instance connects to. */
    private readonly chipDelays: Map<string, ChipDelay> = new Map(),
    private readonly inPorts: string[] = [],
    private readonly outPorts: string[] = [],
  ) {
    this.inputs = [...new Set(inNets)];
    this.flags = new Uint8Array(m.clock ? m.clock.flags : 0);
  }

  private matches(row: ChipRow, d: DigitalDomain): boolean {
    const cells = row.cells;
    const n = this.inNets.length;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (c === CELL_ANY) continue;
      const v = i < n ? d.val(this.inNets[i]!) : this.flags[i - n]!;
      if (v !== c) return false;
    }
    return true;
  }

  private counter(delta: number): number {
    let v = 0;
    const f = this.flags;
    for (let i = 0; i < f.length; i++) {
      if (f[i]! > L1) return -1;
      if (f[i] === L1) v += 2 ** i;
    }
    const mod = 2 ** f.length;
    return (v + delta + mod) % mod;
  }

  private cell(tok: string, d: DigitalDomain): number {
    const m = this.m;
    const at = m.inputs.indexOf(tok);
    if (at >= 0) return d.val(this.inNets[at]!);
    if (tok[0] === "~") {
      const v = this.cell(tok.slice(1), d);
      return v === L1 ? L0 : v === L0 ? L1 : v;
    }
    if (tok[0] === "f" && tok.length > 1) {
      const op = tok[1];
      if (op === "+" || op === "-") {
        const bit = parseInt(tok.slice(2), 10);
        const count = this.counter(op === "+" ? 1 : -1);
        if (count < 0) return LX;
        return Math.floor(count / 2 ** bit) % 2 === 1 ? L1 : L0;
      }
      const k = parseInt(tok.slice(1), 10);
      if (Number.isInteger(k)) return this.flags[k] ?? LX;
    }
    switch (tok) {
      case "h":
      case "1":
        return L1;
      case "l":
      case "0":
        return L0;
      case "z":
        return LZ;
      default:
        return LX;
    }
  }

  evaluate(d: DigitalDomain, trig: number): void {
    const m = this.m;
    if (m.clock) {
      const ck = m.clock;
      const clk = d.val(this.inNets[ck.pin]!);
      const edge = !d.initMode && trig === this.inNets[ck.pin] && (ck.rising ? this.prevClk === L0 && clk === L1 : this.prevClk === L1 && clk === L0);
      this.prevClk = clk;
      const apply = (rows: ChipRow[]): void => {
        for (const row of rows) {
          if (!this.matches(row, d)) continue;
          const next = row.out.map((t) => this.cell(t, d));
          for (let i = 0; i < next.length; i++) this.flags[i] = next[i] === LZ ? LX : next[i]!;
          return;
        }
      };
      if (edge) apply(ck.sync);
      apply(ck.async);
    }
    let row: ChipRow | null = null;
    for (const r of m.table) {
      if (this.matches(r, d)) {
        row = r;
        break;
      }
    }
    const trigName = this.nameOf(trig);
    for (let i = 0; i < this.drivers.length; i++) {
      const v = row ? this.cell(row.out[i]!, d) : LX;
      let delay = trigName ? m.delays.get(`${trigName}|${m.outputs[i]}`) : undefined;
      if (!delay && this.chipDelays.size > 0) {
        const at = this.inNets.indexOf(trig);
        delay = at >= 0 ? this.chipDelays.get(`${this.inPorts[at]}|${this.outPorts[i]}`) : undefined;
      }
      const t = delay ? (v === L1 ? delay.rise : delay.fall) : CHIP_DEFAULT_DELAY;
      d.schedule(this.drivers[i]!, v, t);
    }
  }

  private nameOf(net: number): string | undefined {
    const i = this.inNets.indexOf(net);
    return i >= 0 ? this.m.inputs[i] : undefined;
  }
}

/** Create the modules of a chip with its top-level ports bound to circuit nodes. */
export function instantiateChip(c: Circuit, d: DigitalDomain, def: ChipDef, inNodes: number[], outNodes: number[], levels: LogicLevels = DEFAULT_LEVELS): void {
  const readNet = new Map<string, number>();
  const writeNode = new Map<string, number>();
  def.inputs.forEach((n, i) => {
    if (i < inNodes.length) readNet.set(n, d.inputNet(c, inNodes[i]!, levels));
  });
  def.outputs.forEach((n, i) => {
    if (i < outNodes.length) writeNode.set(n, outNodes[i]!);
  });
  const wire = new Map<string, number>();
  for (const w of def.wires) wire.set(w, d.internalNet());
  const netFor = (name: string): number => {
    const r = readNet.get(name) ?? wire.get(name);
    if (r !== undefined) return r;
    const created = d.internalNet();
    wire.set(name, created);
    return created;
  };
  for (const inst of def.instances) {
    const m = inst.module;
    const inNets = m.inputs.map((_, i) => netFor(inst.ports[i] ?? `#nc${i}`));
    const drivers = m.outputs.map((_, i) => {
      const port = inst.ports[m.inputs.length + i] ?? `#ncout${i}`;
      const node = writeNode.get(port);
      if (node !== undefined) return d.outputDriver(c, node, false, levels);
      return d.addDriver(netFor(port), STRONG);
    });
    const inPorts = m.inputs.map((_, i) => inst.ports[i] ?? "");
    const outPorts = m.outputs.map((_, i) => inst.ports[m.inputs.length + i] ?? "");
    d.addModel(new ChipUnit(m, inNets, drivers, def.delays, inPorts, outPorts));
  }
}

export { STRONG, WEAK };
