// XSPICE "a" device front end: reads port syntax and turns each model into engine devices.
// Combinational analog models become behavioural sources; stateful ones come from codemodels.ts;
// digital ones queue until every analog pin is known, because that decides which nets need bridges.

import { Circuit } from "./circuit";
import { VoltageSource } from "./devices";
import { parseNumber } from "./expr";
import { Mcu8051 } from './mcu-digital';
import { Comparator, Hysteresis, IdealSwitch, PhaseController, SquareWave, SwitchingLoss, TriggeredPwl } from "./codemodels";
import {
  Clock,
  Constant,
  DacDrive,
  DigitalDomain,
  Flop,
  Gate,
  instantiateChip,
  L0,
  DEFAULT_LEVELS,
  L1,
  LX,
  parseChip,
  Ram,
  Tristate,
  type FlopKind,
  type GateKind,
  type LogicLevels,
} from "./digital";

export interface XModel {
  readonly type: string;
  readonly name: string;
  has(key: string): boolean;
  num(key: string, fallback: number): number;
  str(key: string, fallback: string): string;
  arr(key: string): number[];
}

export interface XHost {
  c: Circuit;
  name: string;
  line: number;
  raw: string;
  /** Node index without marking an analog connection. */
  ref(node: string): number;
  /** Node index marking an analog connection. */
  pin(node: string): number;
  /** Elaborate a generated netlist card in this scope. */
  emit(text: string): void;
  /** Add a behavioural source between two named nodes. */
  behavioral(suffix: string, a: string, b: string, isVoltage: boolean, expr: string): void;
  value(tok: string): number;
}

export interface XPort {
  /** Node names per element; two names for a differential port. */
  items: string[][];
  /** Port type per element, such as v, vd, i, id, d, or empty for the model's default. */
  kinds: string[];
  vector: boolean;
}

/** Split a device card into ports, leaving the model name last. */
export function readPorts(toks: string[]): { ports: XPort[]; model: string } | null {
  const model = toks[toks.length - 1];
  if (toks.length < 3 || model === undefined) return null;
  const ports: XPort[] = [];
  let i = 1;
  const end = toks.length - 1;
  let lastKind = "";
  const readItem = (): string[] | null => {
    const t = toks[i];
    if (t === undefined) return null;
    if (t[0] !== "%") {
      i++;
      lastKind = "";
      return [t.replace(/^~/, "")];
    }
    const kind = t.slice(1);
    lastKind = kind;
    i++;
    const names: string[] = [];
    if (toks[i] === "(") {
      i++;
      while (i < end && toks[i] !== ")") names.push(toks[i++]!);
      i++;
    } else {
      const want = kind === "vd" || kind === "id" || kind === "gd" || kind === "vnam" ? 2 : 1;
      for (let k = 0; k < want && i < end; k++) names.push(toks[i++]!);
    }
    return names;
  };
  while (i < end) {
    if (toks[i] === "[") {
      i++;
      const items: string[][] = [];
      const kinds: string[] = [];
      while (i < end && toks[i] !== "]") {
        const item = readItem();
        if (item) {
          items.push(item);
          kinds.push(lastKind);
        }
      }
      i++;
      ports.push({ items, kinds, vector: true });
    } else {
      const item = readItem();
      if (item) ports.push({ items: [item], kinds: [lastKind], vector: false });
    }
  }
  return { ports, model };
}

function exprOf(item: string[]): string {
  return item.length >= 2 ? `v(${item[0]},${item[1]})` : `v(${item[0]})`;
}

function outOf(item: string[]): [string, string] {
  return [item[0]!, item[1] ?? "0"];
}

/** True when an output port is a voltage: %i and %id ports source a current instead. */
function isVolt(p: XPort): boolean {
  const k = p.kinds[0] ?? "";
  return !(k === "i" || k === "id" || k === "g" || k === "gd");
}

function num(x: number): string {
  return `(${x})`;
}

/** XSPICE pwl continues the end segments beyond the table instead of holding flat. */
function extrapolatedTable(x: string, xs: number[], ys: number[]): string {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return tableText(x, xs, ys);
  const low = (ys[1]! - ys[0]!) / (xs[1]! - xs[0]!);
  const high = (ys[n - 1]! - ys[n - 2]!) / (xs[n - 1]! - xs[n - 2]!);
  const under = `${num(low)}*min(${x}-${num(xs[0]!)},0)`;
  const over = `${num(high)}*max(${x}-${num(xs[n - 1]!)},0)`;
  return `${tableText(x, xs, ys)}+${under}+${over}`;
}

/** Piecewise-linear expression text; the host expression language has table(). */
function tableText(x: string, xs: number[], ys: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < xs.length && i < ys.length; i++) parts.push(`${xs[i]},${ys[i]}`);
  return parts.length > 0 ? `table(${x},${parts.join(",")})` : "0";
}

const GATES: Record<string, GateKind> = {
  d_and: "and", d_nand: "nand", d_or: "or", d_nor: "nor", d_xor: "xor", d_xnor: "xnor",
  d_inverter: "inverter", d_buffer: "buffer",
};

function domain(c: Circuit): DigitalDomain {
  if (!c.digital) {
    const d = new DigitalDomain();
    c.digital = d;
    c.addDevice(d);
  }
  return c.digital as DigitalDomain;
}

const flatten = (p: XPort | undefined): string[] => (p ? p.items.map((it) => it[0]!) : []);

/** Supply from a DC source on the named net, or null when the netlist has none. */
function supplyOf(c: Circuit, net: string): number | null {
  const node = c.findNode(net);
  if (node <= 0) return null;
  for (const d of c.devices) {
    if (d instanceof VoltageSource && d.a === node && d.b === 0 && !d.spec.wave && d.spec.dc > 0) return d.spec.dc;
  }
  return null;
}

/**
 * Logic levels from what a model's name says about its part and family, the only family information
 * these netlists carry for automatically bridged nets. Thresholds are typical datasheet values.
 */
export function familyLevels(c: Circuit, modelName: string): LogicLevels {
  const name = modelName.toLowerCase();
  const family = /__([a-z0-9_]+?)(?:__\d+)?$/.exec(name)?.[1] ?? "";
  const part = name.split("__")[0] ?? "";
  const supplied = /_(\d+(?:\.\d+)?)v$/.exec(family);
  const supplyInName = supplied ? parseFloat(supplied[1]!) : null;

  const isCmos = /^cmos/.test(family) || /^40\d\db/.test(part);
  const isHc = /^74h?c/.test(family) || /^74hct?\d/.test(part);
  const isTtl = !isHc && (/^74/.test(family) || /^74/.test(part));

  if (isCmos || isHc) {
    const vdd = supplyInName ?? supplyOf(c, "vdd") ?? supplyOf(c, "vcc") ?? 5;
    const schmittCmos = /^(40106|4093)/.test(part);
    const schmittHc = /^74h?ct?(14|132)/.test(part);
    const low = schmittCmos ? 0.38 * vdd : schmittHc ? 0.32 * vdd : 0.5 * vdd;
    const high = schmittCmos ? 0.58 * vdd : schmittHc ? 0.54 * vdd : 0.5 * vdd;
    return {
      low,
      high,
      hold: schmittCmos || schmittHc,
      vLow: 0,
      vHigh: vdd,
      note: `Digital levels for ${part} assumed from its ${isCmos ? "CMOS" : "74HC"} family at ${vdd} V: input ${low === high ? `threshold ${low} V` : `thresholds ${low} and ${high} V`}, outputs 0 and ${vdd} V`,
    };
  }
  if (isTtl) {
    const vcc = supplyOf(c, "vcc") ?? 5;
    const schmitt = /^74(ls|als|s|f)?(14|132|13)$/.test(part.replace(/_\d+$/, ""));
    const lowPower = /^74(ls|als)/.test(part);
    const low = schmitt ? (lowPower ? 0.8 : 0.9) : 1.4;
    const high = schmitt ? (lowPower ? 1.6 : 1.7) : 1.4;
    return {
      low,
      high,
      hold: schmitt,
      vLow: 0,
      vHigh: vcc,
      note: `Digital levels for ${part} assumed from its TTL family: input ${low === high ? `threshold ${low} V` : `thresholds ${low} and ${high} V`}, outputs 0 and ${vcc} V`,
    };
  }
  // A generic part stands for no real family, so these are simply its levels.
  if (name.endsWith("_generic")) return DEFAULT_LEVELS;
  return {
    ...DEFAULT_LEVELS,
    note: `Digital levels for model ${name} assumed: its name gives no logic family, so inputs switch at 2.5 V and outputs swing 0 to 5 V`,
  };
}

/** Build the device. Returns false when the model is not one this engine can simulate. */
export function buildXspice(h: XHost, ports: XPort[], m: XModel): boolean {
  const { c } = h;
  const type = m.type;

  const gate = GATES[type];
  if (gate) {
    const rise = m.num("rise_delay", 1e-9);
    const fall = m.num("fall_delay", 1e-9);
    if (ports.length < 2) return false;
    const inputs = flatten(ports[0]);
    const output = flatten(ports[1])[0]!;
    const inNodes = inputs.map(h.ref);
    const outNode = h.ref(output);
    c.deferred.push(() => {
      const d = domain(c);
      const levels = familyLevels(c, m.name);
      d.addModel(new Gate(inNodes.map((n) => d.inputNet(c, n, levels)), d.outputDriver(c, outNode, false, levels), gate, rise, fall));
    });
    return true;
  }

  switch (type) {
    case 'd_mcu8051': {
      if(ports.length!==2||flatten(ports[0]).length!==32||flatten(ports[1]).length!==1)throw new Error('8051: expected 32 port pins and a reset pin.');
      const program=m.str('program',''),frequency=m.num('frequency',12e6);
      if(!program.length||program.length>131072||program.length%2||!/^[\da-f]+$/i.test(program))throw new Error('8051: program must be 1–65536 hexadecimal bytes.');
      if(!Number.isFinite(frequency)||frequency<12||frequency>100e6)throw new Error('8051: oscillator must be 12 Hz–100 MHz.');
      const code=Uint8Array.from(program.match(/../g)!,b=>parseInt(b,16));
      const pins=flatten(ports[0]).map(h.ref),reset=h.ref(flatten(ports[1])[0]);
      c.deferred.push(()=>{
        const d=domain(c),clock=d.internalNet(),echo=d.addDriver(clock,2);
        const lows=pins.map(n=>d.outputDriver(c,n)),highs=pins.map((n,i)=>i<8?-1:d.outputDriver(c,n,true));
        d.addModel(new Mcu8051(clock,echo,d.inputNet(c,reset),pins.map(n=>d.inputNet(c,n)),lows,highs,12/frequency,code,d));
      });
      return true;
    }
    case "d_pulldown":
    case "d_pullup": {
      const node = h.ref(flatten(ports[0])[0]!);
      const value = type === "d_pullup" ? L1 : L0;
      c.deferred.push(() => {
        const d = domain(c);
        d.addModel(new Constant(d.outputDriver(c, node, true, familyLevels(c, m.name)), value));
      });
      return true;
    }
    case "d_constsource": {
      const node = h.ref(flatten(ports[0])[0]!);
      const value = m.num("state", 0) > 0 ? L1 : L0;
      c.deferred.push(() => {
        const d = domain(c);
        d.addModel(new Constant(d.outputDriver(c, node, false, familyLevels(c, m.name)), value));
      });
      return true;
    }
    case "d_tristate": {
      const nodes = ports.map((p) => h.ref(flatten(p)[0]!));
      const delay = m.num("delay", 1e-9);
      if (nodes.length < 3) return false;
      c.deferred.push(() => {
        const d = domain(c);
        const levels = familyLevels(c, m.name);
        d.addModel(new Tristate([d.inputNet(c, nodes[0]!, levels), d.inputNet(c, nodes[1]!, levels)], d.outputDriver(c, nodes[2]!, false, levels), delay));
      });
      return true;
    }
    case "d_clock": {
      const node = h.ref(flatten(ports[0])[0]!);
      const f = m.num("frequency", 1e3);
      const duty = m.num("duty", 0.5);
      const delay = m.num("delay", 0);
      c.deferred.push(() => {
        const d = domain(c);
        const drv = d.outputDriver(c, node);
        const net = d.internalNet();
        const echo = d.addDriver(net, 2);
        // The clock watches its own echo net, so analog bridging does not disturb its timing.
        d.addModel(new ClockEcho(drv, echo, net, duty / f, (1 - duty) / f, delay));
      });
      return true;
    }
    case "d_dff":
    case "d_tff":
    case "d_jkff":
    case "d_srff":
    case "d_dlatch":
    case "d_srlatch":
      return buildFlop(h, ports, m);
    case "d_ram": {
      if (ports.length < 5) return false;
      const dataIn = flatten(ports[0]).map(h.ref);
      const dataOut = flatten(ports[1]).map(h.ref);
      const addr = flatten(ports[2]).map(h.ref);
      const we = h.ref(flatten(ports[3])[0]!);
      const sel = flatten(ports[4]).map(h.ref);
      const selectValue = m.num("select_value", 1);
      const readDelay = m.num("read_delay", 100e-9);
      c.deferred.push(() => {
        const d = domain(c);
        const levels = familyLevels(c, m.name);
        const inNet = (n: number): number => d.inputNet(c, n, levels);
        const drivers = dataOut.map((n) => d.outputDriver(c, n, false, levels));
        d.addModel(new Ram(dataIn.map(inNet), dataOut, addr.map(inNet), inNet(we), sel.map(inNet), selectValue, readDelay, drivers));
      });
      return true;
    }
    case "d_chip": {
      if (ports.length < 2) return false;
      const text = m.has("behaviour") ? m.str("behaviour", "") : m.str("behavior", "");
      const def = parseChip(text, (tok) => parseNumber(tok) ?? 0);
      const inNodes = flatten(ports[0]).map(h.ref);
      const outNodes = flatten(ports[1]).map(h.ref);
      c.deferred.push(() => instantiateChip(c, domain(c), def, inNodes, outNodes, familyLevels(c, m.name)));
      return true;
    }
    case "adc_bridge": {
      const low = m.num("in_low", 1);
      const high = m.num("in_high", 2);
      const rise = m.num("rise_delay", 1e-9);
      const fall = m.num("fall_delay", 1e-9);
      const ins = flatten(ports[0]);
      const outs = flatten(ports[1]);
      ins.forEach((name, i) => {
        const node = h.pin(name);
        const outName = outs[i];
        if (outName === undefined) return;
        const outNode = h.ref(outName);
        c.deferred.push(() => {
          const d = domain(c);
          if (d.isPureNode(c, outNode)) {
            d.addReader(node, low, high, d.pureNetOf(c, outNode), rise, fall);
          } else {
            const net = d.internalNet();
            d.addReader(node, low, high, net, rise, fall);
            d.addModel(new Gate([net], d.outputDriver(c, outNode), "buffer", 0, 0));
          }
        });
      });
      return true;
    }
    case "dac_bridge": {
      const low = m.num("out_low", 0);
      const high = m.num("out_high", 1);
      const undef = m.num("out_undef", 0.5);
      const rise = m.num("t_rise", 1e-9);
      const fall = m.num("t_fall", 1e-9);
      const ins = flatten(ports[0]);
      const outs = flatten(ports[1]);
      ins.forEach((name, i) => {
        const inNode = h.ref(name);
        const outName = outs[i];
        if (outName === undefined) return;
        const outNode = h.pin(outName);
        c.deferred.push(() => {
          const d = domain(c);
          const drv = d.analogDriver(outNode, 1e3, low, high, undef, rise, fall);
          d.addModel(new DacDrive(d.inputNet(c, inNode), drv));
        });
      });
      return true;
    }
    case "gain": {
      const [p, n] = outOf(ports[1]!.items[0]!);
      const e = `(${exprOf(ports[0]!.items[0]!)}+${num(m.num("in_offset", 0))})*${num(m.num("gain", 1))}+${num(m.num("out_offset", 0))}`;
      h.behavioral("", p, n, isVolt(ports[1]!), e);
      return true;
    }
    case "summer":
    case "mult": {
      const inputs = ports[0]!.items;
      const offs = m.arr("in_offset");
      const gains = m.arr("in_gain");
      const terms = inputs.map((it, i) => `(${exprOf(it)}+${num(offs[i] ?? 0)})*${num(gains[i] ?? 1)}`);
      const body = terms.join(type === "mult" ? "*" : "+");
      const [p, n] = outOf(ports[1]!.items[0]!);
      h.behavioral("", p, n, isVolt(ports[1]!), `(${body})*${num(m.num("out_gain", 1))}+${num(m.num("out_offset", 0))}`);
      return true;
    }
    case "limit": {
      const [p, n] = outOf(ports[1]!.items[0]!);
      const scaled = `(${exprOf(ports[0]!.items[0]!)}+${num(m.num("in_offset", 0))})*${num(m.num("gain", 1))}`;
      h.behavioral("", p, n, isVolt(ports[1]!), `limit(${scaled},${num(m.num("out_lower_limit", 0))},${num(m.num("out_upper_limit", 1))})`);
      return true;
    }
    case "climit": {
      if (ports.length < 4) return false;
      const [p, n] = outOf(ports[3]!.items[0]!);
      const scaled = `(${exprOf(ports[0]!.items[0]!)}+${num(m.num("in_offset", 0))})*${num(m.num("gain", 1))}`;
      const hi = `${exprOf(ports[1]!.items[0]!)}-${num(m.num("upper_delta", 0))}`;
      const lo = `${exprOf(ports[2]!.items[0]!)}+${num(m.num("lower_delta", 0))}`;
      h.behavioral("", p, n, isVolt(ports[3]!), `limit(${scaled},${lo},${hi})`);
      return true;
    }
    case "pwl": {
      const xs = m.arr("x_array");
      const ys = m.arr("y_array");
      const [p, n] = outOf(ports[1]!.items[0]!);
      let x = exprOf(ports[0]!.items[0]!);
      if (/^t/.test(m.str("wrap", "false")) && xs.length > 1) {
        const span = xs[xs.length - 1]! - xs[0]!;
        x = `(${x}-${num(xs[0]!)}-${num(span)}*floor((${x}-${num(xs[0]!)})/${num(span)})+${num(xs[0]!)})`;
      }
      h.behavioral("", p, n, isVolt(ports[1]!), extrapolatedTable(x, xs, ys));
      return true;
    }
    case "s_xfer": {
      const denorm = m.num("denormalized_freq", 1);
      // Coefficients run from the highest power of s down.
      const toAscending = (a: number[]): number[] => a.slice().reverse().map((v, k) => v / denorm ** k);
      const gainK = m.num("gain", 1);
      const numer = toAscending(m.arr("num_coeff")).map((v) => v * gainK);
      const denom = toAscending(m.arr("den_coeff"));
      const [p, n] = outOf(ports[1]!.items[0]!);
      const input = `(${exprOf(ports[0]!.items[0]!)}+${num(m.num("in_offset", 0))})`;
      return emitRational(h, input, p, n, true, numer, denom);
    }
    case "hyst": {
      const inItem = ports[0]!.items[0]!;
      const [p, n] = outOf(ports[1]!.items[0]!);
      c.addDevice(new Hysteresis(h.name, h.line, h.pin(p), h.pin(n), h.ref(inItem[0]!), h.ref(inItem[1] ?? "0"),
        m.num("in_low", 0), m.num("in_high", 1), m.num("hyst", 0.1), m.num("out_lower_limit", 0), m.num("out_upper_limit", 1)));
      return true;
    }
    case "square": {
      const ctl = ports[0]!.items[0]!;
      const [p, n] = outOf(ports[1]!.items[0]!);
      c.addDevice(new SquareWave(h.name, h.line, h.pin(p), h.pin(n), h.ref(ctl[0]!), h.ref(ctl[1] ?? "0"),
        m.arr("cntl_array"), m.arr("freq_array"), m.num("out_low", -1), m.num("out_high", 1), m.num("duty_cycle", 0.5),
        m.num("rise_time", 1e-9), m.num("fall_time", 1e-9)));
      return true;
    }
    case "precision_comparator": {
      const names = ports.map((p) => p.items[0]![0]!);
      if (names.length < 3) return false;
      c.addDevice(new Comparator(h.name, h.line, h.pin(names[0]!), h.ref(names[1]!), h.ref(names[2]!),
        m.num("output_level", 5), m.num("rise_fall_time", 1e-9)));
      return true;
    }
    case "triggered_pwl": {
      const inItem = ports[0]!.items[0]!;
      const [p, n] = outOf(ports[1]!.items[0]!);
      c.addDevice(new TriggeredPwl(h.name, h.line, h.pin(p), h.pin(n), h.ref(inItem[0]!), h.ref(inItem[1] ?? "0"),
        m.arr("time_array"), m.arr("output_array"), m.num("vth", 0.5), m.str("edge", "rising"),
        /^t/.test(m.str("retriggerable", "false")), /^t/.test(m.str("repeat", "false"))));
      return true;
    }
    case "phase_angle_controller": {
      if (ports.length < 3) return false;
      const sync = ports[0]!.items[0]!;
      const alpha = ports[1]!.items[0]![0]!;
      const [p, n] = outOf(ports[2]!.items[0]!);
      c.addDevice(new PhaseController(h.name, h.line, h.pin(p), h.pin(n), h.ref(sync[0]!), h.ref(sync[1] ?? "0"), h.ref(alpha),
        m.num("freq", 60), m.num("pulse_width", 20), m.num("pulse_amplitude", 5)));
      c.warn(`Model '${type}' uses inferred behaviour: alpha and pulse width are read as degrees of the sync period`);
      return true;
    }
    case "linear_diode": {
      const names = ports.map((p) => p.items[0]![0]!);
      if (names.length < 5) return false;
      c.addDevice(new IdealSwitch(h.name, h.line, h.pin(names[0]!), h.pin(names[1]!), null, 0,
        m.num("vdrop", 0.7), m.num("ron", 1e-3), m.num("roff", 1e6), [h.pin(names[2]!), h.pin(names[3]!), h.pin(names[4]!)]));
      c.warn(`Model '${type}' uses inferred behaviour: an ideal diode with forward drop VDROP`);
      return true;
    }
    case "transistor_ideal1": {
      const names = ports.map((p) => p.items[0]![0]!);
      if (names.length < 6) return false;
      c.addDevice(new IdealSwitch(h.name, h.line, h.pin(names[0]!), h.pin(names[1]!), h.ref(names[2]!), m.num("vth", 2.5),
        m.num("vceon", 0), m.num("ron", 1e-3), m.num("roff", 1e6), [h.pin(names[3]!), h.pin(names[4]!), h.pin(names[5]!)]));
      c.warn(`Model '${type}' uses inferred behaviour: a one-way switch closed while the gate exceeds VTH`);
      return true;
    }
    case "conduction_loss_generator": {
      const names = ports.map((p) => p.items[0]![0]!);
      if (names.length < 3) return false;
      const scale = m.num("parallelscaling", 1);
      const drops = m.has("vf_array_temp1") ? m.arr("vf_array_temp1") : m.arr("vce_array_temp1");
      const curve = tableText(`abs(v(${names[2]}))`, m.arr("current_array_temp1"), drops);
      h.behavioral("", names[1]!, names[0]!, false, `${num(scale)}*abs(v(${names[2]}))*${curve}`);
      c.warn(`Model '${type}' uses inferred behaviour: loss is |i| * vce(|i|) at the first temperature table`);
      return true;
    }
    case "switching_loss_generator": {
      const names = ports.map((p) => p.items[0]![0]!);
      if (names.length < 5) return false;
      c.addDevice(new SwitchingLoss(h.name, h.line, h.pin(names[0]!), h.pin(names[1]!), h.ref(names[2]!), h.ref(names[3]!), h.ref(names[4]!),
        { i: m.arr("current_array_temp1"), on: m.arr("eon_array_temp1"), off: m.arr("eoff_array_temp1") },
        m.num("vdc_nominal", 1), m.num("parallelscaling", 1) * m.num("adjust", 1), m.num("averaging_window", 1e-3)));
      c.warn(`Model '${type}' uses inferred behaviour: energy tables in mJ, scaled by blocked voltage, averaged over the window at the first temperature table`);
      return true;
    }
    case "incremental_encoder": {
      const names = ports.map((p) => p.items[0]![0]!);
      if (names.length < 4) return false;
      const pulses = m.num("pulses_per_cycle", 100);
      const level = m.num("output_voltage", 5);
      const th = `v(${names[0]})`;
      h.behavioral("#a", names[1]!, "0", true, `${num(level)}*u(sin(${num(pulses)}*${th}))`);
      h.behavioral("#b", names[2]!, "0", true, `${num(level)}*u(cos(${num(pulses)}*${th}))`);
      const twoPi = 2 * Math.PI;
      h.behavioral("#i", names[3]!, "0", true, `${num(level)}*u(${num(twoPi / (4 * pulses))}-(${th}-${num(twoPi)}*floor(${th}/${num(twoPi)})))`);
      c.warn(`Model '${type}' uses inferred behaviour: quadrature outputs from the shaft angle in radians`);
      return true;
    }
    default:
      return false;
  }
}

class ClockEcho extends Clock {
  constructor(
    private readonly drvOut: number,
    drvEcho: number,
    net: number,
    high: number,
    low: number,
    delay: number,
  ) {
    super(net, drvEcho, high, low, delay);
  }

  override evaluate(d: DigitalDomain, trig: number): void {
    super.evaluate(d, trig);
    // The visible output repeats the echo net, which is what fires the next edge.
    const v = d.val(this.inputs[0]!);
    d.schedule(this.drvOut, v === L1 ? L1 : L0, 0);
  }
}

function buildFlop(h: XHost, ports: XPort[], m: XModel): boolean {
  const { c } = h;
  const kinds: Record<string, { kind: FlopKind; data: number }> = {
    d_dff: { kind: "d", data: 1 },
    d_tff: { kind: "t", data: 1 },
    d_jkff: { kind: "jk", data: 2 },
    d_srff: { kind: "sr", data: 2 },
    d_dlatch: { kind: "dlatch", data: 1 },
    d_srlatch: { kind: "srlatch", data: 2 },
  };
  const spec = kinds[m.type]!;
  const expected = spec.data + 5;
  if (ports.length < expected) return false;
  const nodes = ports.map((p) => h.ref(flatten(p)[0]!));
  const dataNodes = nodes.slice(0, spec.data);
  const [clk, set, reset, out, nout] = nodes.slice(spec.data, spec.data + 5) as [number, number, number, number, number];
  const clockDelay = m.has("enable_delay") ? m.num("enable_delay", 1e-9) : m.has("sr_delay") ? m.num("sr_delay", 1e-9) : m.has("data_delay") ? m.num("data_delay", 1e-9) : m.num("clk_delay", 1e-9);
  const timing = {
    clk: clockDelay,
    set: m.num("set_delay", 1e-9),
    reset: m.num("reset_delay", 1e-9),
    rise: m.num("rise_delay", 1e-9),
    fall: m.num("fall_delay", 1e-9),
  };
  const icv = m.num("ic", 0);
  const ic = icv === 1 ? L1 : icv === 0 ? L0 : LX;
  c.deferred.push(() => {
    const d = domain(c);
    const levels = familyLevels(c, m.name);
    const inNet = (n: number): number => d.inputNet(c, n, levels);
    d.addModel(new Flop(spec.kind, dataNodes.map(inNet), inNet(clk), inNet(set), inNet(reset), d.outputDriver(c, out, false, levels), d.outputDriver(c, nout, false, levels), timing, ic));
  });
  return true;
}

/**
 * Realise a rational transfer function in controllable canonical form from generated primitives.
 * Coefficients are ascending powers of s. Time is scaled by the natural frequency, so the state
 * nodes stay near the input's magnitude and truncation error control treats them sensibly.
 */
export function emitRational(
  h: XHost,
  input: string,
  outP: string,
  outN: string,
  isVoltage: boolean,
  numer: number[],
  denom: number[],
): boolean {
  const trim = (a: number[]): number[] => {
    const b = a.slice();
    while (b.length > 1 && b[b.length - 1] === 0) b.pop();
    return b;
  };
  const den = trim(denom);
  const nu = trim(numer);
  const order = den.length - 1;
  if (nu.length > den.length || den[order] === 0 || den.length === 0) return false;
  if (order === 0) {
    h.behavioral("", outP, outN, isVoltage, `${input}*${num((nu[0] ?? 0) / den[0]!)}`);
    return true;
  }
  const a0 = Math.abs(den[0]!) > 0 ? Math.abs(den[0]!) : 1;
  const w0 = Math.pow(a0 / Math.abs(den[order]!), 1 / order);
  const scaledDen = den.map((v, k) => (v * w0 ** k) / (den[order]! * w0 ** order));
  const scaledNum = den.map((_, k) => ((nu[k] ?? 0) * w0 ** k) / (den[order]! * w0 ** order));
  const state = (k: number): string => `${h.name}#z${k}`.replace(/\./g, "_");
  const cap = 1 / w0;
  for (let k = 1; k <= order; k++) {
    h.emit(`c#${state(k)} ${state(k)} 0 ${cap}`);
    let rate: string;
    if (k < order) {
      rate = `v(${state(k + 1)})`;
    } else {
      const terms = [`${input}`];
      for (let j = 1; j <= order; j++) terms.push(`-${num(scaledDen[j - 1]!)}*v(${state(j)})`);
      rate = terms.join("");
    }
    h.behavioral(`#dz${k}`, "0", state(k), false, rate);
  }
  const feed = scaledNum[order]!;
  const outTerms = [`${num(feed)}*${input}`];
  for (let j = 1; j <= order; j++) outTerms.push(`${num(scaledNum[j - 1]! - feed * scaledDen[j - 1]!)}*v(${state(j)})`);
  h.behavioral("", outP, outN, isVoltage, outTerms.join("+"));
  return true;
}
