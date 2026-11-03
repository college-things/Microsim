import { describe, expect, it } from "vitest";
import type { SimResult } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { Collector } from "../../src/engine/analysis";
import { at, mag, op, vec, VT } from "./helpers";

const K_Q = 1.380649e-23 / 1.602176634e-19;

describe("PSpice switches", () => {
  const sweep = (model: string): SimResult =>
    simulate(`s
V1 a 0 1
Vc c 0 0
Rc c 0 1k
S1 a b c 0 sm
R1 b 0 1k
.model sm ${model}
`, { type: "dc", source: "vc", start: 0, stop: 3, step: 0.5 });

  it("is RON at VON, ROFF at VOFF and their geometric mean between", () => {
    const r = sweep("VSWITCH(RON=1 ROFF=1meg VON=2 VOFF=1)");
    const res = (vc: number): number => {
      const v = at(r, "v(b)", vc);
      return (1000 * (1 - v)) / v;
    };
    expect(Math.abs(res(0.5) - 1e6) / 1e6).toBeLessThan(1e-3);
    expect(Math.abs(res(3) - 1) / 1).toBeLessThan(1e-3);
    expect(Math.abs(res(1.5) - Math.sqrt(1e6)) / 1e3).toBeLessThan(1e-3);
  });

  it("reads VON and VOFF on an SW model too", () => {
    const r = sweep("SW(RON=1 ROFF=1meg VON=2 VOFF=1)");
    expect(r.warnings.join()).not.toMatch(/von/);
    expect(at(r, "v(b)", 3)).toBeGreaterThan(0.99);
  });

  it("handles inverted thresholds with VON below VOFF", () => {
    const r = sweep("VSWITCH(RON=1 ROFF=1meg VON=1 VOFF=2)");
    expect(at(r, "v(b)", 0.5)).toBeGreaterThan(0.99);
    expect(at(r, "v(b)", 3)).toBeLessThan(0.01);
  });

  it("uses ION and IOFF on a W switch", () => {
    const r = simulate(`w
V1 a 0 1
I1 0 c 0
Vs c 0 0
W1 a b Vs wm
R1 b 0 1k
.model wm ISWITCH(RON=1 ROFF=1meg ION=2m IOFF=1m)
`, { type: "dc", source: "i1", start: 0, stop: 3e-3, step: 0.5e-3 });
    expect(at(r, "v(b)", 0.5e-3)).toBeLessThan(0.01);
    expect(at(r, "v(b)", 3e-3)).toBeGreaterThan(0.99);
  });
});

describe("W current-controlled switch", () => {
  it("closes at IT+IH and opens at IT-IH", () => {
    const r = simulate(`w hysteresis
I1 0 c PWL(0 0 1m 1 2m 0)
Vs c 0 0
V1 a 0 1
W1 a b Vs wm
R1 b 0 1k
.model wm csw(IT=0.5 IH=0.1 RON=1 ROFF=1g)
`, { type: "tran", tstep: 2e-6, tstop: 2e-3 });
    const t = r.axis!.re;
    const v = vec(r, "v(b)").re;
    let closed = NaN;
    let opened = NaN;
    for (let i = 1; i < t.length; i++) {
      if (Number.isNaN(closed) && v[i - 1]! < 0.5 && v[i]! >= 0.5) closed = t[i]!;
      if (!Number.isNaN(closed) && Number.isNaN(opened) && v[i - 1]! > 0.5 && v[i]! <= 0.5) opened = t[i]!;
    }
    // Rising at 1 A/ms reaches 0.6 A at 0.6 ms; falling reaches 0.4 A at 1.6 ms.
    expect(Math.abs(closed - 0.6e-3)).toBeLessThan(2e-6);
    expect(Math.abs(opened - 1.6e-3)).toBeLessThan(2e-6);
  });
});

describe("expressions from vendor models", () => {
  const value = (expr: string, extra = ""): number => {
    const r = simulate(`t\nV1 a 0 2\nR1 a 0 1k\nV2 m 0 -3\nR2 m 0 1k\nB1 y 0 V=${expr}\nRy y 0 1k\n${extra}\n`, { type: "op" });
    return op(r, "v(y)");
  };

  it("implements limit, pwr, pwrs, stp, sgn and table", () => {
    expect(value("limit(v(a),0,1)")).toBeCloseTo(1, 6);
    expect(value("limit(v(a),5,3)")).toBeCloseTo(3, 6);
    expect(value("pwr(v(m),2)")).toBeCloseTo(9, 6);
    expect(value("pwrs(v(m),2)")).toBeCloseTo(-9, 6);
    expect(value("stp(v(a)-2)")).toBeCloseTo(1, 6);
    expect(value("sgn(v(m))")).toBeCloseTo(-1, 6);
    expect(value("table(v(a),0,0,4,8)")).toBeCloseTo(4, 6);
    expect(value("(v(a)>1)&(v(m)<0)")).toBeCloseTo(1, 6);
    expect(value("(v(a)<1)|(v(m)>0)")).toBeCloseTo(0, 6);
  });

  it("expands .func, including nesting and node probes", () => {
    const funcs = ".func sq(x) {x*x}\n.func twice(x,y) {2*sq(x)+y}";
    expect(value("twice(v(a),1)", funcs)).toBeCloseTo(9, 6);
  });

  it("evaluates temp in expressions", () => {
    expect(value("temp", ".temp 50")).toBeCloseTo(50, 6);
  });

  it("differentiates with ddt() like a capacitor", () => {
    const r = simulate(`ddt
V1 in 0 PULSE(0 1 0 1n 1n 1 2)
R1 in n 1k
B1 n 0 I=1u*ddt(v(n))
`, { type: "tran", tstep: 10e-6, tstop: 3e-3 });
    expect(Math.abs(at(r, "v(n)", 1e-3) - (1 - Math.exp(-1)))).toBeLessThan(2e-3);
  });

  it("gives ddt() the capacitor's AC response", () => {
    const fc = 1 / (2 * Math.PI * 1e-3);
    const r = simulate("t\nV1 in 0 AC 1\nR1 in n 1k\nB1 n 0 I=1u*ddt(v(n))\n", { type: "ac", sweep: "lin", points: 1, fstart: fc, fstop: fc });
    expect(Math.abs(mag(vec(r, "v(n)"), 0) - Math.SQRT1_2)).toBeLessThan(1e-3);
  });

  it("integrates with sdt()", () => {
    const r = simulate("t\nV1 a 0 PULSE(0 1 0 1n 1n 1 2)\nR1 a 0 1k\nB1 y 0 V=1000*sdt(v(a))\nRy y 0 1k\n", { type: "tran", tstep: 10e-6, tstop: 2e-3 });
    expect(Math.abs(at(r, "v(y)", 1e-3) - 1)).toBeLessThan(5e-3);
  });

  it("reads I() of behavioural sources, G sources and resistors", () => {
    const r = simulate(`currents
V1 a 0 2
Bv a b V=1
R1 b 0 1k
Bi 0 c I=2m
Rc c 0 1k
G1 0 d a 0 1m
Rd d 0 1k
By y 0 V=I(Bv)*1000
Ry y 0 1k
Bz z 0 V=I(Bi)*1000
Rz z 0 1k
Bg g 0 V=I(G1)*1000
Rg g 0 1k
Br r 0 V=I(Rc)*1000
Rr r 0 1k
`, { type: "op" });
    // Current through a source runs from its first node to its second.
    expect(op(r, "v(y)")).toBeCloseTo(1, 5);
    expect(op(r, "v(z)")).toBeCloseTo(2, 5);
    expect(op(r, "v(g)")).toBeCloseTo(2, 5);
    expect(op(r, "v(r)")).toBeCloseTo(2, 5);
    expect(op(r, "v(c)")).toBeCloseTo(2, 5);
    expect(r.vectors.map((v) => v.name).join()).not.toMatch(/#/);
  });

  it("evaluates E and G TABLE sources", () => {
    const r = simulate("t\nV1 a 0 1.5\nR1 a 0 1k\nE1 y 0 TABLE {v(a)} = (0,0) (1,10) (2,30)\nRy y 0 1k\n", { type: "op" });
    expect(op(r, "v(y)")).toBeCloseTo(20, 5);
  });

  it("realises LAPLACE sources, including a delay through a Pade form", () => {
    const lag = simulate("t\nV1 a 0 PULSE(0 1 0 1n 1n 1 2)\nR1 a 0 1k\nE1 y 0 LAPLACE {v(a)} = {1/(1+0.001*s)}\nRy y 0 1k\n", { type: "tran", tstep: 10e-6, tstop: 3e-3 });
    expect(Math.abs(at(lag, "v(y)", 1e-3) - (1 - Math.exp(-1)))).toBeLessThan(2e-3);
    const f = 100;
    const w = 2 * Math.PI * f;
    const delayed = simulate("t\nV1 a 0 AC 1\nR1 a 0 1k\nE1 y 0 LAPLACE {v(a)} = {e^(-1m*s)/(1+0.001*s)}\nRy y 0 1k\n", { type: "ac", sweep: "lin", points: 1, fstart: f, fstop: f });
    const v = vec(delayed, "v(y)");
    expect(Math.abs(mag(v, 0) - 1 / Math.hypot(1, w * 1e-3))).toBeLessThan(1e-3);
    const phase = Math.atan2(v.im![0]!, v.re[0]!);
    const expected = -w * 1e-3 - Math.atan(w * 1e-3);
    expect(Math.abs(phase - expected)).toBeLessThan(0.01);
  });
});

describe("source functions", () => {
  it("evaluates SFFM", () => {
    const r = simulate("t\nV1 a 0 SFFM(1 2 1k 0.5 100)\nR1 a 0 1k\n", { type: "tran", tstep: 2e-6, tstop: 2e-3 });
    const t = 1.3e-3;
    const w = 2 * Math.PI;
    expect(Math.abs(at(r, "v(a)", t) - (1 + 2 * Math.sin(w * 1000 * t + 0.5 * Math.sin(w * 100 * t))))).toBeLessThan(2e-3);
  });

  it("evaluates AM", () => {
    const r = simulate("t\nV1 a 0 AM(2 1 100 5k 0)\nR1 a 0 1k\n", { type: "tran", tstep: 1e-6, tstop: 2e-3 });
    const t = 1.3e-3;
    const w = 2 * Math.PI;
    expect(Math.abs(at(r, "v(a)", t) - 2 * (1 + Math.sin(w * 100 * t)) * Math.sin(w * 5000 * t))).toBeLessThan(5e-3);
  });

  it("delays and repeats PWL with td= and r=", () => {
    const r = simulate("t\nV1 a 0 PWL(0 0 1m 1 2m 0) r=0 td=1m\nR1 a 0 1k\n", { type: "tran", tstep: 10e-6, tstop: 7e-3 });
    expect(at(r, "v(a)", 0.5e-3)).toBeCloseTo(0, 6);
    expect(at(r, "v(a)", 2e-3)).toBeCloseTo(1, 3);
    expect(at(r, "v(a)", 4e-3)).toBeCloseTo(1, 3);
    expect(at(r, "v(a)", 5e-3)).toBeCloseTo(0, 3);
  });

  it("ignores distortion specifications silently", () => {
    const r = simulate("t\nV1 a 0 DC 1 DISTOF1 4 0\nR1 a 0 1k\n", { type: "op" });
    expect(r.warnings).toEqual([]);
  });
});

describe("temperature", () => {
  it("scales a resistor with TC1 and TC2 from the model and the instance", () => {
    const run = (card: string, extra = ""): number => {
      const r = simulate(`t\nI1 0 a 1\n${card}\n${extra}\n`, { type: "op" });
      return op(r, "v(a)");
    };
    const f = 1 + 1e-3 * 73 + 1e-6 * 73 * 73;
    expect(run("R1 a 0 1k vm TEMP=100", ".model vm r(TC1=1m TC2=1u)") / 1e3).toBeCloseTo(f, 6);
    expect(run("R1 a 0 1k TC1=1m TC2=1u TEMP=100") / 1e3).toBeCloseTo(f, 6);
    expect(run("R1 a 0 1k TC1=1m TC2=1u", ".temp 100") / 1e3).toBeCloseTo(f, 6);
    expect(run("R1 a 0 1k TC1=1m TC2=1u", ".options temp=100") / 1e3).toBeCloseTo(f, 6);
    expect(run("R1 a 0 1k TC1=1m TEMP=27") / 1e3).toBeCloseTo(1, 7);
    expect(run("R1 a 0 1k TC1=1m DTEMP=10") / 1e3).toBeCloseTo(1.01, 7);
  });

  it("scales a diode's saturation current with the published law", () => {
    const vd = (t: number): number => {
      const r = simulate(`t\nI1 0 d 1m\nD1 d 0 dm TEMP=${t}\n.model dm D(IS=1e-14 N=1 XTI=3 EG=1.11)\n`, { type: "op" });
      return op(r, "v(d)");
    };
    expect(vd(27)).toBeCloseTo(VT * Math.log(1e-3 / 1e-14 + 1), 3);
    const T = 75 + 273.15;
    const Tn = 300.15;
    const vt = K_Q * T;
    const isT = 1e-14 * (T / Tn) ** 3 * Math.exp((1.11 / vt) * (T / Tn - 1));
    expect(Math.abs(vd(75) - vt * Math.log(1e-3 / isT + 1))).toBeLessThan(2e-5);
    // Forward voltage falls with temperature by roughly 2 mV per degree.
    const slope = (vd(75) - vd(27)) / 48;
    expect(slope).toBeLessThan(-1.5e-3);
    expect(slope).toBeGreaterThan(-2.5e-3);
  });

  it("scales BJT saturation current and beta", () => {
    const run = (t: number): { ic: number; ib: number } => {
      const r = simulate(`t\n.temp ${t}\nVc c 0 5\nVb b 0 0.65\nQ1 c b 0 n\n.model n NPN(IS=1e-14 BF=100 XTB=1.5 XTI=3 EG=1.11)\n`, { type: "op" });
      return { ic: -op(r, "i(vc)"), ib: -op(r, "i(vb)") };
    };
    const T = 77 + 273.15;
    const Tn = 300.15;
    const vt = K_Q * T;
    const isT = 1e-14 * (T / Tn) ** 3 * Math.exp((1.11 / vt) * (T / Tn - 1));
    const expected = isT * (Math.exp(0.65 / vt) - 1);
    const hot = run(77);
    expect(Math.abs(hot.ic - expected) / expected).toBeLessThan(2e-3);
    const beta = 100 * (T / Tn) ** 1.5;
    expect(Math.abs(hot.ic / hot.ib - beta) / beta).toBeLessThan(2e-3);
  });

  it("is unchanged at nominal temperature for a model with TNOM 27", () => {
    const r = simulate("t\nVd d 0 3\nVg g 0 2\nM1 d g 0 0 n W=10u L=1u\n.model n NMOS(VTO=1 KP=100u GAMMA=0.4 PHI=0.6)\n", { type: "op" });
    const id = 0.5 * 100e-6 * 10 * 1;
    expect(Math.abs(-op(r, "i(vd)") - id) / id).toBeLessThan(1e-6);
  });
});

describe("device capacitances", () => {
  const CGS_MODEL = (extra: string): string => `t
Vd d 0 5
Vg g 0 DC 2 AC 1
Rg gin g 1k
Vt gin 0 0
M1 d g 0 0 n W=100u L=10u
.model n NMOS(VTO=1 KP=100u ${extra})
`;

  it("gives Meyer Cgs of two thirds Cox in saturation", () => {
    const tox = 100e-9;
    const cox = ((3.9 * 8.854187817e-12) / tox) * 100e-6 * 10e-6;
    const n = `t
Vd d 0 5
V1 in 0 DC 2 AC 1
Rs in g 1meg
Rl g 0 1g
M1 d g 0 0 n W=100u L=10u
.model n NMOS(VTO=1 KP=100u TOX=${tox})
`;
    const f = 1e4;
    const r = simulate(n, { type: "ac", sweep: "lin", points: 1, fstart: f, fstop: f });
    const w = 2 * Math.PI * f;
    const cg = (2 / 3) * cox;
    const expected = 1 / Math.hypot(1, w * 1e6 * cg);
    expect(cg).toBeGreaterThan(0);
    expect(Math.abs(mag(vec(r, "v(g)"), 0) - expected) / expected).toBeLessThan(0.02);
    expect(CGS_MODEL("")).toContain("NMOS");
  });

  it("uses CJ and CJSW with AD and PD for the drain junction", () => {
    const f = 1e7;
    const r = simulate(`t
V1 in 0 DC 0 AC 1
Rs in d 1k
M1 d 0 0 0 n W=10u L=1u AD=100p PD=40u
.model n NMOS(VTO=1 KP=100u CJ=1m CJSW=1n MJ=0.5 MJSW=0.5 PB=0.8)
`, { type: "ac", sweep: "lin", points: 1, fstart: f, fstop: f });
    const cj = 1e-3 * 100e-12 + 1e-9 * 40e-6;
    const w = 2 * Math.PI * f;
    const expected = 1 / Math.hypot(1, w * 1e3 * cj);
    expect(Math.abs(mag(vec(r, "v(d)"), 0) - expected) / expected).toBeLessThan(5e-3);
  });

  it("splits CJC with XCJC and adds CJS at the collector", () => {
    const f = 1e7;
    const r = simulate(`t
Vcc vcc 0 DC 5 AC 1
Rc vcc c 1k
Q1 c 0 0 n
.model n NPN(IS=1e-16 BF=100 CJC=10p XCJC=0.5 VJC=0.75 MJC=0 CJS=20p VJS=0.75 MJS=0)
`, { type: "ac", sweep: "lin", points: 1, fstart: f, fstop: f });
    // Base and substrate are grounded: both CJC parts and CJS load the collector, MJ = 0 makes them flat.
    const w = 2 * Math.PI * f;
    const expected = 1 / Math.hypot(1, w * 1e3 * 30e-12);
    expect(Math.abs(mag(vec(r, "v(c)"), 0) - expected) / expected).toBeLessThan(0.01);
  });

  it("raises transit time with XTF so that a faster edge sees more diffusion capacitance", () => {
    const run = (extra: string): number => {
      const r = simulate(`t
Vb b 0 DC 0.7 AC 1
Vc c 0 2
Rs bin b 1
Q1 c b 0 n
.model n NPN(IS=1e-14 BF=100 TF=1n ${extra})
`, { type: "ac", sweep: "lin", points: 1, fstart: 1e6, fstop: 1e6 });
      return mag(vec(r, "i(vb)"), 0);
    };
    expect(run("XTF=5")).toBeGreaterThan(run(""));
  });

  it("reduces base resistance with current through IRB", () => {
    const run = (extra: string): number => {
      const r = simulate(`t
Vb b 0 1
Vc c 0 5
Q1 c b 0 n
.model n NPN(IS=1e-14 BF=100 RB=200 RBM=10 ${extra})
`, { type: "op" });
      return -op(r, "i(vb)");
    };
    expect(run("IRB=1m")).toBeGreaterThan(run(""));
  });
});

describe("MESFET and transmission line", () => {
  it("follows the Statz equation in saturation", () => {
    const r = simulate("t\nVd d 0 5\nVg g 0 -1\nZ1 d g 0 m\n.model m NMF(VTO=-2 BETA=2m B=0.3 ALPHA=2 LAMBDA=0)\n", { type: "op" });
    const vgst = 1;
    const id = (2e-3 * vgst * vgst) / (1 + 0.3 * vgst);
    expect(Math.abs(-op(r, "i(vd)") - id) / id).toBeLessThan(1e-3);
  });

  it("delays a step by TD in the time domain and matches Z0", () => {
    const r = simulate(`line
V1 in 0 PULSE(0 2 0 1n 1n 1 2)
Rs in a 50
T1 a 0 b 0 Z0=50 TD=100n
Rl b 0 50
`, { type: "tran", tstep: 1e-9, tstop: 400e-9 });
    expect(Math.abs(at(r, "v(a)", 50e-9) - 1)).toBeLessThan(0.1);
    expect(Math.abs(at(r, "v(b)", 50e-9))).toBeLessThan(0.05);
    expect(Math.abs(at(r, "v(b)", 300e-9) - 1)).toBeLessThan(0.05);
  });
});

describe("run control", () => {
  it("honours shouldStop during the initial operating point", () => {
    const r = simulate("t\nV1 a 0 5\nR1 a d 1k\nD1 d 0 m\n.model m D\n", { type: "op" }, { shouldStop: () => true });
    expect(r.warnings.join()).toMatch(/partial/);
    expect(vec(r, "v(d)").re.length).toBe(0);
    const tr = simulate("t\nV1 a 0 5\nR1 a d 1k\nD1 d 0 m\n.model m D\n", { type: "tran", tstep: 1e-6, tstop: 1e-3 }, { shouldStop: () => true });
    expect(tr.axis!.re.length).toBe(0);
  });

  it("thins stored points evenly when memory runs out, keeping the last", () => {
    const spec = [{ name: "v(a)", unit: "V" as const, index: 1 }];
    const col = new Collector(spec, 8, false, 200);
    const x = new Float64Array(2);
    const N = 10000;
    for (let i = 0; i <= N; i++) {
      x[1] = i * 2;
      col.push(i, x);
    }
    col.finish();
    const axis = col.axisValues();
    expect(axis.length).toBeLessThanOrEqual(100 + 1);
    expect(axis.length).toBeGreaterThan(20);
    expect(col.decimated).toBe(true);
    expect(axis[axis.length - 1]).toBe(N);
    const v = col.vectors()[0]!.re;
    for (let i = 0; i < axis.length; i++) expect(v[i]).toBe(axis[i]! * 2);
    for (let i = 1; i < axis.length; i++) expect(axis[i]!).toBeGreaterThan(axis[i - 1]!);
  });
});
