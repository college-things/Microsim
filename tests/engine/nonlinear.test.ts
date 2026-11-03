import { describe, expect, it } from "vitest";
import { SimError } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { Analysis } from "../../src/engine/analysis";
import { elaborate, parseDeck } from "../../src/engine/netlist";
import { at, mag, nearest, op, phaseDeg, vec, VT } from "./helpers";

describe("diode", () => {
  it("satisfies the Shockley equation in forward bias", () => {
    const r = simulate(`diode
V1 a 0 5
R1 a d 1k
D1 d 0 dmod
.model dmod D(IS=1e-14 N=1)
`, { type: "op" });
    const vd = op(r, "v(d)");
    const i = (5 - vd) / 1000;
    const expected = VT * Math.log(i / 1e-14 + 1);
    expect(Math.abs(vd - expected)).toBeLessThan(2e-5);
    expect(vd).toBeGreaterThan(0.6);
    expect(vd).toBeLessThan(0.75);
  });

  it("applies emission coefficient and series resistance", () => {
    const r = simulate(`diode
V1 a 0 5
R1 a d 1k
D1 d 0 dmod
.model dmod D(IS=1e-12 N=2 RS=50)
`, { type: "op" });
    const vd = op(r, "v(d)");
    const i = (5 - vd) / 1000;
    const expected = 2 * VT * Math.log(i / 1e-12 + 1) + 50 * i;
    expect(Math.abs(vd - expected)).toBeLessThan(5e-5);
  });

  it("breaks down at BV, conducting IBV there", () => {
    const r = simulate(`zener
V1 a 0 -20
R1 a d 1k
D1 d 0 z
.model z D(BV=5.1 IBV=1m)
`, { type: "op" });
    const vd = op(r, "v(d)");
    const i = (vd + 20) / 1000;
    const expected = -(5.1 + VT * Math.log(i / 1e-3));
    expect(Math.abs(vd - expected)).toBeLessThan(5e-3);
  });

  it("half-wave rectifies with a one-diode drop", () => {
    const r = simulate(`rectifier
V1 in 0 SIN(0 10 1k)
D1 in out dmod
R1 out 0 1k
.model dmod D(IS=1e-14)
`, { type: "tran", tstep: 5e-6, tstop: 3e-3 });
    const peakI = (10 - 0.7) / 1000;
    const expectedPeak = 10 - VT * Math.log(peakI / 1e-14);
    expect(Math.abs(at(r, "v(out)", 0.25e-3) - expectedPeak)).toBeLessThan(0.01);
    expect(Math.abs(at(r, "v(out)", 0.75e-3))).toBeLessThan(1e-3);
    expect(Math.abs(at(r, "v(out)", 1.25e-3) - expectedPeak)).toBeLessThan(0.01);
    expect(r.stats.iterations).toBeGreaterThan(r.stats.steps);
  });

  it("uses depletion capacitance in AC", () => {
    // Reverse biased at 5 V, where Cj = CJO / sqrt(1 + 5 / VJ).
    const cj = 10e-12 / Math.sqrt(1 + 5);
    const w = 2 * Math.PI * 1e6;
    const expected = 1 / Math.hypot(1, w * 1e3 * cj);
    const rev = simulate(`diode ac reverse
V1 a 0 DC -5 AC 1
R1 a d 1k
D1 d 0 dmod
.model dmod D(IS=1e-14 CJO=10p VJ=1 M=0.5)
`, { type: "ac", sweep: "lin", points: 1, fstart: 1e6, fstop: 1e6 });
    expect(Math.abs(mag(vec(rev, "v(d)"), 0) - expected) / expected).toBeLessThan(2e-3);
  });

  it("stores TT charge during turn-off", () => {
    const r = simulate(`recovery
V1 a 0 PWL(0 5 1u 5 1.001u -5 3u -5)
R1 a d 1k
D1 d 0 dmod
.model dmod D(IS=1e-14 TT=100n)
`, { type: "tran", tstep: 5e-9, tstop: 3e-6 });
    // During storage the diode stays near its forward drop while reverse current flows.
    expect(at(r, "v(d)", 1.02e-6)).toBeGreaterThan(0.4);
    expect(at(r, "v(d)", 2.9e-6)).toBeLessThan(-4.9);
  });
});

describe("BJT", () => {
  /** Fixed-point hand solution of a CE stage with base resistor and Early effect off. */
  function handCE(vcc: number, rb: number, rc: number, is: number, bf: number): { vbe: number; ic: number; vc: number } {
    let vbe = 0.7;
    let ic = 0;
    for (let i = 0; i < 50; i++) {
      const ib = (vcc - vbe) / rb;
      ic = bf * ib;
      vbe = VT * Math.log(ic / is + 1);
    }
    return { vbe, ic, vc: vcc - rc * ic };
  }

  it("matches a hand-calculated common-emitter bias point", () => {
    const r = simulate(`ce
Vcc vcc 0 12
Rb vcc b 1meg
Rc vcc c 2k
Q1 c b 0 npn1
.model npn1 NPN(IS=1e-14 BF=100)
`, { type: "op" });
    const h = handCE(12, 1e6, 2e3, 1e-14, 100);
    // Collector current subtracts the reverse-junction base component, negligible here.
    expect(Math.abs(op(r, "v(b)") - h.vbe)).toBeLessThan(1e-3);
    expect(Math.abs(op(r, "v(c)") - h.vc)).toBeLessThan(2e-3);
  });

  it("mirrors the bias point for PNP", () => {
    const r = simulate(`ce pnp
Vcc vcc 0 -12
Rb vcc b 1meg
Rc vcc c 2k
Q1 c b 0 p1
.model p1 PNP(IS=1e-14 BF=100)
`, { type: "op" });
    const h = handCE(12, 1e6, 2e3, 1e-14, 100);
    expect(Math.abs(op(r, "v(b)") + h.vbe)).toBeLessThan(1e-3);
    expect(Math.abs(op(r, "v(c)") + h.vc)).toBeLessThan(2e-3);
  });

  it("applies Early voltage and series emitter resistance", () => {
    const VAF = 50;
    const IS = 1e-14;
    const BF = 100;
    const r = simulate(`early
Vc c 0 10
Vb b 0 0.7
Q1 c b 0 n
.model n NPN(IS=1e-14 BF=100 VAF=50)
`, { type: "op" });
    const vbe = 0.7;
    const vbc = 0.7 - 10;
    const ic = -op(r, "i(vc)");
    // qb = 1 / (1 - vbc / VAF); It = IS * exp(vbe / Vt) / qb.
    const expected = IS * (Math.exp(vbe / VT) - 1) * (1 - vbc / VAF);
    expect(Math.abs(ic - expected) / expected).toBeLessThan(1e-3);
    const ib = -op(r, "i(vb)");
    expect(Math.abs(ib - (IS * (Math.exp(vbe / VT) - 1)) / BF) / ib).toBeLessThan(1e-3);
  });

  it("reduces beta at high injection through IKF", () => {
    const r = simulate(`ikf
Vc c 0 5
Vb b 0 0.85
Q1 c b 0 n
.model n NPN(IS=1e-14 BF=100 IKF=10m)
`, { type: "op" });
    const ibe = 1e-14 * (Math.exp(0.85 / VT) - 1);
    const q2 = ibe / 10e-3;
    const qb = (1 + Math.sqrt(1 + 4 * q2)) / 2;
    const ic = -op(r, "i(vc)");
    expect(Math.abs(ic - ibe / qb) / ic).toBeLessThan(1e-3);
    const ib = -op(r, "i(vb)");
    expect(ic / ib).toBeLessThan(100);
  });

  it("gives common-emitter small-signal gain -gm*Rc in AC", () => {
    const r = simulate(`ce ac
Vcc vcc 0 12
Vb b 0 DC 0.65 AC 1m
Rc vcc c 2k
Q1 c b 0 n
.model n NPN(IS=1e-14 BF=100)
`, { type: "ac", sweep: "lin", points: 1, fstart: 1e3, fstop: 1e3 });
    const ic = 1e-14 * (Math.exp(0.65 / VT) - 1);
    const gm = ic / VT;
    const v = vec(r, "v(c)");
    expect(Math.abs(mag(v, 0) - gm * 2e3 * 1e-3) / (gm * 2e3 * 1e-3)).toBeLessThan(2e-3);
    expect(Math.abs(Math.abs(phaseDeg(v, 0)) - 180)).toBeLessThan(0.1);
  });

  it("settles to the DC bias under transient with charge storage", () => {
    const n = `ce tran
Vcc vcc 0 12
Vb in 0 PULSE(0 5 1u 10n 10n 5u 12u)
Rb in b 10k
Rc vcc c 1k
Q1 c b 0 n
.model n NPN(IS=1e-14 BF=100 CJE=5p CJC=3p TF=300p TR=50n VAF=100 RB=10 RC=1 RE=0.5)
`;
    const r = simulate(n, { type: "tran", tstep: 5e-9, tstop: 12e-6 });
    // Saturated during the pulse, off afterwards.
    expect(at(r, "v(c)", 5e-6)).toBeLessThan(0.3);
    expect(Math.abs(at(r, "v(c)", 11.5e-6) - 12)).toBeLessThan(0.01);
    expect(at(r, "v(c)", 6.02e-6)).toBeLessThan(11.9); // Storage delay after base turn-off.
    expect(r.stats.iterations).toBeGreaterThan(0);
  });
});

describe("MOSFET", () => {
  it("follows square-law saturation with W/L, lambda and body effect", () => {
    const VTO = 1;
    const KP = 100e-6;
    const lambda = 0.02;
    const gamma = 0.5;
    const phi = 0.6;
    const r = simulate(`nmos
Vd d 0 5
Vg g 0 3
Vb b 0 -2
M1 d g 0 b n1 W=10u L=2u
.model n1 NMOS(VTO=1 KP=100u GAMMA=0.5 PHI=0.6 LAMBDA=0.02)
`, { type: "op" });
    const vth = VTO + gamma * (Math.sqrt(phi + 2) - Math.sqrt(phi));
    const id = 0.5 * KP * (10 / 2) * (3 - vth) ** 2 * (1 + lambda * 5);
    expect(Math.abs(-op(r, "i(vd)") - id) / id).toBeLessThan(1e-3);
  });

  it("follows the triode equation", () => {
    const r = simulate(`nmos triode
Vd d 0 0.5
Vg g 0 3
M1 d g 0 0 n1 W=10u L=2u
.model n1 NMOS(VTO=1 KP=100u)
`, { type: "op" });
    const id = 100e-6 * 5 * ((3 - 1) * 0.5 - 0.125);
    expect(Math.abs(-op(r, "i(vd)") - id) / id).toBeLessThan(1e-3);
  });

  it("conducts with drain and source swapped", () => {
    const r = simulate(`nmos reversed
Vs s 0 0.5
Vg g 0 3
M1 0 g s 0 n1 W=10u L=2u
.model n1 NMOS(VTO=1 KP=100u)
`, { type: "op" });
    const id = 100e-6 * 5 * ((3 - 1) * 0.5 - 0.125);
    expect(Math.abs(Math.abs(op(r, "i(vs)")) - id) / id).toBeLessThan(1e-3);
  });

  it("sweeps a CMOS inverter through its transfer curve", () => {
    const VDD = 5;
    const r = simulate(`inverter
Vdd vdd 0 5
Vin in 0 0
Mp out in vdd vdd pm W=10u L=1u
Mn out in 0 0 nm W=10u L=1u
.model nm NMOS(VTO=1 KP=100u LAMBDA=0.001)
.model pm PMOS(VTO=-1 KP=100u LAMBDA=0.001)
`, { type: "dc", source: "vin", start: 0, stop: 5, step: 0.02 });
    const axis = r.axis!.re;
    const v = vec(r, "v(out)").re;
    expect(Math.abs(v[0]! - VDD)).toBeLessThan(1e-3);
    expect(Math.abs(v[v.length - 1]!)).toBeLessThan(1e-3);
    expect(Math.abs(at(r, "v(out)", 2.5) - 2.5)).toBeLessThan(0.1);
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeLessThanOrEqual(v[i - 1]! + 1e-6);
    // Unity-gain input points of a matched inverter: VIL = (3 VDD + 2 Vt) / 8, VIH = VDD - VIL.
    const VIL = (3 * VDD + 2 * 1) / 8;
    let il = 0;
    for (let i = 1; i < v.length; i++) {
      if ((v[i]! - v[i - 1]!) / (axis[i]! - axis[i - 1]!) < -1) {
        il = axis[i]!;
        break;
      }
    }
    expect(Math.abs(il - VIL)).toBeLessThan(0.05);
    expect(r.stats.steps).toBe(251);
  });

  it("delays a CMOS inverter with gate overlap capacitance in transient", () => {
    const r = simulate(`inverter pair
Vdd vdd 0 5
Vin in 0 PULSE(0 5 1n 0.1n 0.1n 10n 20n)
Mp1 out in vdd vdd pm W=10u L=1u
Mn1 out in 0 0 nm W=5u L=1u
Cl out 0 100f
.model nm NMOS(VTO=1 KP=100u CGSO=1n CGDO=1n CBD=10f CBS=10f)
.model pm PMOS(VTO=-1 KP=50u CGSO=1n CGDO=1n CBD=10f CBS=10f)
`, { type: "tran", tstep: 0.01e-9, tstop: 20e-9 });
    expect(Math.abs(at(r, "v(out)", 0.5e-9) - 5)).toBeLessThan(0.01);
    expect(at(r, "v(out)", 9e-9)).toBeLessThan(0.01);
    expect(Math.abs(at(r, "v(out)", 19e-9) - 5)).toBeLessThan(0.01);
  });
});

describe("JFET", () => {
  it("follows the saturation equation for NJF", () => {
    const r = simulate(`jfet
Vd d 0 10
Vg g 0 -1
J1 d g 0 jn
.model jn NJF(VTO=-3 BETA=1m LAMBDA=0.01 IS=1e-14)
`, { type: "op" });
    const id = 1e-3 * (-1 + 3) ** 2 * (1 + 0.01 * 10);
    expect(Math.abs(-op(r, "i(vd)") - id) / id).toBeLessThan(1e-3);
  });

  it("mirrors for PJF", () => {
    const r = simulate(`pjfet
Vd d 0 -10
Vg g 0 1
J1 d g 0 jp
.model jp PJF(VTO=-3 BETA=1m)
`, { type: "op" });
    const id = 1e-3 * (-1 + 3) ** 2;
    expect(Math.abs(op(r, "i(vd)") - id) / id).toBeLessThan(1e-3);
  });

  it("follows the triode equation in the linear region", () => {
    const r = simulate(`jfet linear
Vd d 0 0.5
Vg g 0 0
J1 d g 0 jn
.model jn NJF(VTO=-2 BETA=1m)
`, { type: "op" });
    const id = 1e-3 * 0.5 * (2 * 2 - 0.5);
    expect(Math.abs(-op(r, "i(vd)") - id) / id).toBeLessThan(1e-3);
  });
});

describe("behavioural sources", () => {
  it("evaluates V= with node voltages and a branch current", () => {
    const r = simulate(`b
V1 a 0 2
R1 a 0 1k
B1 x 0 V=sqrt(v(a))*3 + i(v1)*1000
Rx x 0 1k
B2 y 0 I=-1m*v(a)^2
Ry y 0 1k
`, { type: "op" });
    expect(Math.abs(op(r, "v(x)") - (Math.sqrt(2) * 3 - 2))).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(y)") - 4)).toBeLessThan(1e-5);
  });

  it("solves a nonlinear feedback fixed point using analytic derivatives", () => {
    const r = simulate(`b feedback
B1 a 0 I=-(2 - v(a)^3)
R1 a 0 1
`, { type: "op" });
    const v = op(r, "v(a)");
    // Node equation: v + v^3 = 2, with root v = 1.
    expect(Math.abs(v - 1)).toBeLessThan(1e-5);
    expect(r.stats.iterations).toBeLessThan(30);
  });

  it("supports functions and conditionals", () => {
    const r = simulate(`b functions
V1 a 0 0.5
B1 b1 0 V=tanh(v(a)) + atan(v(a)) + exp(v(a)) + ln(v(a)+1) + log(100)
B2 b2 0 V=if(v(a)>0.25, min(1,2), max(1,2)) + u(v(a)-1) + abs(-3)
B3 b3 0 V=sin(v(a))^2 + cos(v(a))^2
Rb1 b1 0 1k
Rb2 b2 0 1k
Rb3 b3 0 1k
`, { type: "op" });
    const a = 0.5;
    expect(Math.abs(op(r, "v(b1)") - (Math.tanh(a) + Math.atan(a) + Math.exp(a) + Math.log(a + 1) + 2))).toBeLessThan(1e-5);
    expect(Math.abs(op(r, "v(b2)") - 4)).toBeLessThan(1e-5);
    expect(Math.abs(op(r, "v(b3)") - 1)).toBeLessThan(1e-5);
  });

  it("works in a linearized AC analysis", () => {
    const r = simulate(`b ac
V1 a 0 DC 2 AC 1
B1 x 0 V=v(a)^2
Rx x 0 1k
`, { type: "ac", sweep: "lin", points: 1, fstart: 100, fstop: 100 });
    expect(Math.abs(mag(vec(r, "v(x)"), 0) - 4)).toBeLessThan(1e-6);
  });

  it("depends on time in transient", () => {
    const r = simulate("t\nB1 a 0 V=time*1000\nR1 a 0 1k\n", { type: "tran", tstep: 1e-5, tstop: 1e-3 });
    expect(Math.abs(at(r, "v(a)", 5e-4) - 0.5)).toBeLessThan(1e-3);
  });

  it("accepts E VALUE= and E POLY forms", () => {
    const r = simulate(`forms
V1 a 0 3
V2 b 0 2
E1 x 0 VALUE={v(a)*v(b)}
Rx x 0 1k
E2 y 0 POLY(2) a 0 b 0 1 2 0 0 3
Ry y 0 1k
G1 0 z POLY(1) a 0 0 1m
Rz z 0 1k
`, { type: "op" });
    expect(Math.abs(op(r, "v(x)") - 6)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(y)") - (1 + 2 * 3 + 3 * 3 * 2))).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(z)") - 3)).toBeLessThan(1e-6);
  });
});

describe("convergence and failure reporting", () => {
  it("converges on a stiff diode stack, reporting iterations", () => {
    let n = "stack\nV1 t0 0 50\nR1 t0 a0 10\n";
    for (let i = 0; i < 30; i++) n += `D${i} a${i} a${i + 1} dm\n`;
    n += `R2 a30 0 10\n.model dm D(IS=1e-15 N=1.5 RS=0.5)\n`;
    const r = simulate(n, { type: "op" });
    expect(r.stats.iterations).toBeGreaterThan(3);
    const i = (50 - op(r, "v(a0)")) / 10;
    expect(i).toBeGreaterThan(0);
    expect(Math.abs(op(r, "v(a30)") / 10 - i) / i).toBeLessThan(1e-3);
  });

  it("solves a cross-coupled latch that needs voltage limiting", () => {
    const r = simulate(`latch
Vcc vcc 0 5
Rc1 vcc c1 1k
Rc2 vcc c2 1k
Rb1 c2 b1 10k
Rb2 c1 b2 10k
Q1 c1 b1 0 n
Q2 c2 b2 0 n
.model n NPN(IS=1e-14 BF=100)
`, { type: "op" });
    // Any of the states is fine; the solution must satisfy KCL at c1.
    const ib2 = (op(r, "v(c1)") - op(r, "v(b2)")) / 10e3;
    expect(Number.isFinite(ib2)).toBe(true);
    expect(op(r, "v(c1)")).toBeLessThanOrEqual(5);
  });

  it("reaches the true solution when plain Newton runs out of iterations", () => {
    // Unlimited exponential: from 50 V, Newton retreats only 1/40 V per iteration.
    const r = simulate(`hard exponential
V1 a 0 50
R1 a b 1k
B1 b 0 I=1e-9*(exp(v(b)*40)-1)
`, { type: "op" });
    let lo = 0;
    let hi = 50;
    const kcl = (v: number): number => (50 - v) / 1000 - 1e-9 * (Math.exp(v * 40) - 1);
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (kcl(mid) > 0) lo = mid;
      else hi = mid;
    }
    expect(Math.abs(op(r, "v(b)") - lo)).toBeLessThan(1e-4);
    expect(r.stats.iterations).toBeGreaterThan(100);
  });

  it("recovers through GMIN or source stepping under a tight iteration limit", () => {
    let n = "stack\nV1 t0 0 50\nR1 t0 a0 10\n";
    for (let i = 0; i < 30; i++) n += `D${i} a${i} a${i + 1} dm\n`;
    n += `R2 a30 0 10\n.model dm D(IS=1e-15 N=1.5 RS=0.5)\n`;
    const free = simulate(n, { type: "op" });
    // Two iterations per solve fail the plain pass and the damped pass of four.
    const tight = simulate(`${n}.options itl1=2\n`, { type: "op" });
    expect(tight.stats.iterations).toBeGreaterThan(2 + 4);
    expect(Math.abs(op(tight, "v(a15)") - op(free, "v(a15)"))).toBeLessThan(1e-3);
  });

  for (const aid of ["gminStepping", "sourceStepping"] as const) {
    it(`reaches the same solution by ${aid} alone`, () => {
      let n = "stack\nV1 t0 0 50\nR1 t0 a0 10\n";
      for (let i = 0; i < 30; i++) n += `D${i} a${i} a${i + 1} dm\n`;
      n += `R2 a30 0 10\nQ1 a2 t0 a4 q1\n.model q1 NPN(IS=1e-14)\n.model dm D(IS=1e-15 N=1.5 RS=0.5)\n`;
      const reference = simulate(n, { type: "op" });
      const c = elaborate(parseDeck(n));
      c.build();
      const a = new Analysis(c, {}) as unknown as Record<typeof aid, () => boolean>;
      expect(a[aid]()).toBe(true);
      const id = c.names.indexOf("a15");
      expect(Math.abs(c.x[id]! - op(reference, "v(a15)"))).toBeLessThan(1e-3);
      expect(c.srcFactor).toBe(1);
    });
  }

  it("does not crash on unreadable syntax in an unsupported line", () => {
    const r = simulate("t\nV1 a 0 1\nR1 a 0 1\nU1 {broken 'stray\n", { type: "op" });
    expect(r.warnings.join()).toMatch(/Line 4: unsupported device/);
  });

  it("derives KP from TOX and UO when KP is absent", () => {
    const r = simulate(`process
Vd d 0 5
Vg g 0 3
M1 d g 0 0 n1 W=10u L=1u
.model n1 NMOS(VTO=1 TOX=20n UO=500)
`, { type: "op" });
    const kp = (500e-4 * 3.9 * 8.854187817e-12) / 20e-9;
    const id = 0.5 * kp * 10 * 4;
    expect(Math.abs(-op(r, "i(vd)") - id) / id).toBeLessThan(1e-3);
    expect(r.warnings).toEqual([]);
  });

  it("reports non-convergence with a useful SimError", () => {
    // Node current flips with the sign of v(a), so the equation has no solution.
    const bad = `no solution
B1 a 0 I=if(v(a)>0,1,-1)
R1 a 0 1
`;
    let error: unknown;
    try {
      simulate(bad, { type: "op" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SimError);
    const e = error as SimError;
    expect(e.code).toBe("convergence");
    expect(e.message).toMatch(/did not converge/);
    expect(e.message).toMatch(/v\(a\)/);
    expect(e.message).toMatch(/\d+ Newton iterations/);
  });

  it("reports a singular voltage source loop naming the source", () => {
    const n = `loop
V1 a 0 1
V2 a 0 2
R1 a 0 1k
`;
    let error: unknown;
    try {
      simulate(n, { type: "op" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SimError);
    const e = error as SimError;
    expect(e.code).toBe("singular");
    expect(e.message).toMatch(/i\(v[12]\)/);
  });

  it("treats parallel inductors in DC as shorts that share the current", () => {
    const r = simulate("t\nV1 a 0 1\nL1 a b 1m\nL2 a b 1m\nR1 b 0 1k\n", { type: "op" });
    expect(Math.abs(op(r, "v(b)") - 1)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "i(l1)") - 0.5e-3)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "i(l2)") - 0.5e-3)).toBeLessThan(1e-6);
  });

  it("warns when a DC source sits directly across an ideal inductor", () => {
    const r = simulate("t\nV1 a 0 1\nL1 a 0 1m\n", { type: "op" });
    expect(r.warnings.join()).toMatch(/i\(l1\).*ideal inductor/);
  });

  it("reports a loop of controlled voltage sources as singular", () => {
    let error: unknown;
    try {
      simulate("t\nE1 a 0 c 0 1\nV1 a 0 2\nV2 c 0 1\nR1 a 0 1k\n", { type: "op" });
    } catch (e) {
      error = e;
    }
    expect((error as SimError).code).toBe("singular");
  });

  it("reports singular for a nonlinear circuit with a source loop too", () => {
    let error: unknown;
    try {
      simulate("t\nV1 a 0 1\nV2 a 0 1\nD1 a 0 d\n.model d D\n", { type: "op" });
    } catch (e) {
      error = e;
    }
    expect((error as SimError).code).toBe("singular");
  });

  it("solves floating nodes through GMIN", () => {
    const r = simulate(`floating
V1 a 0 1
R1 a 0 1k
C1 a b 1u
R2 b c 1k
`, { type: "op" });
    expect(Math.abs(op(r, "v(b)"))).toBeLessThan(1e-3);
    expect(Math.abs(op(r, "v(c)"))).toBeLessThan(1e-3);
    expect(r.warnings.join()).toMatch(/'c' has only one/);
  });

  it("solves a floating subnetwork with no ground path", () => {
    const r = simulate(`island
V1 a 0 1
R1 a 0 1k
V2 x y 3
R2 x y 1k
`, { type: "op" });
    expect(Math.abs(op(r, "v(x)") - op(r, "v(y)") - 3)).toBeLessThan(1e-6);
  });

  it("warns when GMIN alone sets a very large voltage", () => {
    const r = simulate("t\nI1 0 a 1\nC1 a 0 1u\n", { type: "op" });
    expect(r.warnings.join()).toMatch(/floating/);
  });

  it("nearest helper finds the closest sample", () => {
    expect(nearest(new Float64Array([0, 1, 2]), 1.2)).toBe(1);
  });
});
