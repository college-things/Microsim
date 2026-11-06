import type { Mcu8051 } from './mcu-digital';
import type { UartTx } from './uart-tx';
// Shared simulation state read and written by device models.

import { SparseMatrix } from "./sparse";

export const MODE_DC = 0;
export const MODE_TRAN = 1;
/** Consistent t=0 solve under UIC: capacitors hold their voltage, inductors their current. */
export const MODE_UIC = 2;

/** Norton conductance used to hold a node at a value for .ic, .nodeset and UIC. */
export const G_CLAMP = 1e9;

/** Series resistance of an inductor in DC, so an inductor loop or a source across an inductor stays solvable. */
export const R_INDUCTOR_DC = 1e-6;

/** Receives one noise current source between two nodes, with its density in A^2/Hz. */
export type NoiseSink = (device: string, a: number, b: number, psd: number) => void;

/** Boltzmann constant and electron charge, for the noise formulas. */
export const BOLTZMANN = 1.380649e-23;
export const CHARGE = 1.602176634e-19;

export abstract class Device {
  linear = true;
  needsAccept = false;
  /** Branch current unknown, 0 if none. */
  branch = 0;

  constructor(readonly name: string, readonly line: number) {}

  /** Create internal nodes and branch unknowns. */
  allocate(_c: Circuit): void {}
  /** Resolve references and take matrix slots and state storage. */
  abstract setup(c: Circuit): void;
  /** Stamp the Newton linearisation at c.x. */
  abstract load(c: Circuit): void;
  /** Stamp small-signal G into c.vals and B (at omega = 1) into c.imag. */
  abstract loadAc(c: Circuit): void;
  /** Report noise sources at frequency f, using values from the last load. */
  noise(_f: number, _sink: NoiseSink): void {}
  /** The two nodes this device holds together at DC by a resistance or a set voltage, if any. */
  dcPath(): [number, number] | null {
    return null;
  }
  /** Take over the state that outlives a solve from the same device in an earlier circuit. */
  copyState(_old: Device): void {}
  /** Commit an accepted solution. */
  accept(_c: Circuit): void {}
  /** True when checkEvent can report a state change inside a step. */
  hasEvents = false;
  /** Earliest state change in (t0, t1] given the candidate c.x, Infinity if none. */
  checkEvent(_c: Circuit, _xPrev: Float64Array, _t0: number, _t1: number): number {
    return Infinity;
  }
  /** Move terminal a to node n so a series sense source can measure this device's current. */
  retargetA(_n: number): boolean {
    return false;
  }
  /** The node terminal a used before retargeting. */
  senseNode(): number {
    return this.savedA;
  }
  protected savedA = 0;
  /** Next waveform corner after t, Infinity if none. */
  nextBreak(_t: number, _eps: number): number {
    return Infinity;
  }
}

/** The event-driven digital domain, as the analog solver sees it. */
export interface DigitalHook {
  settle(c: Circuit): boolean;
  arm(c: Circuit): void;
  process(c: Circuit, t: number, eps: number): boolean;
  softBreak(t: number, eps: number): number;
  /** True when the other domain has the same nets, drivers and models, in the same order. */
  sameStructure(other: DigitalHook): boolean;
  /** Take over net values, model state and pending events from the same domain in an earlier circuit. */
  copyStateFrom(other: DigitalHook): void;
  /** Evaluate every model at time t with the current values, after parameters changed. */
  resume(c: Circuit, t: number): void;
  /** Events processed since the last call, counted against the run's work budget. */
  takeEvents(): number;
}

export interface Clamp {
  node: number;
  value: number;
}

export class Circuit {
  // Unknown table. Index 0 is ground.
  readonly names: string[] = ["0"];
  readonly isNode: boolean[] = [true];
  readonly isTopNode: boolean[] = [true];
  readonly pins: number[] = [0];
  private readonly nodeMap = new Map<string, number>();

  readonly devices: Device[] = [];
  readonly named = new Map<string, Device>();
  /** Serial inputs a live run can type into, by lower-case instance name. */
  readonly serialInputs = new Map<string, UartTx>();
  /** Microcontrollers a debugger can reach, by lower-case instance name. */
  readonly mcus = new Map<string, Mcu8051>();
  /** Set by a microcontroller that has stopped for its debugger; a live run halts until it is cleared. */
  haltRequested: string | undefined;
  readonly warnings: string[] = [];
  private readonly warned = new Set<string>();

  n = 0;
  mat: SparseMatrix = new SparseMatrix(0);
  vals: Float64Array = new Float64Array(0);
  imag: Float64Array = new Float64Array(0);
  x: Float64Array = new Float64Array(1);
  xNew: Float64Array = new Float64Array(1);
  rhs: Float64Array = new Float64Array(1);
  acRe: Float64Array = new Float64Array(1);
  acIm: Float64Array = new Float64Array(1);

  // Reactive state: [q, i] pairs for current (0) and previous two accepted points.
  private stateCount = 0;
  st0: Float64Array = new Float64Array(0);
  st1: Float64Array = new Float64Array(0);
  st2: Float64Array = new Float64Array(0);

  mode = MODE_DC;
  ag0 = 0;
  trapF = 0;
  t = 0;
  /** True when sources follow their time waveform; false uses the DC value. */
  tranSources = false;
  srcFactor = 1;
  iter = 0;
  noncon = 0;
  initJct = false;
  /** Set by a device on accept when its state jumped, so integration restarts. */
  discontinuity = false;
  /** Circuit temperature in Celsius. */
  temp = 27;
  digital: DigitalHook | null = null;
  /** Work queued during elaboration until every analog pin is known. */
  readonly deferred: (() => void)[] = [];
  /** Nominal temperature for models that do not state one, Celsius. */
  tnom = 27;
  /** Nodes that hold a logic level, excluded from truncation error control. */
  readonly digitalNodes = new Set<number>();
  /** Every node reference made while reading the netlist, in order: the circuit's connectivity. */
  readonly nodeLog: number[] = [];
  /** Set while re-seeding reactive state after a live update, so integrals keep their value. */
  reseeding = false;
  /** Device names referenced by i(), which may need a sense source. */
  readonly sensed = new Set<string>();

  reltol = 1e-3;
  abstol = 1e-12;
  vntol = 1e-6;
  gmin = 1e-12;
  itl1 = 100;
  itl4 = 15;

  /** Node initial conditions from .ic, in solve order. */
  ics: Clamp[] = [];
  nodesets: Clamp[] = [];

  /** True when a .ic statement fixes this node. */
  icNode(node: number): boolean {
    if (node === 0) return false;
    for (let i = 0; i < this.ics.length; i++) if (this.ics[i]!.node === node) return true;
    return false;
  }

  warn(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.warnings.push(msg);
  }

  /** Index of a named node, created on first use. Node names are lower case. */
  node(name: string, top: boolean): number {
    let id = this.nodeMap.get(name);
    if (id === undefined) {
      id = this.addUnknown(name, true);
      this.isTopNode[id] = top;
      this.nodeMap.set(name, id);
    }
    return id;
  }

  /** Internal device node, kept out of result vectors. */
  internalNode(name: string): number {
    return this.addUnknown(name, true);
  }

  branchUnknown(name: string): number {
    return this.addUnknown(`i(${name})`, false);
  }

  private addUnknown(name: string, isNode: boolean): number {
    const id = this.names.length;
    this.names.push(name);
    this.isNode.push(isNode);
    this.isTopNode.push(false);
    this.pins.push(0);
    return id;
  }

  addDevice(d: Device): void {
    this.devices.push(d);
    this.named.set(d.name, d);
  }

  allocState(count: number): number {
    const o = this.stateCount;
    this.stateCount += count;
    return o;
  }

  /** Index of an existing named node, 0 for ground, or -1 when unknown. */
  findNode(name: string): number {
    if (name === "0" || name === "gnd" || name === "gnd!") return 0;
    return this.nodeMap.get(name) ?? -1;
  }

  /** True when the other circuit differs from this one in values at most. */
  sameStructure(o: Circuit): boolean {
    const same = <T>(a: readonly T[], b: readonly T[]): boolean => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    if (!same(this.names, o.names) || !same(this.isNode, o.isNode) || !same(this.nodeLog, o.nodeLog)) return false;
    if (this.devices.length !== o.devices.length) return false;
    for (let i = 0; i < this.devices.length; i++) {
      const a = this.devices[i]!;
      const b = o.devices[i]!;
      if (a.name !== b.name || a.constructor !== b.constructor) return false;
    }
    if (!same(this.mat.slotRow, o.mat.slotRow) || !same(this.mat.slotCol, o.mat.slotCol)) return false;
    if (this.st0.length !== o.st0.length) return false;
    if ((this.digital === null) !== (o.digital === null)) return false;
    return this.digital === null || this.digital.sameStructure(o.digital!);
  }

  /** Name an unknown for messages. */
  unknownName(i: number): string {
    if (i <= 0 || i >= this.names.length) return "unknown";
    return this.isNode[i] ? `v(${this.names[i]})` : this.names[i]!;
  }

  /** Allocate branches and slots after elaboration. */
  build(): void {
    for (const d of this.devices) d.allocate(this);
    this.n = this.names.length - 1;
    this.mat = new SparseMatrix(this.n);
    this.mat.isNode = (i) => this.isNode[i] === true;
    for (const d of this.devices) d.setup(this);
    const tied = this.nodesTiedToGround();
    const all: number[] = [];
    const floating: number[] = [];
    for (let i = 1; i <= this.n; i++) {
      if (!this.isNode[i]) continue;
      const slot = this.mat.slot(i, i);
      all.push(slot);
      if (!tied[i]) floating.push(slot);
    }
    this.nodeSlots = Int32Array.from(all);
    this.gminSlots = Int32Array.from(floating);
    this.mat.freeze();
    this.vals = this.mat.re;
    this.imag = this.mat.im;
    const size = this.n + 1;
    this.x = new Float64Array(size);
    this.xNew = new Float64Array(size);
    this.rhs = new Float64Array(size);
    this.acRe = new Float64Array(size);
    this.acIm = new Float64Array(size);
    this.st0 = new Float64Array(this.stateCount);
    this.st1 = new Float64Array(this.stateCount);
    this.st2 = new Float64Array(this.stateCount);
  }

  /** The diagonal of every node, which GMIN stepping raises to help a hard solve along. */
  nodeSlots: Int32Array = new Int32Array(0);
  /**
   * The diagonal of the nodes GMIN applies to. A linear circuit only needs it where a node has no
   * DC path to ground, and on any other node it would read wrong beside a large resistor. Circuits
   * with semiconductors keep it everywhere: many settle on values that depend on it.
   */
  gminSlots: Int32Array = new Int32Array(0);

  /** Which unknowns reach ground through devices with a dcPath. Nothing does in a nonlinear circuit. */
  private nodesTiedToGround(): boolean[] {
    if (this.digital || this.devices.some((d) => !d.linear)) return [];
    const parent = Array.from({ length: this.n + 1 }, (_, i) => i);
    const root = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
      return i;
    };
    for (const d of this.devices) {
      const path = d.dcPath();
      if (path) parent[root(path[0])] = root(path[1]);
    }
    return parent.map((_, i) => root(i) === root(0));
  }

  /** Record charge q in state pair o and return the integrated current. */
  integ(o: number, q: number): number {
    const st1 = this.st1;
    const i = this.ag0 * (q - st1[o]!) - this.trapF * st1[o + 1]!;
    this.st0[o] = q;
    this.st0[o + 1] = i;
    return i;
  }
}
