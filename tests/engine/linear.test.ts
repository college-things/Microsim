import { describe, expect, it } from "vitest";
import { simulate } from "../../src/engine";
import { at, mag, nearest, op, phaseDeg, vec } from "./helpers";

describe("resistive DC", () => {
  it("solves a divider and reports source current with the SPICE sign", () => {
    const r = simulate(`divider
V1 in 0 10
R1 in out 1k
R2 out 0 3k
`, { type: "op" });
    expect(Math.abs(op(r, "v(out)") - 7.5)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(in)") - 10)).toBeLessThan(1e-9);
    expect(Math.abs(op(r, "i(v1)") + 2.5e-3)).toBeLessThan(1e-9);
    expect(r.analysis).toBe("op");
    expect(r.axis).toBeUndefined();
    expect(r.stats.unknowns).toBe(3);
  });

  it("sweeps a source in either direction, hitting both endpoints", () => {
    const n = `sweep
V1 a 0 0
R1 a b 1k
R2 b 0 1k
`;
    const up = simulate(n, { type: "dc", source: "V1", start: 0, stop: 5, step: 1 });
    expect(Array.from(up.axis!.re)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(up.axis!.unit).toBe("V");
    expect(Math.abs(vec(up, "v(b)").re[5]! - 2.5)).toBeLessThan(1e-6);
    const down = simulate(n, { type: "dc", source: "v1", start: 5, stop: 0, step: 1 });
    expect(down.axis!.re[5]).toBe(0);
    expect(Math.abs(vec(down, "v(b)").re[0]! - 2.5)).toBeLessThan(1e-6);
  });

  it("reports a sweep over an unknown source", () => {
    expect(() => simulate("t\nR1 a 0 1\n", { type: "dc", source: "v9", start: 0, stop: 1, step: 1 })).toThrowError(/v9/);
  });

  it("applies current source direction from n+ through the source to n-", () => {
    const r = simulate("t\nI1 0 a 2m\nR1 a 0 1k\n", { type: "op" });
    expect(Math.abs(op(r, "v(a)") - 2)).toBeLessThan(1e-6);
  });

  it("implements E, G, F and H controlled sources", () => {
    const r = simulate(`controlled
V1 c 0 2
E1 e 0 c 0 3
Re e 0 1k
G1 0 g c 0 1m
Rg g 0 1k
Vs in x 0
Rs x 0 1k
Vi in 0 1
F1 0 f Vs 2
Rf f 0 1k
H1 h 0 Vs 500
Rh h 0 1k
`, { type: "op" });
    expect(Math.abs(op(r, "v(e)") - 6)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(g)") - 2)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(f)") - 2)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(h)") - 0.5)).toBeLessThan(1e-6);
  });

  it("builds an inverting op-amp from an E source", () => {
    const r = simulate(`op-amp
Vin in 0 1
R1 in inv 1k
Rf inv out 10k
E1 out 0 0 inv 1e6
`, { type: "op" });
    // Closed form with finite gain A: Vout = -Rf/R1 * Vin / (1 + (1 + Rf/R1) / A).
    const expected = -10 / (1 + 11 / 1e6);
    expect(Math.abs(op(r, "v(out)") - expected)).toBeLessThan(1e-5);
    expect(Math.abs(op(r, "v(inv)"))).toBeLessThan(2e-5);
  });
});

describe("transient linear", () => {
  const rc = `rc step
V1 in 0 PULSE(0 1 0 1n 1n 1 2)
R1 in out 1k
C1 out 0 1u
`;

  it("follows the RC step response at several time constants", () => {
    const tau = 1e-3;
    const r = simulate(rc, { type: "tran", tstep: 10e-6, tstop: 5 * tau });
    expect(r.axis!.name).toBe("time");
    expect(r.axis!.unit).toBe("s");
    for (const k of [0.5, 1, 2, 3, 5]) {
      const expected = 1 - Math.exp(-k);
      expect(Math.abs(at(r, "v(out)", k * tau) - expected)).toBeLessThan(5e-4);
    }
    expect(r.axis!.re[r.axis!.re.length - 1]).toBeCloseTo(5 * tau, 12);
  });

  it("adapts the step: a large tstep and tmax still resolve the transient", () => {
    const r = simulate(rc, { type: "tran", tstep: 1e-3, tstop: 5e-3, tmax: 1e-3 });
    expect(r.stats.steps).toBeGreaterThan(5);
    expect(Math.abs(at(r, "v(out)", 3e-3) - (1 - Math.exp(-3)))).toBeLessThan(5e-3);
  });

  it("honours tmax as an upper bound on the step", () => {
    const r = simulate(rc, { type: "tran", tstep: 1e-3, tstop: 5e-3, tmax: 20e-6 });
    const t = r.axis!.re;
    let largest = 0;
    for (let i = 1; i < t.length; i++) largest = Math.max(largest, t[i]! - t[i - 1]!);
    expect(largest).toBeLessThanOrEqual(20e-6 * (1 + 1e-9));
  });

  it("trims output before tstart without changing the waveform", () => {
    const r = simulate(rc, { type: "tran", tstep: 10e-6, tstop: 3e-3, tstart: 2e-3 });
    expect(r.axis!.re[0]).toBeCloseTo(2e-3, 12);
    expect(Math.abs(vec(r, "v(out)").re[0]! - (1 - Math.exp(-2)))).toBeLessThan(5e-4);
  });

  it("starts from capacitor IC= under uic", () => {
    const r = simulate(`discharge
R1 out 0 1k
C1 out 0 1u IC=2
`, { type: "tran", tstep: 10e-6, tstop: 3e-3, uic: true });
    expect(Math.abs(vec(r, "v(out)").re[0]! - 2)).toBeLessThan(1e-3);
    expect(Math.abs(at(r, "v(out)", 1e-3) - 2 * Math.exp(-1))).toBeLessThan(2e-3);
  });

  it("starts from inductor IC= under uic", () => {
    const r = simulate(`rl decay
L1 a 0 1m IC=1
R1 a 0 1
`, { type: "tran", tstep: 5e-6, tstop: 2e-3, uic: true });
    expect(Math.abs(vec(r, "i(l1)").re[0]! - 1)).toBeLessThan(1e-9);
    expect(Math.abs(at(r, "i(l1)", 1e-3) - Math.exp(-1))).toBeLessThan(2e-3);
  });

  it("uses .ic both with and without uic", () => {
    const n = `ic
.ic v(out)=3
R1 out 0 1k
C1 out 0 1u
`;
    for (const uic of [true, false]) {
      const r = simulate(n, { type: "tran", tstep: 10e-6, tstop: 2e-3, uic });
      expect(Math.abs(vec(r, "v(out)").re[0]! - 3)).toBeLessThan(1e-3);
      expect(Math.abs(at(r, "v(out)", 1e-3) - 3 * Math.exp(-1))).toBeLessThan(3e-3);
    }
  });

  it("uses source t=0 value for the initial operating point", () => {
    const r = simulate("t\nV1 a 0 SIN(2 1 1k)\nR1 a 0 1k\n", { type: "tran", tstep: 1e-5, tstop: 1e-3 });
    expect(Math.abs(vec(r, "v(a)").re[0]! - 2)).toBeLessThan(1e-6);
    expect(Math.abs(at(r, "v(a)", 0.25e-3) - 3)).toBeLessThan(1e-3);
  });

  it("rings an RLC at the damped natural frequency", () => {
    const L = 1e-3;
    const C = 1e-6;
    const R = 2;
    const alpha = R / (2 * L);
    const wd = Math.sqrt(1 / (L * C) - alpha * alpha);
    const r = simulate(`rlc ring
L1 a b 1m IC=0
R1 b 0 2
C1 a 0 1u IC=1
`, { type: "tran", tstep: 1e-6, tstop: 1e-3, uic: true });
    for (const t of [50e-6, 200e-6, 500e-6, 900e-6]) {
      // Series RLC discharge from v(0)=1, i(0)=0.
      const expected = Math.exp(-alpha * t) * (Math.cos(wd * t) + (alpha / wd) * Math.sin(wd * t));
      expect(Math.abs(at(r, "v(a)", t) - expected)).toBeLessThan(3e-3);
    }
  });

  it("switches with a voltage-controlled switch and hysteresis", () => {
    const r = simulate(`switch
V1 in 0 5
Vc c 0 PWL(0 0 1m 0 1.001m 5 2m 5 2.001m 0 3m 0)
S1 in out c 0 sw1
R1 out 0 1k
.model sw1 SW(VT=2.5 VH=0.5 RON=1 ROFF=1e9)
`, { type: "tran", tstep: 10e-6, tstop: 3e-3 });
    expect(at(r, "v(out)", 0.5e-3)).toBeLessThan(0.01);
    expect(Math.abs(at(r, "v(out)", 1.5e-3) - 5 * (1000 / 1001))).toBeLessThan(0.01);
    expect(at(r, "v(out)", 2.5e-3)).toBeLessThan(0.01);
  });
});

describe("source waveforms", () => {
  it("places points exactly on PULSE corners", () => {
    const r = simulate("t\nV1 a 0 PULSE(1 3 1u 0.5u 0.25u 2u 5u)\nR1 a 0 1k\n", {
      type: "tran", tstep: 0.2e-6, tstop: 12e-6,
    });
    const t = r.axis!.re;
    const v = vec(r, "v(a)").re;
    const corners: [number, number][] = [
      [1e-6, 1], [1.5e-6, 3], [3.5e-6, 3], [3.75e-6, 1],
      [6e-6, 1], [6.5e-6, 3], [8.5e-6, 3], [8.75e-6, 1],
    ];
    for (const [tc, vc] of corners) {
      const i = nearest(t, tc);
      expect(Math.abs(t[i]! - tc)).toBeLessThan(1e-14);
      expect(Math.abs(v[i]! - vc)).toBeLessThan(1e-6);
    }
    expect(Math.abs(at(r, "v(a)", 1.25e-6) - 2)).toBeLessThan(1e-3);
  });

  it("places points exactly on PWL corners and holds the ends", () => {
    const r = simulate("t\nV1 a 0 PWL(1m 0 2m 5 2.5m -1 4m -1)\nR1 a 0 1k\n", {
      type: "tran", tstep: 50e-6, tstop: 5e-3,
    });
    const t = r.axis!.re;
    const v = vec(r, "v(a)").re;
    for (const [tc, vc] of [[1e-3, 0], [2e-3, 5], [2.5e-3, -1], [4e-3, -1]] as [number, number][]) {
      const i = nearest(t, tc);
      expect(Math.abs(t[i]! - tc)).toBeLessThan(1e-14);
      expect(Math.abs(v[i]! - vc)).toBeLessThan(1e-6);
    }
    expect(Math.abs(at(r, "v(a)", 1.5e-3) - 2.5)).toBeLessThan(1e-3);
    expect(Math.abs(at(r, "v(a)", 4.9e-3) + 1)).toBeLessThan(1e-6);
  });

  it("evaluates SIN with delay, damping and phase", () => {
    const r = simulate("t\nV1 a 0 SIN(1 2 1k 1m 100 90)\nR1 a 0 1k\n", { type: "tran", tstep: 5e-6, tstop: 3e-3 });
    expect(Math.abs(at(r, "v(a)", 0.5e-3) - 3)).toBeLessThan(1e-6);
    const t = 1.3e-3;
    const u = t - 1e-3;
    const expected = 1 + 2 * Math.exp(-100 * u) * Math.sin(2 * Math.PI * 1000 * u + Math.PI / 2);
    expect(Math.abs(at(r, "v(a)", t) - expected)).toBeLessThan(5e-3);
  });

  it("evaluates EXP", () => {
    const r = simulate("t\nV1 a 0 EXP(0 1 1m 1m 4m 2m)\nR1 a 0 1k\n", { type: "tran", tstep: 10e-6, tstop: 8e-3 });
    const rise = (t: number): number => 1 - Math.exp(-(t - 1e-3) / 1e-3);
    expect(Math.abs(at(r, "v(a)", 2e-3) - rise(2e-3))).toBeLessThan(1e-3);
    const t = 6e-3;
    expect(Math.abs(at(r, "v(a)", t) - (rise(t) - (1 - Math.exp(-(t - 4e-3) / 2e-3))))).toBeLessThan(1e-3);
  });

  it("uses the DC value in .op when both DC and a waveform are given", () => {
    const r = simulate("t\nV1 a 0 DC 7 PULSE(0 1 0 1n 1n 1u 2u) AC 1\nR1 a 0 1k\n", { type: "op" });
    expect(Math.abs(op(r, "v(a)") - 7)).toBeLessThan(1e-6);
  });
});

describe("AC", () => {
  it("gives magnitude and phase of an RC low-pass at the corner", () => {
    const fc = 1 / (2 * Math.PI * 1e3 * 1e-6);
    const r = simulate(`rc lowpass
V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 1u
`, { type: "ac", sweep: "lin", points: 1, fstart: fc, fstop: fc });
    const v = vec(r, "v(out)");
    expect(Math.abs(mag(v, 0) - Math.SQRT1_2)).toBeLessThan(1e-6);
    expect(Math.abs(phaseDeg(v, 0) + 45)).toBeLessThan(1e-4);
    expect(r.axis!.unit).toBe("Hz");
    expect(v.im).toBeDefined();
  });

  it("honours AC magnitude and phase on the source", () => {
    const r = simulate("t\nV1 a 0 AC 2 30\nR1 a 0 1k\n", { type: "ac", sweep: "lin", points: 1, fstart: 1, fstop: 1 });
    const v = vec(r, "v(a)");
    expect(Math.abs(mag(v, 0) - 2)).toBeLessThan(1e-9);
    expect(Math.abs(phaseDeg(v, 0) - 30)).toBeLessThan(1e-6);
  });

  it("generates dec, oct and lin axes", () => {
    const n = "t\nV1 a 0 AC 1\nR1 a 0 1k\n";
    const dec = simulate(n, { type: "ac", sweep: "dec", points: 10, fstart: 1, fstop: 1000 });
    expect(dec.axis!.re.length).toBe(31);
    expect(dec.axis!.re[30]).toBeCloseTo(1000, 6);
    const oct = simulate(n, { type: "ac", sweep: "oct", points: 2, fstart: 1, fstop: 16 });
    expect(oct.axis!.re.length).toBe(9);
    const lin = simulate(n, { type: "ac", sweep: "lin", points: 5, fstart: 10, fstop: 50 });
    expect(Array.from(lin.axis!.re)).toEqual([10, 20, 30, 40, 50]);
  });

  it("finds RLC resonance frequency and Q", () => {
    const R = 10;
    const L = 1e-3;
    const C = 1e-6;
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C));
    const Q = Math.sqrt(L / C) / R;
    const r = simulate(`series rlc across R
V1 in 0 AC 1
L1 in a 1m
C1 a out 1u
R1 out 0 10
`, { type: "ac", sweep: "lin", points: 4001, fstart: 1000, fstop: 21000 });
    const f = r.axis!.re;
    const v = vec(r, "v(out)");
    let peak = 0;
    for (let i = 0; i < f.length; i++) if (mag(v, i) > mag(v, peak)) peak = i;
    expect(Math.abs(f[peak]! - f0) / f0).toBeLessThan(2e-3);
    expect(Math.abs(mag(v, peak) - 1)).toBeLessThan(1e-3);
    // -3 dB points give Q = f0 / bandwidth.
    const crossing = (from: number, dir: number): number => {
      let i = from;
      while (mag(v, i) > Math.SQRT1_2) i += dir;
      const a = mag(v, i);
      const b = mag(v, i - dir);
      return f[i]! + ((Math.SQRT1_2 - a) / (b - a)) * (f[i - dir]! - f[i]!);
    };
    const bw = crossing(peak, 1) - crossing(peak, -1);
    expect(Math.abs(f0 / bw - Q) / Q).toBeLessThan(5e-3);
  });

  it("warns when nothing drives the AC analysis", () => {
    const r = simulate("t\nV1 a 0 5\nR1 a 0 1k\n", { type: "ac", sweep: "lin", points: 1, fstart: 1, fstop: 1 });
    expect(r.warnings.join()).toMatch(/no source/i);
    expect(mag(vec(r, "v(a)"), 0)).toBe(0);
  });
});

describe("mutual inductance", () => {
  const L1 = 1e-3;
  const L2 = 4e-3;
  const k = 0.99;
  const M = k * Math.sqrt(L1 * L2);
  const RL = 1000;
  const n = (src: string): string => `transformer
V1 p 0 ${src}
L1 p 0 1m
L2 s 0 4m
K1 L1 L2 0.99
R1 s 0 1k
`;

  it("matches the two-port transfer function in AC", () => {
    const f = 10e3;
    const w = 2 * Math.PI * f;
    const r = simulate(n("AC 1"), { type: "ac", sweep: "lin", points: 1, fstart: f, fstop: f });
    // V2 = j w M V1 RL / (j w L1 (RL + j w L2) + w^2 M^2), from the coupled loop equations.
    const denRe = -w * w * L1 * L2 + w * w * M * M;
    const denIm = w * L1 * RL;
    const expected = (w * M * RL) / Math.hypot(denRe, denIm);
    expect(Math.abs(mag(vec(r, "v(s)"), 0) - expected) / expected).toBeLessThan(1e-6);
  });

  it("transforms a sine in the time domain", () => {
    const f = 10e3;
    const w = 2 * Math.PI * f;
    const denRe = -w * w * L1 * L2 + w * w * M * M;
    const denIm = w * L1 * RL;
    const expected = (w * M * RL) / Math.hypot(denRe, denIm);
    const r = simulate(n("SIN(0 1 10k)"), { type: "tran", tstep: 0.5e-6, tstop: 2e-3 });
    const t = r.axis!.re;
    const v = vec(r, "v(s)").re;
    let peak = 0;
    for (let i = 0; i < t.length; i++) if (t[i]! > 1.5e-3) peak = Math.max(peak, Math.abs(v[i]!));
    expect(Math.abs(peak - expected) / expected).toBeLessThan(0.01);
  });
});
