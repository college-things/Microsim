import { describe, expect, it } from "vitest";
import { ivCurves } from "../../src/core/ivcurves";
import { simulate } from "../../src/engine";

const run = async (text: string, request: Parameters<typeof simulate>[1]) => simulate(text, request);
const interpolate = (x: Float64Array, y: Float64Array, at: number) => {
  for (let i = 1; i < x.length; i++) if ((x[i - 1] - at) * (x[i] - at) <= 0) return y[i - 1] + ((y[i] - y[i - 1]) * (at - x[i - 1])) / (x[i] - x[i - 1] || 1);
  return NaN;
};

describe("IV analyzer", () => {
  it("traces a diode: blocking in reverse, conducting from about 0.6 V", async () => {
    const [curve] = await ivCurves("* diode\nD1 a k DMOD\n.model DMOD D(IS=1e-14 N=1)\nRk k 0 1m\n.end", { "1": "a", "2": "0", "3": undefined }, { mode: "two-terminal", vmax: 0.8, start: -2, points: 280 }, run);
    expect(Math.abs(interpolate(curve.volts, curve.amps, -1))).toBeLessThan(1e-9);
    expect(interpolate(curve.volts, curve.amps, 0.5)).toBeLessThan(1e-4);
    // Shockley: I = Is (exp(V / Vt) - 1), Vt about 25.85 mV at 27 C.
    const expected = 1e-14 * (Math.exp(0.7 / 0.025852) - 1);
    expect(interpolate(curve.volts, curve.amps, 0.7) / expected).toBeGreaterThan(0.8);
    expect(interpolate(curve.volts, curve.amps, 0.7) / expected).toBeLessThan(1.25);
  });
  it("draws NPN output curves that rise with base current, near beta x Ib in the active region", async () => {
    const curves = await ivCurves("* npn\nQ1 c b e QN\n.model QN NPN(BF=100 IS=1e-14 VAF=1000)\n.end", { "1": "c", "2": "b", "3": "e" }, { mode: "npn", vmax: 10, steps: [10e-6, 20e-6] }, run);
    expect(curves.map((c) => c.label)).toEqual(["Ib = 10 uA", "Ib = 20 uA"]);
    const at5 = curves.map((c) => interpolate(c.volts, c.amps, 5));
    expect(at5[0]).toBeGreaterThan(0.9e-3);
    expect(at5[0]).toBeLessThan(1.1e-3);
    expect(at5[1] / at5[0]).toBeCloseTo(2, 1);
  });
  it("draws PNP curves with positive axes, like the NPN ones", async () => {
    const [curve] = await ivCurves("* pnp\nQ1 c b e QP\n.model QP PNP(BF=50 IS=1e-14)\n.end", { "1": "c", "2": "b", "3": "e" }, { mode: "pnp", vmax: 5, steps: [20e-6] }, run);
    expect(curve.volts[curve.volts.length - 1]).toBeCloseTo(5, 6);
    expect(interpolate(curve.volts, curve.amps, 3)).toBeCloseTo(1e-3, 4);
  });
  it("asks for missing pins", async () => {
    await expect(ivCurves("* x\n.end", { "1": "a", "2": undefined, "3": undefined }, { mode: "two-terminal", vmax: 1 }, run)).rejects.toThrow("Connect pin 2");
  });
});

describe("IV analyzer on a floating device", () => {
  it("still traces a diode wired to nothing but the analyzer", async () => {
    const [curve] = await ivCurves("* floating\nD1 a k DMOD\n.model DMOD D(IS=1e-14)\n.end", { "1": "a", "2": "k", "3": undefined }, { mode: "two-terminal", vmax: 0.8 }, run);
    expect(interpolate(curve.volts, curve.amps, 0.7)).toBeGreaterThan(1e-3);
  });
});
