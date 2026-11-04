// Numbers a person checks by hand: meter readings, what the solver adds to a circuit, and the
// transient limits that must never leave a plot that looks right and means nothing.
import { describe, expect, it } from "vitest";
import { acRms, findVector, settledMean, settledRms } from "../../src/core/analyses";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { buildNetlist, changesOverTime } from "../../src/core/netlist";
import { Collector } from "../../src/engine/analysis";
import { simulate } from "../../src/engine";

/** A sine sampled the way a run samples it: unevenly, and out of step with its period. */
function sampled(samplesPerPeriod: number, amplitude: number, periods = 5, offset = 0) {
  const time: number[] = [];
  const values: number[] = [];
  let t = 0;
  for (let i = 0; t < periods * 1e-3; i++) {
    time.push(t);
    values.push(offset + amplitude * Math.sin(2000 * Math.PI * t));
    t += (1e-3 / samplesPerPeriod) * (1 + 0.2 * Math.sin(i * 0.7));
  }
  return { time: Float64Array.from(time), values: Float64Array.from(values) };
}

describe("meter readings", () => {
  it("read a sine's rms to well under 0.1% at the density a run gives", () => {
    for (const density of [37, 41, 46]) {
      const { time, values } = sampled(density, 10);
      expect(Math.abs(acRms(values, time) / (10 / Math.SQRT2) - 1)).toBeLessThan(5e-4);
      expect(Math.abs(settledRms(values, time) / (10 / Math.SQRT2) - 1)).toBeLessThan(5e-4);
    }
  });

  it("read a simulated sine, and its power, within 0.1%", () => {
    const r = simulate("t\nV1 a 0 SIN(0 10 1k)\nR1 a 0 1k\n", { type: "tran", tstep: 1e-5, tstop: 10e-3, tmax: 1e-3 / 8 });
    const time = r.axis!.re;
    const v = findVector(r, "v(a)")!.re;
    const i = findVector(r, "i(v1)")!.re;
    expect(Math.abs(acRms(v, time) / (10 / Math.SQRT2) - 1)).toBeLessThan(1e-3);
    const power = settledMean(v.map((x, k) => -x * i[k]), time);
    expect(Math.abs(power / 0.05 - 1)).toBeLessThan(1e-3);
  });

  it("read shapes that aren't sines without bending them into one", () => {
    const run = (source: string) => {
      const r = simulate(`t
V1 a 0 ${source}
R1 a 0 1k
`, { type: "tran", tstep: 1e-5, tstop: 20e-3, tmax: 1e-3 / 8 });
      return acRms(findVector(r, "v(a)")!.re, r.axis!.re);
    };
    expect(Math.abs(run("PULSE(-1 1 0 .5m .5m 1n 1m)") * Math.sqrt(3) - 1)).toBeLessThan(1e-4);
    expect(Math.abs(run("PULSE(-1 1 0 1n 1n .5m 1m)") - 1)).toBeLessThan(1e-4);
  });

  it("show zero DC for a sine rather than solver residue, but keep a real offset", () => {
    const mean = (offset: number) => {
      const r = simulate(`t
V1 a 0 SIN(${offset} 10 1k)
R1 a 0 1k
`, { type: "tran", tstep: 1e-5, tstop: 40e-3, tmax: 1e-3 / 8 });
      return settledMean(findVector(r, "v(a)")!.re, r.axis!.re);
    };
    expect(mean(0)).toBe(0);
    expect(mean(1e-3)).toBeCloseTo(1e-3, 6);
  });

  it("still read a steady level and a signal with no periods", () => {
    const time = Float64Array.from({ length: 50 }, (_, i) => i * 1e-3);
    expect(settledMean(new Float64Array(50).fill(5), time)).toBe(5);
    expect(settledRms(new Float64Array(50).fill(-3), time)).toBeCloseTo(3, 9);
  });
});

describe("what the solver adds", () => {
  const divider = (r: string) => `t\nV1 a 0 12\nR1 a b ${r}\nR2 b 0 ${r}\n`;

  it("leaves a linear circuit of huge resistors alone", () => {
    for (const r of ["1g", "100g", "1t", "10t", "1e15"]) {
      const out = simulate(divider(r), { type: "op" });
      expect(findVector(out, "v(b)")!.re[0]).toBeCloseTo(6, 6);
      expect(Math.abs(findVector(out, "i(v1)")!.re[0]) / (6 / parseFloat(r.replace("1g", "1e9").replace("100g", "1e11").replace("10t", "1e13").replace("1t", "1e12")))).toBeCloseTo(1, 6);
      expect(out.warnings).toEqual([]);
    }
  });

  it("still solves linear nodes with no DC path to ground", () => {
    const out = simulate("t\nV1 a 0 12\nC1 a b 1u\nC2 b c 1u\nR1 c d 1k\nC3 d 0 1u\n", { type: "op" });
    expect(Number.isFinite(findVector(out, "v(c)")!.re[0])).toBe(true);
  });

  it("says when a circuit with semiconductors has a resistor large enough to be affected", () => {
    const circuit = (r: string) => `t\nV1 a 0 12\nD1 a b dm\nR1 b c ${r}\nR2 c 0 ${r}\n.model dm D\n`;
    expect(simulate(circuit("1t"), { type: "op" }).warnings.join()).toMatch(/r1 is so large/i);
    expect(simulate(circuit("10k"), { type: "op" }).warnings.join()).not.toMatch(/so large/);
  });

  it("doesn't warn about a large resistor next to something that conducts", () => {
    const out = simulate("t\nV1 a 0 12\nD1 a b dm\nR1 b 0 1k\nR2 b c 1t\nR3 c 0 1k\n.model dm D\n", { type: "op" });
    expect(out.warnings.join()).not.toMatch(/so large/);
  });
});

describe("a transient over a long time", () => {
  const rc = "t\nV1 a 0 SIN(0 1 1k)\nR1 a b 1k\nC1 b 0 100n\n";

  it("keeps following its source past the old step guard", () => {
    const tstop = 150;
    const out = simulate(rc, { type: "tran", tstop, tstep: tstop / 1000, tmax: tstop / 200 });
    const v = findVector(out, "v(a)")!.re;
    let high = 0;
    for (const y of v) high = Math.max(high, Math.abs(y));
    expect(high).toBeGreaterThan(0.99);
    expect(high).toBeLessThan(1.01);
    expect(out.warnings.join()).not.toMatch(/may not be resolved/);
  }, 60_000);

  it("refuses a run too long to follow its source, and says what would fit", () => {
    const tstop = 10_000;
    expect(() => simulate(rc, { type: "tran", tstop, tstep: tstop / 1000, tmax: tstop / 200 })).toThrow(/Shorten the stop time to at most 2\.5e\+3 s/);
  });

  it("keeps a fast source resolved in a run of any length under the limit", () => {
    const out = simulate("t\nV1 a 0 SIN(0 1 1g)\nR1 a 0 1k\n", { type: "tran", tstep: 1e-3, tstop: 2e-3, tmax: 1e-3 });
    expect(out.stats.steps).toBeGreaterThan(1e7);
  }, 60_000);

  it("thins a steady waveform without losing its shape", () => {
    // Exactly eight steps a period, the steadiest a run can be and the worst case for thinning.
    const col = new Collector([{ name: "v(a)", unit: "V", index: 1 }], 8, false, 2000);
    const x = new Float64Array(2);
    for (let i = 0; i <= 800_000; i++) {
      x[1] = Math.sin((2 * Math.PI * (i % 8)) / 8 + 0.4);
      col.push(i / 8, x);
    }
    col.finish();
    const v = col.vectors()[0]!.re;
    expect(col.decimated).toBe(true);
    let low = Infinity, high = -Infinity;
    for (const y of v.subarray(v.length >> 1)) {
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    expect(high).toBeGreaterThan(0.9);
    expect(low).toBeLessThan(-0.9);
    const axis = col.axisValues();
    for (let i = 1; i < axis.length; i++) expect(axis[i]!).toBeGreaterThan(axis[i - 1]!);
  });
});

describe("what a run reports", () => {
  it("doesn't call nets that reach logic pins unconnected, and hides ports left NULL", () => {
    const flipFlop = EXAMPLES.find((e) => /flip-flop/i.test(e.name))!;
    const netlist = buildNetlist(buildExample(flipFlop));
    const out = simulate(netlist.text, { type: "op" });
    expect(out.warnings).toEqual([]);
    expect(out.vectors.some((v) => /null/.test(v.name))).toBe(false);
  });

  it("still warns about a net that really has one connection", () => {
    const out = simulate("t\nV1 a 0 1\nR1 a 0 1k\nR2 a b 1k\n", { type: "op" });
    expect(out.warnings.join()).toMatch(/Node 'b' has only one device connection/);
  });

  it("knows a diode isn't a logic part, so DC circuits with one finish", () => {
    const text = (extra: string) => `t\nV1 a 0 12\n${extra}\nR1 a 0 1k\n.end`;
    expect(changesOverTime(text("D1 a 0 D_GENERIC\n.model D_GENERIC D"))).toBe(false);
    // A switch with hysteresis can oscillate with nothing else driving it.
    expect(changesOverTime(text(".model SW_1 SW(vt=1)"))).toBe(true);
    expect(changesOverTime(text("aU1 a b D_DFF_GENERIC\n.model D_DFF_GENERIC d_dff(clk_delay=10n)"))).toBe(true);
    expect(changesOverTime("t\nV1 a 0 SIN(0 1 1k)\nR1 a 0 1k\n.end")).toBe(true);
    expect(changesOverTime("t\nV1 a 0 PULSE(0 1 0 1u 1u 1m 2m)\nR1 a 0 1k\n.end")).toBe(true);
  });

  it("gives every function generator shape something for a Bode plotter to measure", () => {
    for (const shape of ["sine", "triangle", "square"]) {
      const netlist = buildNetlist({
        name: "t", wires: [], labels: [], texts: [], definitions: "",
        components: [
          { id: "g", kind: "function-generator", refDes: "XFG1", x: 0, y: 0, rotation: 0, mirrored: false, spice: "", instrument: "function-generator", params: { shape, freq: "1k", amp: "1", offset: "0", duty: "50" }, pins: [{ name: "p", x: 30, y: 0, net: "a" }, { name: "n", x: -30, y: 0, net: "0" }] },
          { id: "r", kind: "resistor", refDes: "R1", x: 0, y: 0, rotation: 0, mirrored: false, spice: "", params: { value: "1k" }, pins: [{ name: "1", x: 30, y: 0, net: "a" }, { name: "2", x: -30, y: 0, net: "0" }] },
        ],
      } as never);
      const ac = simulate(netlist.text, { type: "ac", sweep: "dec", points: 2, fstart: 10, fstop: 100 });
      expect(ac.warnings.join()).not.toMatch(/no source with an AC magnitude/);
    }
  });
});
