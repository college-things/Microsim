import { describe, expect, it } from "vitest";
import { simulate } from "../../src/engine";
import type { SimResult } from "../../src/core/sim";
import { at, mag, vec, VT } from "./helpers";

/** Time-weighted mean of a vector over [t0, t1]. */
function mean(r: SimResult, name: string, t0: number, t1: number): number {
  const t = r.axis!.re;
  const y = vec(r, name).re;
  let s = 0;
  let w = 0;
  for (let i = 1; i < t.length; i++) {
    if (t[i - 1]! >= t0 && t[i]! <= t1) {
      const dt = t[i]! - t[i - 1]!;
      s += 0.5 * (y[i]! + y[i - 1]!) * dt;
      w += dt;
    }
  }
  return s / w;
}

function extremes(r: SimResult, name: string, t0: number, t1: number): { min: number; max: number } {
  const t = r.axis!.re;
  const y = vec(r, name).re;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < t.length; i++) {
    if (t[i]! >= t0 && t[i]! <= t1) {
      if (y[i]! < min) min = y[i]!;
      if (y[i]! > max) max = y[i]!;
    }
  }
  return { min, max };
}

/** Times of upward crossings of level, by interpolation. */
function risingCrossings(r: SimResult, name: string, level: number, t0: number): number[] {
  const t = r.axis!.re;
  const y = vec(r, name).re;
  const out: number[] = [];
  for (let i = 1; i < t.length; i++) {
    if (t[i]! >= t0 && y[i - 1]! < level && y[i]! >= level) {
      out.push(t[i - 1]! + ((level - y[i - 1]!) / (y[i]! - y[i - 1]!)) * (t[i]! - t[i - 1]!));
    }
  }
  return out;
}

describe("switching circuits", () => {
  it("regulates a buck converter to duty * Vin less the diode drop share", () => {
    const r = simulate(`buck
Vin in 0 12
Vg g 0 PULSE(0 10 0 10n 10n 4.98u 10u)
S1 in sw g 0 sm
D1 0 sw dm
L1 sw out 100u
C1 out 0 100u
R1 out 0 10
.model sm SW(VT=5 RON=0.01 ROFF=1e7)
.model dm D(IS=1e-14)
`, { type: "tran", tstep: 100e-9, tstop: 6e-3 });
    const vout = mean(r, "v(out)", 5e-3, 6e-3);
    const iload = vout / 10;
    const vd = VT * Math.log(iload / 1e-14);
    const expected = 0.5 * 12 - 0.5 * vd - 0.5 * 0.01 * iload;
    expect(Math.abs(vout - expected)).toBeLessThan(0.15);
  });

  it("oscillates a BJT astable at 1.386 R C", () => {
    const R = 47e3;
    const C = 10e-9;
    const r = simulate(`astable
Vcc vcc 0 9
Rc1 vcc c1 1k
Rc2 vcc c2 1k
Rb1 vcc b1 47k
Rb2 vcc b2 47k
C1 c1 b2 10n
C2 c2 b1 10n
Q1 c1 b1 0 n
Q2 c2 b2 0 n
.ic v(b1)=0.7 v(b2)=-5 v(c1)=0.1 v(c2)=9
.model n NPN(IS=1e-14 BF=100 CJE=2p CJC=1p TF=300p)
`, { type: "tran", tstep: 1e-6, tstop: 6e-3, uic: true });
    const edges = risingCrossings(r, "v(c1)", 4.5, 1e-3);
    expect(edges.length).toBeGreaterThanOrEqual(5);
    const period = (edges[edges.length - 1]! - edges[0]!) / (edges.length - 1);
    // Textbook value is 2 ln 2 R C; finite Vbe and Vcesat move it by a few percent.
    expect(Math.abs(period - 2 * Math.LN2 * R * C) / (2 * Math.LN2 * R * C)).toBeLessThan(0.1);
  });

  it("runs a three-stage CMOS ring oscillator at full swing", () => {
    let n = "ring\nVdd vdd 0 3\n";
    const nodes = ["a", "b", "c"];
    for (let i = 0; i < 3; i++) {
      const input = nodes[i]!;
      const output = nodes[(i + 1) % 3]!;
      n += `Mp${i} ${output} ${input} vdd vdd pm W=20u L=1u\n`;
      n += `Mn${i} ${output} ${input} 0 0 nm W=10u L=1u\n`;
      n += `Cl${i} ${output} 0 50f\n`;
    }
    n += ".ic v(a)=0 v(b)=3 v(c)=0\n";
    n += ".model nm NMOS(VTO=0.7 KP=100u LAMBDA=0.01 CGSO=0.2n CGDO=0.2n CBD=5f CBS=5f)\n";
    n += ".model pm PMOS(VTO=-0.7 KP=50u LAMBDA=0.01 CGSO=0.2n CGDO=0.2n CBD=5f CBS=5f)\n";
    const r = simulate(n, { type: "tran", tstep: 5e-12, tstop: 5e-9, uic: true });
    const { min, max } = extremes(r, "v(a)", 2e-9, 5e-9);
    expect(max).toBeGreaterThan(2.7);
    expect(min).toBeLessThan(0.3);
    const edges = risingCrossings(r, "v(a)", 1.5, 1e-9);
    expect(edges.length).toBeGreaterThanOrEqual(3);
    // Each stage drives about 80 fF; tp = C V / (2 Id) at Vgs = 3 V, with Id = 0.5 KP W/L (2.3)^2.
    const id = 0.5 * 100e-6 * 10 * 2.3 ** 2;
    const tp = (80e-15 * 3) / (2 * id);
    const period = (edges[edges.length - 1]! - edges[0]!) / (edges.length - 1);
    expect(period).toBeGreaterThan(6 * tp * 0.5);
    expect(period).toBeLessThan(6 * tp * 3);
  });

  it("handles an unannounced jump from a behavioural step", () => {
    const r = simulate(`jump
B1 in 0 V=u(time-1m)
R1 in out 1k
C1 out 0 100n
`, { type: "tran", tstep: 2e-6, tstop: 2e-3 });
    const tau = 1e-4;
    expect(Math.abs(at(r, "v(out)", 0.9e-3))).toBeLessThan(1e-6);
    expect(Math.abs(at(r, "v(out)", 1.2e-3) - (1 - Math.exp(-2)))).toBeLessThan(5e-3);
    expect(Math.abs(at(r, "v(out)", 1e-3 + 3 * tau) - (1 - Math.exp(-3)))).toBeLessThan(5e-3);
  });
});

describe("power and analog circuits", () => {
  it("smooths a bridge rectifier with the textbook ripple", () => {
    const r = simulate(`bridge
V1 a b SIN(0 10 60)
D1 a p dm
D2 b p dm
D3 0 a dm
D4 0 b dm
C1 p 0 1000u
R1 p 0 100
.model dm D(IS=1e-14)
`, { type: "tran", tstep: 20e-6, tstop: 200e-3 });
    const { min, max } = extremes(r, "v(p)", 100e-3, 200e-3);
    // Peak is the source less two diode drops at the charging peak.
    expect(max).toBeGreaterThan(10 - 2 * 0.9);
    expect(max).toBeLessThan(10 - 2 * 0.6);
    const ripple = max / (100 * 2 * 60 * 1000e-6);
    expect(Math.abs(max - min - ripple) / ripple).toBeLessThan(0.3);
  });

  it("clamps through a Zener both ways across a DC sweep", () => {
    const r = simulate(`zener sweep
V1 a 0 0
R1 a d 100
D1 d 0 z
.model z D(IS=1e-12 BV=5 IBV=1m RS=1)
`, { type: "dc", source: "v1", start: -20, stop: 5, step: 0.25 });
    const v = vec(r, "v(d)").re;
    expect(v[0]!).toBeGreaterThan(-6.5);
    expect(v[0]!).toBeLessThan(-5);
    expect(at(r, "v(d)", 5)).toBeLessThan(0.8);
    expect(Math.abs(at(r, "v(d)", -3) + 3)).toBeLessThan(1e-3);
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThan(v[i - 1]! - 1e-9);
  });

  it("gives a differential pair the gain gm Rc / 2", () => {
    const r = simulate(`diff pair
Vcc vcc 0 10
Vee vee 0 -10
Ibias e vee 2m
Vp bp 0 DC 0 AC 1m
Vn bn 0 0
Rc1 vcc c1 2k
Rc2 vcc c2 2k
Q1 c1 bp e n
Q2 c2 bn e n
.model n NPN(IS=1e-14 BF=200)
`, { type: "ac", sweep: "lin", points: 1, fstart: 1e3, fstop: 1e3 });
    const ic = 1e-3 * (200 / 201);
    const gain = ((ic / VT) * 2e3) / 2;
    expect(Math.abs(mag(vec(r, "v(c1)"), 0) / 1e-3 - gain) / gain).toBeLessThan(5e-3);
  });

  it("integrates a square wave into a triangle with an E-source op-amp", () => {
    const r = simulate(`integrator
Vin in 0 PULSE(-1 1 0 1u 1u 499u 1m)
R1 in inv 10k
C1 inv out 10n
Rf inv out 10meg
E1 out 0 0 inv 1e5
`, { type: "tran", tstep: 1e-6, tstop: 4e-3, uic: true });
    // Slope is Vin / (R C) = 1e4 V/s in magnitude: 5 V over a half period.
    const { min, max } = extremes(r, "v(out)", 2e-3, 4e-3);
    expect(Math.abs(max - min - 5)).toBeLessThan(0.1);
  });

  it("keeps LC amplitude and frequency over 100 cycles", () => {
    const L = 1e-3;
    const C = 1e-6;
    const T = 2 * Math.PI * Math.sqrt(L * C);
    const r = simulate(`lc
L1 a 0 1m
C1 a 0 1u IC=1
`, { type: "tran", tstep: T / 100, tstop: 100 * T, uic: true });
    const { max } = extremes(r, "v(a)", 99 * T, 100 * T);
    expect(max).toBeGreaterThan(0.98);
    expect(max).toBeLessThan(1.02);
    const edges = risingCrossings(r, "v(a)", 0, T);
    const period = (edges[edges.length - 1]! - edges[0]!) / (edges.length - 1);
    expect(Math.abs(period - T) / T).toBeLessThan(1e-3);
  });

  it("drives a capacitor divider through the fast edge", () => {
    const r = simulate(`caps
V1 a 0 PWL(0 0 1n 1 1 1)
C1 a m 1u
C2 m 0 3u
R1 m 0 1g
`, { type: "tran", tstep: 1e-6, tstop: 100e-6 });
    expect(Math.abs(at(r, "v(m)", 50e-6) - 0.25)).toBeLessThan(1e-3);
  });
});

describe("time and value scales", () => {
  for (const [tau, label] of [[1e-12, "picoseconds"], [1e-6, "microseconds"], [100, "hundreds of seconds"]] as [number, string][]) {
    it(`integrates an RC with a time constant of ${label}`, () => {
      const cap = tau / 1e3;
      const r = simulate(`scale
V1 a 0 1
R1 a b 1k
C1 b 0 ${cap}
`, { type: "tran", tstep: tau / 100, tstop: 3 * tau, uic: true });
      expect(Math.abs(at(r, "v(b)", tau) - (1 - Math.exp(-1)))).toBeLessThan(1e-3);
      expect(Math.abs(at(r, "v(b)", 3 * tau) - (1 - Math.exp(-3)))).toBeLessThan(1e-3);
    });
  }

  it("scales to kilovolts and nanoamps", () => {
    const r = simulate(`scale
V1 a 0 5k
R1 a b 1g
R2 b 0 1g
D1 b 0 dm
.model dm D(IS=1e-14 BV=10k)
`, { type: "op" });
    const vb = vec(r, "v(b)").re[0]!;
    const i = 5e3 / 1e9 - 2 * (vb / 1e9);
    expect(vb).toBeGreaterThan(0.2);
    expect(vb).toBeLessThan(0.7);
    expect(Number.isFinite(i)).toBe(true);
  });

  it("finds a stiff transient through RC with many decades of time constants", () => {
    const r = simulate(`stiff
V1 a 0 PULSE(0 1 0 1n 1n 10 20)
R1 a b 1
C1 b 0 1n
R2 b c 1meg
C2 c 0 1u
`, { type: "tran", tstep: 10e-3, tstop: 3 });
    expect(Math.abs(at(r, "v(c)", 2.9) - (1 - Math.exp(-2.9)))).toBeLessThan(2e-3);
    expect(r.stats.steps).toBeLessThan(3000);
  });
});
