import { describe, expect, it } from "vitest";
import { SimError, type SimResult } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { hessenbergQr } from "../../src/engine/pencil";
import { op, vec, VT } from "./helpers";

const K = 1.380649e-23;
const Q = 1.602176634e-19;
const T0 = 300.15;

const noiseAt = (netlist: string, output: string, source: string, f: number): SimResult =>
  simulate(netlist, { type: "noise", output, source, sweep: "lin", points: 1, fstart: f, fstop: f });

const density = (r: SimResult, name: string): number => vec(r, name).re[0]!;

function relative(got: number, want: number): number {
  return Math.abs(got - want) / Math.abs(want);
}

describe("noise", () => {
  it("gives a resistor its 4kTR density", () => {
    const r = noiseAt("t\nV1 in 0 0\nR1 in out 1k\n", "v(out)", "V1", 1e3);
    expect(relative(density(r, "onoise"), Math.sqrt(4 * K * T0 * 1e3))).toBeLessThan(1e-6);
    expect(relative(density(r, "inoise"), Math.sqrt(4 * K * T0 * 1e3))).toBeLessThan(1e-6);
    expect(relative(density(r, "onoise(r1)"), Math.sqrt(4 * K * T0 * 1e3))).toBeLessThan(1e-6);
  });

  it("scales with instance and circuit temperature", () => {
    const hot = noiseAt("t\nV1 in 0 0\nR1 in out 1k TEMP=127\n", "v(out)", "V1", 1e3);
    expect(relative(density(hot, "onoise"), Math.sqrt(4 * K * 400.15 * 1e3))).toBeLessThan(1e-6);
    const warm = noiseAt("t\n.temp 77\nV1 in 0 0\nR1 in out 1k\n", "v(out)", "V1", 1e3);
    expect(relative(density(warm, "onoise"), Math.sqrt(4 * K * 350.15 * 1e3))).toBeLessThan(1e-6);
  });

  it("combines a divider's resistors in parallel and refers noise to the input", () => {
    const r = noiseAt("t\nV1 in 0 0\nR1 in out 3k\nR2 out 0 1k\n", "v(out)", "V1", 1e3);
    const out = Math.sqrt(4 * K * T0 * 750);
    expect(relative(density(r, "onoise"), out)).toBeLessThan(1e-6);
    expect(relative(density(r, "inoise"), out / 0.25)).toBeLessThan(1e-6);
    // R1 shares the output by the square of R2 / (R1 + R2), and R2 by that of R1 / (R1 + R2).
    expect(relative(density(r, "onoise(r1)"), Math.sqrt(4 * K * T0 * 3e3) * 0.25)).toBeLessThan(1e-6);
    expect(relative(density(r, "onoise(r2)"), Math.sqrt(4 * K * T0 * 1e3) * 0.75)).toBeLessThan(1e-6);
  });

  it("reads a differential output and a current source input", () => {
    const r = noiseAt("t\nI1 0 a 0\nR1 a b 2k\nR2 b 0 1k\n", "v(a,b)", "I1", 1e3);
    expect(relative(density(r, "onoise"), Math.sqrt(4 * K * T0 * 2e3))).toBeLessThan(1e-6);
    // The source drives through R1, so a current refers back through 2 k.
    expect(relative(density(r, "inoise"), Math.sqrt(4 * K * T0 * 2e3) / 2e3)).toBeLessThan(1e-6);
  });

  it("integrates an RC filter's output noise to kT/C", () => {
    const C = 1e-9;
    const r = simulate("t\nV1 in 0 0\nR1 in out 1k\nC1 out 0 1n\n", {
      type: "noise", output: "v(out)", source: "V1", sweep: "dec", points: 20, fstart: 1, fstop: 1e12,
    });
    const expected = Math.sqrt((K * T0) / C);
    console.log(`kT/C: measured ${r.noise!.onoiseRms.toExponential(5)} V rms, closed form ${expected.toExponential(5)} V rms`);
    expect(relative(r.noise!.onoiseRms, expected)).toBeLessThan(2e-3);
    expect(r.noise!.contributions[0]!.device).toBe("r1");
    expect(r.axis!.unit).toBe("Hz");
    // The same integral does not depend on R.
    const other = simulate("t\nV1 in 0 0\nR1 in out 100k\nC1 out 0 1n\n", {
      type: "noise", output: "v(out)", source: "V1", sweep: "dec", points: 20, fstart: 0.01, fstop: 1e10,
    });
    expect(relative(other.noise!.onoiseRms, expected)).toBeLessThan(2e-3);
  });

  it("gives a diode shot noise of 2qI through its dynamic resistance", () => {
    const I = 1e-3;
    const r = noiseAt("t\nV1 x 0 0\nI1 0 d 1m\nD1 d 0 dm\n.model dm D(IS=1e-14)\n", "v(d)", "V1", 1e4);
    const rd = VT / I;
    expect(relative(density(r, "onoise"), Math.sqrt(2 * Q * I) * rd)).toBeLessThan(2e-3);
  });

  it("adds series resistance and flicker to a diode", () => {
    const I = 1e-3;
    const rd = VT / I;
    const f = 10;
    const kf = 1e-16;
    const r = noiseAt("t\nV1 x 0 0\nI1 0 d 1m\nD1 d 0 dm\n.model dm D(IS=1e-14 RS=10 KF=1e-16 AF=1)\n", "v(d)", "V1", f);
    const psd = (2 * Q * I + (kf * I) / f) * rd * rd + 4 * K * T0 * 10;
    expect(relative(density(r, "onoise"), Math.sqrt(psd))).toBeLessThan(2e-3);
  });

  it("gives a BJT collector shot noise and base-referred flicker", () => {
    const vb = 0.65;
    const Rc = 1e3;
    const is = 1e-14;
    const bf = 100;
    const r = noiseAt(`t
Vcc vcc 0 12
Vb b 0 ${vb}
Rc vcc c 1k
Q1 c b 0 n
.model n NPN(IS=${is} BF=${bf})
`, "v(c)", "Vb", 1e4);
    const ic = is * (Math.exp(vb / VT) - 1);
    const psd = (2 * Q * ic + 4 * K * T0 / Rc) * Rc * Rc;
    expect(relative(density(r, "onoise"), Math.sqrt(psd))).toBeLessThan(5e-3);
    // Gain from the base is gm Rc, the input-referred density divides by it.
    const gm = ic / VT;
    expect(relative(density(r, "inoise"), Math.sqrt(psd) / (gm * Rc))).toBeLessThan(5e-3);
  });

  it("gives MOSFET and JFET channels 2/3 of 4kT gm, with flicker", () => {
    const Rd = 1e3;
    const beta = 100e-6 * 10;
    const vov = 1;
    const gm = beta * vov;
    const mos = noiseAt(`t
Vdd vdd 0 10
Vg g 0 2
Rd vdd d 1k
M1 d g 0 0 n W=10u L=1u
.model n NMOS(VTO=1 KP=100u)
`, "v(d)", "Vg", 1e4);
    const psd = ((8 / 3) * K * T0 * gm + (4 * K * T0) / Rd) * Rd * Rd;
    expect(relative(density(mos, "onoise"), Math.sqrt(psd))).toBeLessThan(5e-3);

    const kf = 1e-24;
    const flick = noiseAt(`t
Vdd vdd 0 10
Vg g 0 2
Rd vdd d 1k
M1 d g 0 0 n W=10u L=1u
.model n NMOS(VTO=1 KP=100u KF=${kf} AF=1 TOX=100n)
`, "v(d)", "Vg", 1);
    const cox = (3.9 * 8.854187817e-12) / 100e-9;
    const id = 0.5 * beta * vov * vov;
    const fn = (kf * id) / (cox * 1e-12);
    expect(relative(density(flick, "onoise"), Math.sqrt(psd + fn * Rd * Rd))).toBeLessThan(5e-3);

    const jgm = 2 * 1e-3 * 2;
    const jf = noiseAt(`t
Vdd vdd 0 10
Vg g 0 0
Rd vdd d 1k
J1 d g 0 jm
.model jm NJF(VTO=-2 BETA=1m)
`, "v(d)", "Vg", 1e4);
    const jpsd = ((8 / 3) * K * T0 * jgm + (4 * K * T0) / Rd) * Rd * Rd;
    expect(relative(density(jf, "onoise"), Math.sqrt(jpsd))).toBeLessThan(5e-3);
  });

  it("reports an unknown output or source", () => {
    expect(() => noiseAt("t\nV1 a 0 1\nR1 a 0 1\n", "v(nosuch)", "V1", 1)).toThrow(SimError);
    expect(() => noiseAt("t\nV1 a 0 1\nR1 a 0 1\n", "v(a)", "R1", 1)).toThrow(/independent source/);
    expect(() => noiseAt("t\nV1 a 0 1\nR1 a 0 1\n", "bogus", "V1", 1)).toThrow(/should look like/);
  });
});

describe("transfer", () => {
  it("solves a divider", () => {
    const r = simulate("t\nV1 in 0 10\nR1 in out 1k\nR2 out 0 3k\n", { type: "transfer", output: "v(out)", source: "V1" });
    expect(relative(r.transfer!.gain, 0.75)).toBeLessThan(1e-6);
    expect(relative(r.transfer!.inputResistance, 4e3)).toBeLessThan(1e-6);
    expect(relative(r.transfer!.outputResistance, 750)).toBeLessThan(1e-6);
    expect(vec(r, "transfer_function").re[0]).toBeCloseTo(0.75, 6);
  });

  it("solves an inverting amplifier with finite gain", () => {
    const A = 1e5;
    const Rin = 1e3;
    const Rf = 10e3;
    const Ro = 100;
    const r = simulate(`inverting
V1 in 0 0
R1 in inv 1k
R2 inv out 10k
E1 x 0 0 inv 1e5
Ro x out 100
`, { type: "transfer", output: "v(out)", source: "V1" });
    // Closed form by nodal analysis of the finite-gain, finite-Ro amplifier.
    const beta = Rin / (Rin + Rf);
    const gain = (-Rf / Rin) * (1 / (1 + 1 / (A * beta))) ;
    expect(relative(r.transfer!.gain, gain)).toBeLessThan(2e-3);
    const inR = Rin + (Rf + Ro) / (1 + A);
    expect(relative(r.transfer!.inputResistance, inR)).toBeLessThan(1e-4);
    const outR = Ro / (1 + A * beta);
    expect(relative(r.transfer!.outputResistance, outR)).toBeLessThan(5e-3);
  });

  it("handles a current source input and a current output", () => {
    const r = simulate("t\nI1 0 a 1m\nR1 a 0 2k\nV2 a b 0\nR2 b 0 2k\n", { type: "transfer", output: "i(v2)", source: "I1" });
    expect(relative(r.transfer!.gain, 0.5)).toBeLessThan(1e-6);
    expect(relative(r.transfer!.inputResistance, 1e3)).toBeLessThan(1e-6);
    expect(relative(r.transfer!.outputResistance, 4e3)).toBeLessThan(1e-6);
  });

  it("linearises a nonlinear circuit at its bias point", () => {
    const r = simulate("t\nV1 in 0 5\nR1 in d 1k\nD1 d 0 dm\n.model dm D(IS=1e-14)\n", { type: "transfer", output: "v(d)", source: "V1" });
    const b = simulate("t\nV1 in 0 5\nR1 in d 1k\nD1 d 0 dm\n.model dm D(IS=1e-14)\n", { type: "op" });
    const rd = VT / ((5 - op(b, "v(d)")) / 1e3);
    expect(relative(r.transfer!.gain, rd / (rd + 1e3))).toBeLessThan(1e-3);
    expect(relative(r.transfer!.outputResistance, (rd * 1e3) / (rd + 1e3))).toBeLessThan(1e-3);
  });
});

describe("sensitivity", () => {
  const row = (r: SimResult, device: string): { absolute: number; normalized: number; value: number } => {
    const found = r.sensitivity!.find((s) => s.device === device);
    if (!found) throw new Error(`no row for ${device}`);
    return found;
  };

  it("solves a divider in absolute and normalized form", () => {
    const r = simulate("t\nV1 in 0 10\nR1 in out 1k\nR2 out 0 3k\n", { type: "sensitivity", output: "v(out)" });
    // Vout = V R2 / (R1 + R2).
    expect(relative(row(r, "r1").absolute, (-10 * 3e3) / 16e6)).toBeLessThan(1e-6);
    expect(relative(row(r, "r2").absolute, (10 * 1e3) / 16e6)).toBeLessThan(1e-6);
    expect(relative(row(r, "v1").absolute, 0.75)).toBeLessThan(1e-6);
    expect(relative(row(r, "r1").normalized, -0.25)).toBeLessThan(1e-6);
    expect(relative(row(r, "r2").normalized, 0.25)).toBeLessThan(1e-6);
    expect(relative(row(r, "v1").normalized, 1)).toBeLessThan(1e-6);
    expect(row(r, "r1").value).toBe(1000);
    expect(r.sensitivity![0]!.parameter).toBeDefined();
  });

  it("covers current sources", () => {
    const r = simulate("t\nI1 0 a 2m\nR1 a 0 1k\n", { type: "sensitivity", output: "v(a)" });
    expect(relative(row(r, "i1").absolute, 1e3)).toBeLessThan(1e-6);
    expect(relative(row(r, "r1").absolute, 2e-3)).toBeLessThan(1e-6);
    expect(relative(row(r, "r1").normalized, 1)).toBeLessThan(1e-6);
  });

  it("agrees with a finite difference in a nonlinear circuit", () => {
    const circuit = (r1: number, v: number): string => `t\nV1 in 0 ${v}\nR1 in d ${r1}\nD1 d 0 dm\nR2 d 0 10k\n.model dm D(IS=1e-14)\n`;
    const base = simulate(circuit(1000, 5), { type: "sensitivity", output: "v(d)" });
    const h = 1;
    const up = op(simulate(circuit(1000 + h, 5), { type: "op" }), "v(d)");
    const dn = op(simulate(circuit(1000 - h, 5), { type: "op" }), "v(d)");
    expect(relative(row(base, "r1").absolute, (up - dn) / (2 * h))).toBeLessThan(2e-2);
  });
});

describe("polezero", () => {
  const poles = (r: SimResult): { re: number; im: number }[] => {
    const v = vec(r, "pole");
    return Array.from(v.re, (re, i) => ({ re, im: v.im![i]! }));
  };
  const zeros = (r: SimResult): { re: number; im: number }[] => {
    const v = vec(r, "zero");
    return Array.from(v.re, (re, i) => ({ re, im: v.im![i]! }));
  };

  it("finds the RC pole and no finite zero", () => {
    const r = simulate("t\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n", { type: "polezero", input: ["in", "0"], output: ["out", "0"] });
    const p = poles(r);
    expect(p.length).toBe(1);
    expect(relative(p[0]!.re, -1000)).toBeLessThan(1e-9);
    expect(p[0]!.im).toBe(0);
    expect(zeros(r).length).toBe(0);
  });

  it("finds the high-pass zero at the origin", () => {
    const r = simulate("t\nV1 in 0 AC 1\nC1 in out 1u\nR1 out 0 1k\n", { type: "polezero", input: ["in", "0"], output: ["out", "0"] });
    expect(relative(poles(r)[0]!.re, -1000)).toBeLessThan(1e-9);
    const z = zeros(r);
    expect(z.length).toBe(1);
    expect(Math.hypot(z[0]!.re, z[0]!.im)).toBeLessThan(1e-3);
  });

  it("finds Q = 2 series RLC poles against the closed form", () => {
    const R = 10;
    const L = 20e-3;
    const C = 50e-6;
    const w0 = 1 / Math.sqrt(L * C);
    const Qf = Math.sqrt(L / C) / R;
    expect(Qf).toBeCloseTo(2, 9);
    const r = simulate("t\nV1 in 0 AC 1\nL1 in a 20m\nR1 a out 10\nC1 out 0 50u\n", { type: "polezero", input: ["in", "0"], output: ["out", "0"] });
    const p = poles(r);
    expect(p.length).toBe(2);
    const alpha = w0 / (2 * Qf);
    const wd = w0 * Math.sqrt(1 - 1 / (4 * Qf * Qf));
    expect(relative(p[0]!.re, -alpha)).toBeLessThan(1e-9);
    expect(relative(Math.abs(p[0]!.im), wd)).toBeLessThan(1e-9);
    expect(p[1]!.re).toBe(p[0]!.re);
    expect(p[1]!.im).toBe(-p[0]!.im);
    expect(zeros(r).length).toBe(0);
  });

  it("finds a parallel-LC notch's imaginary zeros", () => {
    // Series LC to ground from the output: zeros at +- j / sqrt(LC).
    const r = simulate("t\nV1 in 0 AC 1\nR1 in out 1k\nL1 out a 1m\nC1 a 0 1u\n", { type: "polezero", input: ["in", "0"], output: ["out", "0"] });
    const z = zeros(r);
    const w0 = 1 / Math.sqrt(1e-3 * 1e-6);
    expect(z.length).toBe(2);
    expect(Math.abs(z[0]!.re)).toBeLessThan(1e-3 * w0);
    expect(relative(Math.abs(z[0]!.im), w0)).toBeLessThan(1e-6);
  });

  it("matches every pole of a 60-section RC ladder", () => {
    const N = 60;
    const lines = ["ladder", "V1 n0 0 AC 1"];
    for (let i = 1; i <= N; i++) {
      lines.push(`R${i} n${i - 1} n${i} 1k`);
      lines.push(`C${i} n${i} 0 1n`);
    }
    const r = simulate(lines.join("\n") + "\n", { type: "polezero", input: ["n0", "0"], output: [`n${N}`, "0"] });
    const p = poles(r);
    expect(p.length).toBe(N);
    const rc = 1e3 * 1e-9;
    const exact: number[] = [];
    for (let k = 1; k <= N; k++) exact.push(-(4 / rc) * Math.sin(((2 * k - 1) * Math.PI) / (4 * N + 2)) ** 2);
    for (let k = 0; k < N; k++) {
      expect(p[k]!.im).toBe(0);
      expect(relative(p[k]!.re, exact[k]!)).toBeLessThan(1e-7);
    }
    // The fastest and slowest differ by about 3 decades and both are right.
    expect(exact[N - 1]! / exact[0]!).toBeGreaterThan(1000);
  });

  it("linearises a transistor stage at its bias point", () => {
    const r = simulate(`ce
Vcc vcc 0 12
Vb b 0 DC 0.65 AC 1
Rc vcc c 1k
Cl c 0 1n
Q1 c b 0 n
.model n NPN(IS=1e-14 BF=100)
`, { type: "polezero", input: ["b", "0"], output: ["c", "0"] });
    const p = poles(r);
    // With no Early effect the collector node pole is 1 / (Rc Cl).
    expect(p.some((s) => relative(s.re, -1e6) < 1e-3 && s.im === 0)).toBe(true);
  });

  it("reports a test current input and refuses oversized circuits", () => {
    const r = simulate("t\nI1 0 a 0\nR1 a 0 1k\nC1 a 0 1u\n", { type: "polezero", input: ["a", "0"], output: ["a", "0"] });
    expect(relative(poles(r)[0]!.re, -1000)).toBeLessThan(1e-9);
    expect(r.warnings.join()).toMatch(/per input current/);
    const lines = ["big", "V1 n0 0 1"];
    for (let i = 1; i <= 400; i++) lines.push(`R${i} n${i - 1} n${i} 1`, `C${i} n${i} 0 1n`);
    let error: unknown;
    try {
      simulate(lines.join("\n") + "\n", { type: "polezero", input: ["n0", "0"], output: ["n400", "0"] });
    } catch (e) {
      error = e;
    }
    expect((error as SimError).code).toBe("unsupported");
    expect((error as SimError).message).toMatch(/limited to/);
  });

  it("finds eigenvalues of a small dense matrix", () => {
    // Characteristic polynomial (x - 1)(x^2 + 4), eigenvalues 1 and +- 2j.
    const m = Float64Array.from([1, 2, 0, -2, 1, 3, 0, 0, -1].map((v) => v));
    const eig = hessenbergQr(3, m);
    const trace = eig.reduce((sum, e) => sum + e.re, 0);
    expect(trace).toBeCloseTo(1, 9);
  });
});
