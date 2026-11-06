import { describe, expect, it } from "vitest";
import {
  batchAnalyses, executeAnalysisPlan, distortion, findVector, histogram, intermodulation, measure, monteCarlo,
  nestedSweep, noiseFigureAnalysis, seededRandom, statistics, sweepValues, temperatureSweep,
  worstCase, type Measurement, type MonteCarloOptions, type Runner,
} from "../../src/core/analyses";
import { Doc } from "../../src/core/doc";
import { buildNetlist } from "../../src/core/netlist";
import type { AnalysisRequest, SimResult } from "../../src/core/sim";
import { simulate } from "../../src/engine";

const run: Runner = async (text, request) => simulate(text, request);
const op: AnalysisRequest = { type: "op" };
function divider(rc = false) {
  const doc = new Doc();
  const source = doc.addPart(rc ? "vsin" : "vdc", 0, 0, rc ? { acmag: "1" } : { value: "10" });
  const r1 = doc.addPart("resistor", 120, -50, { value: "1k" });
  const r2 = doc.addPart(rc ? "capacitor" : "resistor", 240, 0, { value: rc ? "1u" : "1k" });
  const ground = doc.addPart("ground", 0, 120);
  doc.connectPins(source, "p", r1, "1");
  doc.connectPins(r1, "2", r2, "1");
  doc.connectPins(r2, "2", ground, "g");
  doc.connectPins(source, "n", ground, "g");
  const net = buildNetlist(doc.schematic).pinNets.get(r2.id)!.get("1")!;
  return { doc, r1, r2, vector: `v(${net})` };
}
const maximum = (vector: string): Measurement => ({ kind: "max", vector });
const options: MonteCarloOptions = { runs: 100, defaultTolerance: 5, distribution: "uniform", seed: 10 };

function waveform(fn: (t: number) => number, stop = 1, count = 20001): SimResult {
  const time = Float64Array.from({ length: count }, (_, i) => stop * i / (count - 1));
  return { analysis: "tran", axis: { name: "time", unit: "s", re: time }, vectors: [{ name: "v(out)", unit: "V", re: time.map(fn) }], warnings: [], stats: { steps: count, iterations: 0, unknowns: 1, elapsedMs: 0 } };
}

describe("list and nested sweeps", () => {
  it("preserves outer-major ordering, arbitrary lists and duplicate values", async () => {
    const { doc, vector } = divider();
    const before = structuredClone(doc.schematic);
    const result = await nestedSweep(doc.schematic, [
      { kind: "parameter", refDes: "R1", param: "value", values: [2000, 1000] },
      { kind: "parameter", refDes: "R2", param: "value", values: [1000, 3000, 1000] },
    ], op, run, maximum(vector));
    expect(result.map(r => r.measurement)).toEqual(expect.arrayContaining([expect.any(Number)]));
    const wanted = [10 / 3, 6, 10 / 3, 5, 7.5, 5];
    result.forEach((r, i) => expect(r.measurement).toBeCloseTo(wanted[i], 8));
    expect(result.map(r => r.settings)).toEqual([2000, 1000].flatMap(a => [1000, 3000, 1000].map(b => ({ "R1.value": a, "R2.value": b }))));
    expect(doc.schematic).toEqual(before);
  });

  it.each([true, false])("sweeps temperature on either side of a parameter (%s)", async outer => {
    const { doc, vector } = divider();
    // A temperature expression proves the directive reaches the engine, beyond labels/counts.
    doc.schematic.components.find(c => c.refDes === "V1")!.spice = "{ref} {pin:p} {pin:n} DC {temp}";
    const temperature = { kind: "temperature" as const, values: [10, 40] };
    const parameter = { kind: "parameter" as const, refDes: "R1", param: "value", values: [1000, 3000] };
    const result = await nestedSweep(doc.schematic, outer ? [temperature, parameter] : [parameter, temperature], op, run, maximum(vector));
    const expected = outer ? [5, 2.5, 20, 10] : [5, 20, 2.5, 10];
    result.forEach((r, i) => expect(r.measurement).toBeCloseTo(expected[i], 8));
  });

  it("supports every engine request through the shared runner", async () => {
    const { doc } = divider();
    const seen: AnalysisRequest[] = [];
    const requests: AnalysisRequest[] = [op, { type: "tran", tstop: 0.01, tstep: 0.001 }, { type: "ac", sweep: "lin", points: 2, fstart: 10, fstop: 20 }];
    for (const request of requests) await nestedSweep(doc.schematic, [{ kind: "temperature", values: [10, 20] }], request, async (text, inner) => { seen.push(inner); return run(text, inner); });
    expect(seen).toEqual(requests.flatMap(r => [r, r]));
  });

  it("replaces prior temperatures and handles decks without .end", async () => {
    const text = "title\n.temp 90\nV1 out 0 {temp}\nR1 out 0 1k\n";
    const result = await temperatureSweep(text, 10, 20, 2, op, run);
    expect(result.map(r => findVector(r.result, "v(out)")!.re[0])).toEqual([10, 20]);
  });

  it("rejects bad ranges, empty lists and duplicate axes", async () => {
    expect(sweepValues(3, 1, 3)).toEqual([3, 2, 1]);
    expect(() => sweepValues(0, 1, 1.5)).toThrow(/whole number/);
    const { doc } = divider();
    await expect(nestedSweep(doc.schematic, [{ kind: "temperature", values: [] }], op, run)).rejects.toThrow(/nonempty/);
    await expect(nestedSweep(doc.schematic, [{ kind: "temperature", values: [1] }, { kind: "temperature", values: [2] }], op, run)).rejects.toThrow(/different/);
  });
});

describe("Monte Carlo", () => {
  it.each(["uniform", "gaussian"] as const)("reproduces seeded %s runs and honors per-part/default/zero tolerance", async distribution => {
    const { doc, r1, vector } = divider();
    r1.params.tolerance = "1%";
    const config = { ...options, runs: 20, distribution, tolerances: { r2: 0 } };
    const before = structuredClone(doc.schematic);
    const a = await monteCarlo(doc.schematic, config.runs, 5, op, run, undefined, config, maximum(vector));
    const b = await monteCarlo(doc.schematic, config.runs, 5, op, run, undefined, config, maximum(vector));
    expect(a.map(r => r.settings)).toEqual(b.map(r => r.settings));
    expect(a.map(r => r.measurement)).toEqual(b.map(r => r.measurement));
    expect(a.every(r => r.settings!.R2 === 1000)).toBe(true);
    expect(a.some(r => r.settings!.R1 !== 1000)).toBe(true);
    if (distribution === "uniform") expect(a.every(r => Math.abs(r.settings!.R1 - 1000) <= 10)).toBe(true);
    expect(doc.schematic).toEqual(before);
    const c = await monteCarlo(doc.schematic, 20, 5, op, run, undefined, { ...config, seed: 11 });
    expect(c.map(r => r.settings)).not.toEqual(a.map(r => r.settings));
  });

  it("matches the small-tolerance analytic spread of an RC divider", async () => {
    const { doc, vector } = divider(true);
    // At omega RC = 1, |H|=1/sqrt(2), d|H|/d(relative R)=-1/(2 sqrt(2)).
    const request: AnalysisRequest = { type: "ac", sweep: "lin", points: 1, fstart: 1 / (2 * Math.PI * 0.001), fstop: 1 / (2 * Math.PI * 0.001) };
    const config = { ...options, runs: 1600, defaultTolerance: 1, tolerances: { C1: 0 } };
    const output = await monteCarlo(doc.schematic, config.runs, 1, request, run, undefined, config, maximum(vector));
    const stats = statistics(output.map(r => r.measurement!));
    expect(stats.mean).toBeCloseTo(1 / Math.SQRT2, 3);
    const analytic = 0.01 / Math.sqrt(3) / (2 * Math.SQRT2);
    expect(Math.abs(stats.standardDeviation / analytic - 1)).toBeLessThan(0.06);
    expect(histogram(output.map(r => r.measurement!)).counts.reduce((a, b) => a + b)).toBe(config.runs);
  });

  it.each(["uniform", "gaussian"] as const)("gives the expected %s parameter spread", async distribution => {
    const { doc } = divider();
    const config = { ...options, runs: 1200, distribution, defaultTolerance: 9 };
    const output = await monteCarlo(doc.schematic, config.runs, 9, op, run, undefined, config);
    const stats = statistics(output.map(r => r.settings!.R1));
    const sigma = distribution === "uniform" ? 90 / Math.sqrt(3) : 30;
    expect(Math.abs(stats.standardDeviation / sigma - 1)).toBeLessThan(0.07);
    expect(Math.abs(stats.mean - 1000)).toBeLessThan(4);
  });

  it("validates tolerances and seed, and propagates cancellation before another run", async () => {
    const { doc } = divider();
    await expect(monteCarlo(doc.schematic, 1, -5, op, run)).rejects.toThrow(/tolerance/);
    await expect(monteCarlo(doc.schematic, 1, 5, op, run, undefined, { ...options, tolerances: { bad: 2 } })).rejects.toThrow(/No passive/);
    expect(() => seededRandom(-1)).toThrow(/seed/);
    let calls = 0;
    await expect(monteCarlo(doc.schematic, 10, 5, op, async () => { calls++; throw new Error("Simulation stopped."); })).rejects.toThrow(/stopped/);
    expect(calls).toBe(1);
  });
});

describe("worst case", () => {
  it("finds both resistor-divider corners with one probe per part plus nominal and two final runs", async () => {
    const { doc, vector } = divider();
    let calls = 0;
    const out = await worstCase(doc.schematic, { defaultTolerance: 10, tolerances: { R2: 20 } }, op, maximum(vector), async (text, req) => { calls++; return run(text, req); });
    expect(calls).toBe(5);
    expect(out.high.measurement).toBeCloseTo(10 * 1200 / (900 + 1200), 8);
    expect(out.low.measurement).toBeCloseTo(10 * 800 / (1100 + 800), 8);
    expect(out.high.settings).toEqual({ R1: 900, R2: 1200 });
    expect(out.low.settings).toEqual({ R1: 1100, R2: 800 });
  });
});

describe("measurements", () => {
  it("measures a nonuniform ramp by integration and interpolates crossings", () => {
    const result = waveform(t => 2 * t, 1, 3);
    result.axis!.re = Float64Array.of(0, 0.1, 1);
    result.vectors[0].re = Float64Array.of(0, 0.2, 2);
    const read = (kind: Measurement["kind"], at?: number) => measure(result, { kind, vector: "v(out)", at });
    expect(read("at", 0.25)).toBeCloseTo(0.5);
    expect(read("max")).toBe(2);
    expect(read("min")).toBe(0);
    expect(read("peakToPeak")).toBe(2);
    expect(read("average")).toBeCloseTo(1);
    expect(read("rms")).toBeCloseTo(2 / Math.sqrt(3));
    expect(read("riseTime")).toBeCloseTo(0.8);
    expect(() => read("at", 2)).toThrow(/outside/);
  });

  it("measures an RC cutoff, voltage gain and rise time against the analytic values", () => {
    const ac = simulate("RC\nV1 in 0 AC 2\nR1 in out 1k\nC1 out 0 1u\n.end", { type: "ac", sweep: "dec", points: 200, fstart: 0.1, fstop: 1e5 });
    const fc = 1 / (2 * Math.PI * 0.001);
    expect(measure(ac, { kind: "bandwidth", vector: "v(out)" })).toBeCloseTo(fc, 1);
    expect(measure(ac, { kind: "gain", vector: "v(out)", input: "v(in)", at: fc })).toBeCloseTo(1 / Math.SQRT2, 4);
    const tran = simulate("RC step\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR1 in out 1k\nC1 out 0 1u\n.end", { type: "tran", tstep: 1e-5, tmax: 1e-5, tstop: 0.02 });
    expect(measure(tran, { kind: "riseTime", vector: "v(out)" })).toBeCloseTo(Math.log(9) * 0.001, 5);
  });
});

describe("distortion", () => {
  it("matches the analytic Fourier series of a hard-clipped sine", () => {
    const result = simulate("clipped sine\nV1 in 0 SIN(0 1 1)\nB1 out 0 V=limit(v(in),-0.5,0.5)\nR1 out 0 1k\n.end", { type: "tran", tstep: 0.0001, tmax: 0.0001, tstop: 2 });
    const out = distortion(result, "v(out)", 1, 9);
    // For clip level 1/2, split the sine integral at alpha=asin(1/2)=pi/6.
    const alpha = Math.PI / 6;
    const integral = (k: number) => k === 0 ? alpha : Math.sin(k * alpha) / k;
    const coefficient = (n: number) => 4 / Math.PI * ((integral(n - 1) - integral(n + 1)) / 2 + 0.5 * Math.cos(n * alpha) / n);
    const base = coefficient(1);
    const analyticThd = Math.hypot(...[3, 5, 7, 9].map(n => coefficient(n))) / base * 100;
    expect(out.thd).toBeCloseTo(analyticThd, 3);
    for (const n of [1, 3, 5, 7, 9]) expect(out.rows[n - 1].relativePercent).toBeCloseTo(Math.abs(coefficient(n) / base) * 100, 3);
    expect(out.rows[1].relativePercent).toBeLessThan(1e-5);
  });

  it("computes cubic two-tone IMD with the analytic third-order amplitudes", () => {
    const a = 0.1;
    const result = simulate("cubic mixer\nV1 a 0 SIN(0 1 10)\nV2 b a SIN(0 1 13)\nB1 out 0 V=v(b)+0.1*v(b)^3\nR1 out 0 1k\n.end", { type: "tran", tstep: 0.00005, tmax: 0.00005, tstop: 2 });
    const out = intermodulation(result, "v(out)", 10, 13, 1);
    const carrier = 1 + 9 * a / 4;
    const product = 3 * a / 4;
    expect(out.imd).toBeCloseTo(Math.sqrt(4 * product ** 2) / (Math.SQRT2 * carrier) * 100, 3);
    for (const f of [7, 16, 33, 36]) expect(out.rows.find(r => r.frequency === f)!.magnitude).toBeCloseTo(product, 5);
    expect(() => intermodulation(result, "v(out)", 10, 10)).toThrow(/different/);
  });

  it("measures a circuit transient with zero distortion through a linear divider", async () => {
    const result = await run("sine\nV1 in 0 SIN(0 1 1k)\nR1 in out 1k\nR2 out 0 1k\n.end", { type: "tran", tstep: 2e-6, tmax: 2e-6, tstop: 0.01 });
    expect(distortion(result, "v(out)", 1000).thd).toBeLessThan(0.01);
  });
});

describe("noise figure and saved batch", () => {
  it.each([0, 1000])("matches a resistor-only network with extra series resistance %s", async extra => {
    const result = await noiseFigureAnalysis(`noise\n.temp 100\nV1 in 0 0\nRs in mid 1000\nRx mid out ${extra || 1e-9}\nRload out 0 1e15\n.end`, { type: "noise", source: "V1", output: "v(out)", sweep: "dec", points: 4, fstart: 10, fstop: 1e4 }, 1000, run);
    const expected = 10 * Math.log10(1 + extra / 1000);
    result.vectors[0].re.forEach(db => expect(db).toBeCloseTo(expected, 5));
  });

  it("runs saved requests in order, shows known answers and stops on failure", async () => {
    const netlist = "batch\nV1 in 0 DC 10 AC 1\nR1 in out 1k\nR2 out 0 1k\n.end";
    const entries = [{ label: "bias", request: op }, { label: "gain", request: { type: "ac", sweep: "lin", points: 2, fstart: 10, fstop: 20 } as AnalysisRequest }];
    const seen: string[] = [];
    const results = await batchAnalyses(netlist, JSON.parse(JSON.stringify(entries)), async (text, req) => { seen.push(req.type); return run(text, req); });
    expect(seen).toEqual(["op", "ac"]);
    expect(results.map(r => r.label)).toEqual(["bias", "gain"]);
    expect(measure(results[0].result, maximum("v(out)"))).toBeCloseTo(5);
    expect(measure(results[1].result, maximum("v(out)"))).toBeCloseTo(0.5);
    let calls = 0;
    await expect(batchAnalyses(netlist, entries, async () => { calls++; throw new Error("Simulation stopped."); })).rejects.toThrow(/stopped/);
    expect(calls).toBe(1);
  });

  it("round-trips a saved batch containing sweeps, Monte Carlo and worst case", async () => {
    const { doc, vector } = divider();
    const text = buildNetlist(doc.schematic).text;
    const measurement = maximum(vector);
    const plan = JSON.parse(JSON.stringify({ type: "batch", entries: [
      { label: "list", request: { type: "sweep", axes: [{ kind: "parameter", refDes: "R1", param: "value", values: [1000, 3000] }], request: op, measurement } },
      { label: "spread", request: { type: "montecarlo", options: { ...options, runs: 3 }, request: op, measurement } },
      { label: "corners", request: { type: "worstcase", options: { defaultTolerance: 10 }, request: op, measurement } },
    ] }));
    const output = await executeAnalysisPlan(text, plan, run, doc.schematic);
    expect(output).toHaveLength(8);
    expect(output.map(r => r.label.split(":")[0])).toEqual(["list", "list", "spread", "spread", "spread", "corners", "corners", "corners"]);
    expect(output[0].measurement).toBeCloseTo(5);
    expect(output[1].measurement).toBeCloseTo(2.5);
    expect(output[2].summary!.join(" ")).toMatch(/Mean:.*Standard deviation.*Minimum:.*Maximum:/);
    expect(output[2].histogram!.counts.reduce((a, b) => a + b)).toBe(3);
    expect(output[6].measurement).toBeCloseTo(5.5);
    expect(output[7].measurement).toBeCloseTo(4.5);
  });

  it("dispatches spectral and noise-figure plans through the common runner", async () => {
    const sine = "linear\nV1 in 0 SIN(0 1 10)\nR1 in out 1k\nR2 out 0 1k\n.end";
    const request = { type: "tran" as const, tstep: 0.0001, tmax: 0.0001, tstop: 1 };
    const harmonic = await executeAnalysisPlan(sine, { type: "distortion", request, vector: "v(out)", fundamental: 10, harmonics: 9 }, run);
    expect(harmonic[0].summary![1]).toMatch(/THD: 0.00/);
    const imd = await executeAnalysisPlan("two tone\nV1 in 0 SIN(0 1 10)\nV2 mid in SIN(0 1 13)\nR1 mid out 1k\nR2 out 0 1k\n.end", { type: "imd", request, vector: "v(out)", f1: 10, f2: 13, start: 0 }, run);
    expect(imd[0].summary![0]).toMatch(/0.00/);
    const noise = await executeAnalysisPlan("noise\nV1 in 0 0\nR1 in out 50\n.end", { type: "noisefigure", request: { type: "noise", source: "V1", output: "v(out)", sweep: "lin", points: 2, fstart: 10, fstop: 100 }, sourceResistance: 50 }, run);
    expect(noise[0].result.vectors[0].re[0]).toBeCloseTo(0, 8);
    await expect(executeAnalysisPlan(sine, { type: "batch", entries: [{ label: "bad", request: { type: "unknown" } as never }] }, run)).rejects.toThrow(/supported/);
  });

  it("computes stable statistics and counts flat histogram data", () => {
    expect(statistics([1, 2, 3])).toEqual({ mean: 2, standardDeviation: Math.sqrt(2 / 3), minimum: 1, maximum: 3 });
    expect(histogram([5, 5, 5]).counts.reduce((a, b) => a + b)).toBe(3);
  });
});
