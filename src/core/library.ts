// Built-in parts. Symbols and generic device models are original to this project.
import type { Graphic, InstrumentKind, Pin } from "./schematic";

export interface ParamDef {
  key: string;
  label: string;
  default: string;
  /** Limits the value to a fixed list in the properties panel. */
  options?: string[];
  /** Free text such as a model name, not a number. */
  text?: boolean;
}

export interface PartDef {
  kind: string;
  name: string;
  category: "Sources" | "Basic" | "Diodes" | "Transistors" | "Analog" | "Digital" | "Instruments";
  prefix: string;
  pins: Pin[];
  params: ParamDef[];
  /** Tokens as described on SchComponent.spice. */
  spice: string;
  /** Shared .model or .subckt text, added once per netlist. */
  definitions?: string;
  graphics: Graphic[];
  /** Param shown beside the symbol. */
  valueParam?: string;
  instrument?: InstrumentKind;
}

const line = (...c: number[]): Graphic => {
  const points = [];
  for (let i = 0; i < c.length; i += 2) points.push({ x: c[i], y: c[i + 1] });
  return { kind: "line", points };
};
const poly = (filled: boolean, ...c: number[]): Graphic => {
  const points = [];
  for (let i = 0; i < c.length; i += 2) points.push({ x: c[i], y: c[i + 1] });
  return { kind: "polygon", points, filled };
};
const circle = (cx: number, cy: number, r: number, filled = false): Graphic => ({
  kind: "ellipse", cx, cy, rx: r, ry: r, filled,
});
const text = (x: number, y: number, t: string, size = 10): Graphic => ({ kind: "text", x, y, text: t, size });
const rect = (x: number, y: number, w: number, h: number): Graphic => ({ kind: "rect", x, y, w, h, filled: false });

const twoPin: Pin[] = [{ name: "1", x: -30, y: 0 }, { name: "2", x: 30, y: 0 }];
const vertical: Pin[] = [{ name: "p", x: 0, y: -30 }, { name: "n", x: 0, y: 30 }];

const sourceBody = [line(0, -30, 0, -15), line(0, 15, 0, 30), circle(0, 0, 15)];
const diodeBody = [line(-30, 0, -8, 0), line(8, 0, 30, 0), poly(false, -8, -8, -8, 8, 8, 0), line(8, -8, 8, 8)];
const anodeCathode: Pin[] = [{ name: "A", x: -30, y: 0 }, { name: "K", x: 30, y: 0 }];

const bipolar = (arrow: Graphic): Graphic[] => [
  circle(5, 0, 19), line(-30, 0, -5, 0), line(-5, -12, -5, 12),
  line(-5, -6, 20, -30), line(-5, 6, 20, 30), arrow,
];
const mos = (arrow: Graphic): Graphic[] => [
  circle(3, 0, 20), line(-30, 0, -8, 0), line(-8, -10, -8, 10), line(-3, -13, -3, -5), line(-3, -3, -3, 3),
  line(-3, 5, -3, 13), line(-3, -9, 20, -9, 20, -30), line(-3, 9, 20, 9, 20, 30), line(-3, 0, 20, 0, 20, 9), arrow,
];
const threeLead: Pin[] = [{ name: "C", x: 20, y: -30 }, { name: "B", x: -30, y: 0 }, { name: "E", x: 20, y: 30 }];
const fetLead: Pin[] = [{ name: "D", x: 20, y: -30 }, { name: "G", x: -30, y: 0 }, { name: "S", x: 20, y: 30 }];

const instrumentBox = (label: string, w: number, h: number): Graphic[] => [rect(-w / 2, -h / 2, w, h), text(0, 3, label, 9)];

const twoInput: Pin[] = [{ name: "a", x: -30, y: -10 }, { name: "b", x: -30, y: 10 }, { name: "y", x: 30, y: 0 }];
const gateBox = (label: string): Graphic[] => [
  rect(-18, -18, 36, 36), text(0, 1, label, 9), line(-30, -10, -18, -10), line(-30, 10, -18, 10), line(18, 0, 30, 0),
];
const gate = (kind: string, name: string, model: string, label: string): PartDef => ({
  kind, name, category: "Digital", prefix: "U", pins: twoInput, params: [],
  spice: `a{ref} [{pin:a} {pin:b}] {pin:y} ${model.toUpperCase()}_GENERIC`,
  definitions: `.model ${model.toUpperCase()}_GENERIC ${model}(rise_delay=10n fall_delay=10n)`,
  graphics: gateBox(label),
});

export const PARTS: PartDef[] = [
  {
    kind: "ground", name: "Ground", category: "Sources", prefix: "GND",
    pins: [{ name: "g", x: 0, y: -10, net: "0" }], params: [], spice: "",
    graphics: [line(0, -10, 0, 0), line(-12, 0, 12, 0), line(-7, 5, 7, 5), line(-3, 10, 3, 10)],
  },
  {
    kind: "vcc", name: "Supply rail", category: "Sources", prefix: "VCC",
    pins: [{ name: "p", x: 0, y: 10 }],
    params: [{ key: "value", label: "Voltage", default: "5" }],
    spice: "V{ref} {pin:p} 0 DC {param:value}", valueParam: "value",
    graphics: [line(0, 10, 0, -5), line(-10, -5, 10, -5)],
  },
  {
    kind: "vdc", name: "DC voltage", category: "Sources", prefix: "V", pins: vertical,
    params: [{ key: "value", label: "Voltage", default: "12" }],
    spice: "{ref} {pin:p} {pin:n} DC {param:value}", valueParam: "value",
    graphics: [...sourceBody, text(0, -5, "+"), text(0, 9, "-")],
  },
  {
    kind: "vsin", name: "AC voltage", category: "Sources", prefix: "V", pins: vertical,
    params: [
      { key: "amp", label: "Peak", default: "1" }, { key: "freq", label: "Frequency", default: "1k" },
      { key: "offset", label: "Offset", default: "0" }, { key: "phase", label: "Phase (deg)", default: "0" },
      { key: "acmag", label: "AC analysis magnitude", default: "1" },
    ],
    spice: "{ref} {pin:p} {pin:n} DC {param:offset} AC {param:acmag} SIN({param:offset} {param:amp} {param:freq} 0 0 {param:phase})",
    valueParam: "amp",
    graphics: [...sourceBody, line(-9, 0, -6, -5, -3, -6, 0, 0, 3, 6, 6, 5, 9, 0)],
  },
  {
    kind: "vpulse", name: "Pulse voltage", category: "Sources", prefix: "V", pins: vertical,
    params: [
      { key: "v1", label: "Low", default: "0" }, { key: "v2", label: "High", default: "5" },
      { key: "delay", label: "Delay", default: "0" }, { key: "rise", label: "Rise", default: "1u" },
      { key: "fall", label: "Fall", default: "1u" }, { key: "width", label: "Width", default: "0.5m" },
      { key: "period", label: "Period", default: "1m" },
    ],
    spice: "{ref} {pin:p} {pin:n} PULSE({param:v1} {param:v2} {param:delay} {param:rise} {param:fall} {param:width} {param:period})",
    valueParam: "v2",
    graphics: [...sourceBody, line(-9, 5, -4, 5, -4, -5, 4, -5, 4, 5, 9, 5)],
  },
  {
    kind: "idc", name: "DC current", category: "Sources", prefix: "I", pins: vertical,
    params: [{ key: "value", label: "Current", default: "1m" }],
    spice: "{ref} {pin:p} {pin:n} DC {param:value}", valueParam: "value",
    graphics: [...sourceBody, line(0, -8, 0, 8), poly(true, -4, 3, 4, 3, 0, 9)],
  },
  {
    kind: "resistor", name: "Resistor", category: "Basic", prefix: "R", pins: twoPin,
    params: [{ key: "value", label: "Resistance", default: "1k" }],
    spice: "{ref} {pin:1} {pin:2} {param:value}", valueParam: "value",
    graphics: [line(-30, 0, -20, 0, -16, -7, -8, 7, 0, -7, 8, 7, 16, -7, 20, 0, 30, 0)],
  },
  {
    kind: "capacitor", name: "Capacitor", category: "Basic", prefix: "C", pins: twoPin,
    params: [{ key: "value", label: "Capacitance", default: "1u" }],
    spice: "{ref} {pin:1} {pin:2} {param:value}", valueParam: "value",
    graphics: [line(-30, 0, -4, 0), line(4, 0, 30, 0), line(-4, -11, -4, 11), line(4, -11, 4, 11)],
  },
  {
    kind: "inductor", name: "Inductor", category: "Basic", prefix: "L", pins: twoPin,
    params: [{ key: "value", label: "Inductance", default: "1m" }],
    spice: "{ref} {pin:1} {pin:2} {param:value}", valueParam: "value",
    graphics: [line(-30, 0, -20, 0, -18, -6, -13, -8, -10, -6, -10, 0, -8, -6, -3, -8, 0, -6, 0, 0, 2, -6, 7, -8, 10, -6, 10, 0, 12, -6, 17, -8, 20, 0, 30, 0)],
  },
  {
    kind: "switch", name: "Switch", category: "Basic", prefix: "S", pins: twoPin,
    params: [{ key: "state", label: "Position", default: "open", options: ["open", "closed"] }],
    spice: "", valueParam: "state",
    graphics: [line(-30, 0, -12, 0), line(12, 0, 30, 0), line(-12, 0, 10, -11), circle(-12, 0, 2), circle(12, 0, 2)],
  },
  {
    kind: "potentiometer", name: "Potentiometer", category: "Basic", prefix: "R",
    pins: [{ name: "1", x: -30, y: 0 }, { name: "2", x: 30, y: 0 }, { name: "w", x: 0, y: -30 }],
    params: [{ key: "value", label: "Total resistance", default: "10k" }, { key: "percent", label: "Setting (%)", default: "50" }],
    spice: "", valueParam: "value",
    graphics: [line(-30, 0, -20, 0, -16, -7, -8, 7, 0, -7, 8, 7, 16, -7, 20, 0, 30, 0), line(0, -30, 0, -9), poly(true, -4, -13, 4, -13, 0, -7)],
  },
  {
    kind: "vswitch", name: "Voltage-controlled switch", category: "Basic", prefix: "S",
    pins: [
      { name: "1", x: -30, y: 0 }, { name: "2", x: 30, y: 0 },
      { name: "cp", x: -10, y: 30 }, { name: "cn", x: 10, y: 30 },
    ],
    params: [],
    spice: "{ref} {pin:1} {pin:2} {pin:cp} {pin:cn} SW_GENERIC",
    definitions: ".model SW_GENERIC SW(VT=2.5 VH=0.1 RON=1 ROFF=1e7)",
    graphics: [line(-30, 0, -12, 0), line(12, 0, 30, 0), line(-12, 0, 10, -9), circle(-12, 0, 2), circle(12, 0, 2), line(-10, 30, -10, 8), line(10, 30, 10, 8), rect(-13, 8, 26, 6)],
  },
  {
    kind: "transformer", name: "Transformer", category: "Basic", prefix: "T",
    pins: [
      { name: "p1", x: -30, y: -20 }, { name: "p2", x: -30, y: 20 },
      { name: "s1", x: 30, y: -20 }, { name: "s2", x: 30, y: 20 },
    ],
    params: [
      { key: "lp", label: "Primary inductance", default: "10m" },
      { key: "ls", label: "Secondary inductance", default: "1m" },
      { key: "k", label: "Coupling", default: "0.999" },
    ],
    spice: "L{ref}P {pin:p1} {pin:p2} {param:lp}\nL{ref}S {pin:s1} {pin:s2} {param:ls}\nK{ref} L{ref}P L{ref}S {param:k}",
    graphics: [
      line(-30, -20, -8, -20, -8, 20, -30, 20), line(30, -20, 8, -20, 8, 20, 30, 20),
      line(-2, -20, -2, 20), line(2, -20, 2, 20),
    ],
  },
  {
    kind: "diode", name: "Diode", category: "Diodes", prefix: "D", pins: anodeCathode, params: [],
    spice: "{ref} {pin:A} {pin:K} D_GENERIC",
    definitions: ".model D_GENERIC D(IS=4n N=1.8 RS=0.5 CJO=4p TT=5n BV=100 IBV=100n)",
    graphics: diodeBody,
  },
  {
    kind: "zener", name: "Zener diode", category: "Diodes", prefix: "D", pins: anodeCathode, params: [],
    spice: "{ref} {pin:A} {pin:K} DZ_GENERIC",
    definitions: ".model DZ_GENERIC D(IS=1n N=1.5 RS=2 CJO=50p BV=5.1 IBV=5m)",
    graphics: [...diodeBody, line(8, -8, 4, -11), line(8, 8, 12, 11)],
  },
  {
    kind: "led", name: "LED", category: "Diodes", prefix: "D", pins: anodeCathode, params: [],
    spice: "{ref} {pin:A} {pin:K} DLED_GENERIC",
    definitions: ".model DLED_GENERIC D(IS=1e-18 N=1.9 RS=3 CJO=20p BV=5 IBV=10u)",
    graphics: [...diodeBody, line(2, -13, 9, -20), line(8, -11, 15, -18)],
  },
  {
    kind: "npn", name: "NPN transistor", category: "Transistors", prefix: "Q", pins: threeLead, params: [],
    spice: "{ref} {pin:C} {pin:B} {pin:E} NPN_GENERIC",
    definitions: ".model NPN_GENERIC NPN(IS=10f BF=200 VAF=100 CJE=8p CJC=4p TF=400p TR=50n RB=10 RC=1)",
    graphics: bipolar(poly(true, 20, 30, 13, 19, 8, 25)),
  },
  {
    kind: "pnp", name: "PNP transistor", category: "Transistors", prefix: "Q", pins: threeLead, params: [],
    spice: "{ref} {pin:C} {pin:B} {pin:E} PNP_GENERIC",
    definitions: ".model PNP_GENERIC PNP(IS=10f BF=150 VAF=80 CJE=10p CJC=5p TF=500p TR=60n RB=10 RC=1)",
    graphics: bipolar(poly(true, -5, 6, 7, 12, 2, 18)),
  },
  {
    kind: "nmos", name: "N-channel MOSFET", category: "Transistors", prefix: "M", pins: fetLead,
    params: [{ key: "w", label: "Width", default: "10u" }, { key: "l", label: "Length", default: "1u" }],
    spice: "{ref} {pin:D} {pin:G} {pin:S} {pin:S} NMOS_GENERIC W={param:w} L={param:l}",
    definitions: ".model NMOS_GENERIC NMOS(VTO=1 KP=100u LAMBDA=0.02 CGSO=1n CGDO=1n)",
    graphics: mos(poly(true, -3, 0, 5, -3, 5, 3)),
  },
  {
    kind: "pmos", name: "P-channel MOSFET", category: "Transistors", prefix: "M", pins: fetLead,
    params: [{ key: "w", label: "Width", default: "20u" }, { key: "l", label: "Length", default: "1u" }],
    spice: "{ref} {pin:D} {pin:G} {pin:S} {pin:S} PMOS_GENERIC W={param:w} L={param:l}",
    definitions: ".model PMOS_GENERIC PMOS(VTO=-1 KP=50u LAMBDA=0.02 CGSO=1n CGDO=1n)",
    graphics: mos(poly(true, 12, 0, 4, -3, 4, 3)),
  },
  {
    kind: "njfet", name: "N-channel JFET", category: "Transistors", prefix: "J", pins: fetLead, params: [],
    spice: "{ref} {pin:D} {pin:G} {pin:S} NJF_GENERIC",
    definitions: ".model NJF_GENERIC NJF(VTO=-2 BETA=1m LAMBDA=0.01 IS=10f)",
    graphics: [circle(3, 0, 20), line(-30, 0, -5, 0), line(-5, -13, -5, 13), line(-5, -9, 20, -9, 20, -30), line(-5, 9, 20, 9, 20, 30), poly(true, -5, 0, -13, -3, -13, 3)],
  },
  {
    kind: "opamp", name: "Op-amp", category: "Analog", prefix: "U",
    pins: [{ name: "+", x: -30, y: -10 }, { name: "-", x: -30, y: 10 }, { name: "out", x: 30, y: 0 }],
    params: [
      { key: "gain", label: "Open-loop gain", default: "200k" },
      { key: "vsat", label: "Output limit (+/-)", default: "13.5" },
    ],
    spice: "X{ref} {pin:+} {pin:-} {pin:out} OPAMP_GENERIC params: gain={param:gain} vsat={param:vsat}",
    definitions: [
      ".subckt OPAMP_GENERIC inp inn out params: gain=200k vsat=13.5",
      "Rin inp inn 2meg",
      "B1 o1 0 V={vsat}*tanh({gain}*(v(inp)-v(inn))/{vsat})",
      "Rout o1 out 75",
      ".ends",
    ].join("\n"),
    graphics: [
      poly(false, -18, -20, -18, 20, 18, 0), line(-30, -10, -18, -10), line(-30, 10, -18, 10), line(18, 0, 30, 0),
      text(-12, -7, "+"), text(-12, 13, "-"),
    ],
  },
  {
    kind: "subcircuit", name: "SPICE model block", category: "Analog", prefix: "X",
    pins: [
      { name: "1", x: -30, y: -10 }, { name: "2", x: -30, y: 10 },
      { name: "3", x: 30, y: -10 }, { name: "4", x: 30, y: 10 },
    ],
    params: [{ key: "model", label: "Subcircuit name", default: "MY_MODEL", text: true }],
    spice: "{ref} {pin:1} {pin:2} {pin:3} {pin:4} {param:model}", valueParam: "model",
    graphics: [rect(-18, -20, 36, 40), text(0, 1, "SUB", 9), line(-30, -10, -18, -10), line(-30, 10, -18, 10), line(18, -10, 30, -10), line(18, 10, 30, 10)],
  },
  gate("and", "AND gate", "d_and", "AND"),
  gate("or", "OR gate", "d_or", "OR"),
  gate("nand", "NAND gate", "d_nand", "NAND"),
  gate("nor", "NOR gate", "d_nor", "NOR"),
  gate("xor", "XOR gate", "d_xor", "XOR"),
  {
    kind: "not", name: "Inverter", category: "Digital", prefix: "U",
    pins: [{ name: "a", x: -30, y: 0 }, { name: "y", x: 30, y: 0 }], params: [],
    spice: "a{ref} {pin:a} {pin:y} D_INVERTER_GENERIC",
    definitions: ".model D_INVERTER_GENERIC d_inverter(rise_delay=10n fall_delay=10n)",
    graphics: [poly(false, -14, -13, -14, 13, 10, 0), circle(14, 0, 4), line(-30, 0, -14, 0), line(18, 0, 30, 0)],
  },
  {
    kind: "dff", name: "D flip-flop", category: "Digital", prefix: "U",
    pins: [{ name: "D", x: -35, y: -15 }, { name: "CLK", x: -35, y: 15 }, { name: "Q", x: 35, y: -15 }, { name: "QN", x: 35, y: 15 }],
    params: [],
    spice: "a{ref} {pin:D} {pin:CLK} NULL NULL {pin:Q} {pin:QN} D_DFF_GENERIC",
    definitions: ".model D_DFF_GENERIC d_dff(clk_delay=10n set_delay=10n reset_delay=10n)",
    graphics: [
      rect(-22, -26, 44, 52), text(-13, -15, "D", 9), text(-10, 15, ">", 9), text(13, -15, "Q", 9), text(11, 15, "/Q", 9),
      line(-35, -15, -22, -15), line(-35, 15, -22, 15), line(22, -15, 35, -15), line(22, 15, 35, 15),
    ],
  },
  {
    kind: "clock", name: "Logic clock", category: "Digital", prefix: "V",
    pins: [{ name: "p", x: 30, y: 0 }, { name: "n", x: -10, y: 30, net: "0" }],
    params: [{ key: "freq", label: "Frequency", default: "1k" }, { key: "high", label: "High level", default: "5" }],
    spice: "", instrument: "clock",
    graphics: [rect(-20, -16, 40, 32), line(-14, 6, -7, 6, -7, -6, 3, -6, 3, 6, 13, 6), line(20, 0, 30, 0), line(-10, 16, -10, 30)],
  },
  {
    kind: "function-generator", name: "Function generator", category: "Instruments", prefix: "XFG",
    pins: [{ name: "p", x: -10, y: 25 }, { name: "n", x: 10, y: 25 }],
    params: [
      { key: "shape", label: "Waveform", default: "sine", options: ["sine", "square", "triangle"] },
      { key: "freq", label: "Frequency", default: "1k" }, { key: "amp", label: "Amplitude", default: "1" },
      { key: "offset", label: "Offset", default: "0" }, { key: "duty", label: "Duty cycle (%)", default: "50" },
    ],
    spice: "", instrument: "function-generator",
    graphics: [...instrumentBox("GEN", 44, 34), line(-10, 17, -10, 25), line(10, 17, 10, 25)],
  },
  {
    kind: "oscilloscope", name: "Oscilloscope", category: "Instruments", prefix: "XSC",
    pins: [{ name: "A", x: -15, y: 30 }, { name: "B", x: 15, y: 30 }, { name: "G", x: 35, y: 0 }],
    params: [], spice: "", instrument: "oscilloscope",
    graphics: [...instrumentBox("SCOPE", 56, 40), line(-15, 20, -15, 30), line(15, 20, 15, 30), line(28, 0, 35, 0)],
  },
  {
    kind: "multimeter", name: "Multimeter", category: "Instruments", prefix: "XMM",
    pins: [{ name: "p", x: -10, y: 25 }, { name: "n", x: 10, y: 25 }],
    params: [
      { key: "mode", label: "Mode", default: "volts", options: ["volts", "amps", "ohms"] },
      { key: "coupling", label: "Reading", default: "dc", options: ["dc", "ac"] },
    ],
    spice: "", instrument: "multimeter",
    graphics: [...instrumentBox("DMM", 44, 34), line(-10, 17, -10, 25), line(10, 17, 10, 25)],
  },
  {
    kind: "bode-plotter", name: "Bode plotter", category: "Instruments", prefix: "XBP",
    pins: [
      { name: "in+", x: -20, y: 30 }, { name: "in-", x: -7, y: 30 },
      { name: "out+", x: 7, y: 30 }, { name: "out-", x: 20, y: 30 },
    ],
    params: [
      { key: "fstart", label: "Start frequency", default: "1" }, { key: "fstop", label: "Stop frequency", default: "10meg" },
    ],
    spice: "", instrument: "bode-plotter",
    graphics: [...instrumentBox("BODE", 56, 40), line(-20, 20, -20, 30), line(-7, 20, -7, 30), line(7, 20, 7, 30), line(20, 20, 20, 30)],
  },
  {
    kind: "wattmeter", name: "Wattmeter", category: "Instruments", prefix: "XWM",
    pins: [
      { name: "v+", x: -20, y: 25 }, { name: "v-", x: -7, y: 25 },
      { name: "i+", x: 7, y: 25 }, { name: "i-", x: 20, y: 25 },
    ],
    params: [], spice: "", instrument: "wattmeter",
    graphics: [...instrumentBox("WATT", 56, 34), line(-20, 17, -20, 25), line(-7, 17, -7, 25), line(7, 17, 7, 25), line(20, 17, 20, 25)],
  },
  {
    kind: "logic-analyzer", name: "Logic analyzer", category: "Instruments", prefix: "XLA",
    pins: ["1", "2", "3", "4"].map((name, i) => ({ name, x: -24 + i * 16, y: 30 })),
    params: [], spice: "", instrument: "logic-analyzer",
    graphics: [...instrumentBox("LOGIC", 64, 40), ...[0, 1, 2, 3].map((i) => line(-24 + i * 16, 20, -24 + i * 16, 30))],
  },
];

export const PART_BY_KIND = new Map(PARTS.map((p) => [p.kind, p]));
