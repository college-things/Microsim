// Acceptance tests against the sample circuits, read at runtime and skipped when absent.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { buildNetlist } from "../../src/core/netlist";
import { createLiveSession, simulate } from "../../src/engine";
import { importMs14 } from "../../src/importer";
import type { SimResult } from "../../src/core/sim";
import { at, mag, phaseDeg, vec } from "./helpers";
import { findSample, listSamples, loadNetlist, report, runSample, tally } from "./corpus";

const available = listSamples().length > 0;

function risingCrossings(r: SimResult, name: string, t0: number): number[] {
  const t = r.axis!.re;
  const y = vec(r, name).re;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < t.length; i++) {
    if (t[i]! >= t0) {
      lo = Math.min(lo, y[i]!);
      hi = Math.max(hi, y[i]!);
    }
  }
  const level = (lo + hi) / 2;
  const out: number[] = [];
  for (let i = 1; i < t.length; i++) {
    if (t[i]! >= t0 && y[i - 1]! < level && y[i]! >= level) {
      out.push(t[i - 1]! + ((level - y[i - 1]!) / (y[i]! - y[i - 1]!)) * (t[i]! - t[i - 1]!));
    }
  }
  return out;
}

function load(part: string): string {
  const file = findSample(part);
  if (!file) throw new Error(`sample ${part} not found`);
  return loadNetlist(file);
}

describe.skipIf(!available)("sample circuits", () => {
  it("runs the linear regulators in DiodeRectifierwithLinearRegulators", () => {
    const r = simulate(load("DiodeRectifierwithLinearRegulators"), { type: "tran", tstep: 5e-5, tstop: 0.05, tmax: 1e-4 });
    console.log(`regulators: v(8)=${at(r, "v(8)", 0.05).toFixed(3)} v(9)=${at(r, "v(9)", 0.05).toFixed(3)} v(12)=${at(r, "v(12)", 0.05).toFixed(3)}`);
    // The filter capacitor peaks at the 12 V secondary less two diode drops and droops under load.
    let peak = 0;
    const t = r.axis!.re;
    const v8 = vec(r, "v(8)").re;
    for (let i = 0; i < t.length; i++) if (t[i]! > 0.03) peak = Math.max(peak, v8[i]!);
    expect(peak).toBeGreaterThan(10);
    expect(peak).toBeLessThan(11.2);
    expect(Math.abs(at(r, "v(9)", 0.05) - 3.3)).toBeLessThan(0.15);
    expect(Math.abs(at(r, "v(12)", 0.05) - 5)).toBeLessThan(0.2);
  }, 60000);

  it("matches the series RLC response of RLC Filter", () => {
    // R = 10, L = 20 mH, C = 50 uF: f0 = 159.15 Hz, Q = sqrt(L/C)/R = 2, driven through a unity E source.
    const f0 = 1 / (2 * Math.PI * Math.sqrt(20e-3 * 50e-6));
    const text = load("RLC Filter").replace(/\.end\s*$/i, "Vstim vin 0 AC 1\n.end\n");
    const r = simulate(text, { type: "ac", sweep: "lin", points: 1, fstart: f0, fstop: f0 });
    const v = vec(r, "v(vout)");
    const m = mag(v, 0);
    console.log(`RLC Filter: |H(f0)| = ${m.toFixed(5)}, expected 2 (phase ${phaseDeg(v, 0).toFixed(3)}, expected -90)`);
    expect(Math.abs(m - 2)).toBeLessThan(0.01);
    expect(Math.abs(phaseDeg(v, 0) + 90)).toBeLessThan(0.5);
  });

  it("matches the inverting low-pass corner of LowPassFilter", () => {
    // Input and feedback are 1 k, feedback capacitor 100 nF: gain 1, corner 1591.5 Hz.
    const fc = 1 / (2 * Math.PI * 1e3 * 100e-9);
    const r = simulate(load("LowPassFilter"), { type: "ac", sweep: "lin", points: 2, fstart: 10, fstop: fc });
    const v = vec(r, "v(out)");
    const low = mag(v, 0);
    const corner = mag(v, 1);
    console.log(`LowPassFilter: |H(10 Hz)| = ${low.toFixed(5)} expected 1, |H(fc)| = ${corner.toFixed(5)} expected 0.70711, phase ${phaseDeg(v, 1).toFixed(2)} expected 135`);
    expect(Math.abs(low - 1)).toBeLessThan(5e-3);
    expect(Math.abs(corner - Math.SQRT1_2)).toBeLessThan(5e-3);
    expect(Math.abs(phaseDeg(v, 1) - 135)).toBeLessThan(1);
  });

  it("matches the two-stage Sallen-Key response of the 741 bandpass filter", () => {
    const text = load("AC Sweep - Bandpass Filter");
    const H = (f: number): number => {
      const s = 2 * Math.PI * f;
      // Low-pass stage with gain K = 1 + 80k/20k, values from the schematic.
      const [r1, r2, c1, c2, k] = [3.98e3, 3.98e3, 1e-6, 1e-9, 5];
      const re1 = 1 - s * s * r1 * r2 * c1 * c2;
      const im1 = s * (c2 * (r1 + r2) + r1 * c1 * (1 - k));
      const lp = k / Math.hypot(re1, im1);
      // High-pass stage at unity gain.
      const [ca, cb, rf, rg] = [10e-9, 10e-9, 11.3e3, 22.5e3];
      const re2 = 1 - s * s * rf * rg * ca * cb;
      const im2 = s * rf * (ca + cb);
      const hp = (s * s * rf * rg * ca * cb) / Math.hypot(re2, im2);
      return lp * hp;
    };
    const r = simulate(text, { type: "ac", sweep: "dec", points: 2, fstart: 100, fstop: 3200 });
    const v = vec(r, "v(bandpassout)");
    const axis = r.axis!.re;
    const rows: string[] = [];
    for (let i = 0; i < axis.length; i++) {
      const got = mag(v, i);
      const want = H(axis[i]!);
      rows.push(`${axis[i]!.toFixed(0)} Hz ${got.toFixed(4)}/${want.toFixed(4)}`);
      expect(Math.abs(got - want) / want).toBeLessThan(0.03);
    }
    console.log(`Bandpass measured/hand: ${rows.join(", ")}`);
  });

  it("oscillates ColpittsOscillator near its tank frequency", () => {
    // Tank L = 320 uH with C1 and C2 = 82 pF in series.
    const f = 1 / (2 * Math.PI * Math.sqrt(320e-6 * 41e-12));
    const run = (text: string): number => {
      const r = simulate(text, { type: "tran", tstep: 5e-9, tstop: 60e-6, uic: true });
      const ups = risingCrossings(r, "v(output)", 40e-6);
      expect(ups.length).toBeGreaterThan(10);
      return (ups.length - 1) / (ups[ups.length - 1]! - ups[0]!);
    };
    const full = run(load("ColpittsOscillator"));
    // The transistor's junction and diffusion capacitance adds to the tank, so the ideal value is
    // only reached with those removed from the model.
    const bare = run(load("ColpittsOscillator").replace(/\b(CJE|CJC|TF|TR)\s*=\s*[-+\d.eE]+[a-zA-Z]*/gi, "$1=0"));
    console.log(`Colpitts: as drawn ${(full / 1e6).toFixed(4)} MHz, without transistor capacitance ${(bare / 1e6).toFixed(4)} MHz, tank ${(f / 1e6).toFixed(4)} MHz`);
    expect(Math.abs(bare - f) / f).toBeLessThan(0.05);
    expect(full).toBeLessThan(bare);
    expect(full).toBeGreaterThan(0.7 * f);
  });

  it("fires ControlledRectifier so the R-L current follows the closed form", () => {
    // 120 V 60 Hz through an SCR at 45 degrees into 1 ohm + 1 mH, ignoring the 10 mohm on-resistance.
    const r = simulate(load("ControlledRectifier"), { type: "tran", tstep: 5e-6, tstop: 0.03 });
    const w = 2 * Math.PI * 60;
    const R = 1 + 0.01;
    const L = 1e-3;
    const z = Math.hypot(R, w * L);
    const phi = Math.atan2(w * L, R);
    const alpha = (45 * Math.PI) / 180;
    const current = (t: number): number => {
      const tOn = alpha / w;
      return (120 / z) * (Math.sin(w * t - phi) - Math.sin(alpha - phi) * Math.exp((-(t - tOn) * R) / L));
    };
    const tPeak = 1 / 240;
    // v(5) is the junction of R1 and L1, and the resistor is 1 ohm, so v(4)-v(5) reads the current.
    const got = at(r, "v(4)", tPeak) - at(r, "v(5)", tPeak);
    console.log(`ControlledRectifier: i(4.17 ms) = ${got.toFixed(3)} A, hand ${current(tPeak).toFixed(3)} A; off-half reads ${(at(r, "v(4)", 0.0125) - at(r, "v(5)", 0.0125)).toFixed(5)} A`);
    expect(Math.abs(got - current(tPeak)) / current(tPeak)).toBeLessThan(0.03);
    expect(Math.abs(at(r, "v(4)", 0.0125) - at(r, "v(5)", 0.0125))).toBeLessThan(0.05);
  }, 60000);

  it("counts modulo ten in DecimalCounter", () => {
    // As drawn the enable switch holds the count; moving it to ground is what pressing the key does.
    // U/D stays high, which is the down direction of a 74LS190.
    const text = load("DecimalCounter").replace(/^xJ14\s+Bus_PWR\s+Bus2_EN\s+0/im, "xJ14 0 Bus2_EN Bus_PWR");
    expect(text).toMatch(/xJ14 0 Bus2_EN Bus_PWR/);
    const r = simulate(text, { type: "tran", tstep: 20e-6, tstop: 30e-3 });
    const t0 = 0.75e-3;
    const seq: number[] = [];
    const bit = (name: string, t: number): number => (at(r, name, t) > 2.5 ? 1 : 0);
    for (let k = 0; k < 24; k++) {
      const t = t0 + k * 1e-3;
      seq.push(bit("v(bus_qa)", t) + 2 * bit("v(bus_qb)", t) + 4 * bit("v(bus_qc)", t) + 8 * bit("v(bus_qd)", t));
    }
    console.log(`DecimalCounter units digit: ${seq.join(" ")}`);
    for (let k = 1; k < seq.length; k++) expect((seq[k]! - seq[k - 1]! + 10) % 10).toBe(9);
    expect(Math.max(...seq)).toBe(9);
    expect(Math.min(...seq)).toBe(0);
  }, 60000);

  it("starts SineWaveOscillator under a coarse window", () => {
    // The tank is 100 uH and 3 nF, 290.6 kHz, and the review measured 288.6 kHz with a 100 ns step.
    const r = simulate(load("SineWaveOscillator"), { type: "tran", tstep: 1e-4, tstop: 20e-3, tmax: 1e-4 });
    const ups = risingCrossings(r, "v(24)", 10e-3);
    const f = (ups.length - 1) / (ups[ups.length - 1]! - ups[0]!);
    const t = r.axis!.re;
    const y = vec(r, "v(24)").re;
    let high = 0;
    for (let i = 0; i < t.length; i++) if (t[i]! > 10e-3) high = Math.max(high, y[i]!);
    console.log(`SineWaveOscillator coarse window: ${(f / 1e3).toFixed(2)} kHz, peak ${high.toFixed(3)} V, ${r.stats.steps} steps`);
    expect(Math.abs(f - 288.6e3) / 288.6e3).toBeLessThan(0.02);
    expect(Math.abs(high - 1.264)).toBeLessThan(0.05);
  }, 120000);

  it("starts SineWaveOscillator in a live session with default settings", () => {
    const s = createLiveSession(load("SineWaveOscillator"));
    const k = s.names.indexOf("v(24)");
    const ups: number[] = [];
    let last = 0;
    let lastT = 0;
    let high = 0;
    const start = Date.now();
    for (let until = 1e-3; until <= 10e-3 + 1e-9; until += 1e-3) {
      const c = s.advance(until, 60000);
      const y = c.values[k]!;
      for (let i = 0; i < y.length; i++) {
        const t = c.time[i]!;
        if (t > 8e-3) {
          high = Math.max(high, y[i]!);
          if (last < 0 && y[i]! >= 0) ups.push(lastT + (-last / (y[i]! - last)) * (t - lastT));
        }
        last = y[i]!;
        lastT = t;
      }
    }
    const f = (ups.length - 1) / (ups[ups.length - 1]! - ups[0]!);
    console.log(`SineWaveOscillator live default: ${(f / 1e3).toFixed(2)} kHz, peak ${high.toFixed(3)} V, ${Date.now() - start} ms for 10 ms`);
    expect(Math.abs(f - 288.6e3) / 288.6e3).toBeLessThan(0.02);
    expect(Math.abs(high - 1.264)).toBeLessThan(0.05);
  }, 120000);

  it("runs the 74LS85 with its chip-level /delay block", () => {
    // The model text comes from the sample at runtime; the wiring here is A = 15, B = 0.
    const m = /\.model\s+74LS85\S*\s+d_chip[\s\S]*?"\s*\)/i.exec(load("DigitalCounter"));
    expect(m).not.toBeNull();
    const model = m![0].replace(/^(\.model\s+)\S+/i, "$1cmp");
    const inputs = "hi lo hi lo hi lo hi lo lo lo hi";
    const r = simulate(`compare\na1 hi ch\na2 lo cl\na3 [${inputs}] [gt lt eq] cmp\n.model ch d_constsource(state=1)\n.model cl d_constsource(state=0)\n${model}\n`, { type: "tran", tstep: 1e-8, tstop: 2e-6 });
    expect(at(r, "v(gt)", 1.9e-6)).toBeGreaterThan(4.9);
    expect(at(r, "v(lt)", 1.9e-6)).toBeLessThan(0.1);
    expect(at(r, "v(eq)", 1.9e-6)).toBeLessThan(0.1);
  });

  it("counts in DigitalCounter", () => {
    const r = simulate(load("DigitalCounter"), { type: "tran", tstep: 1e-5, tstop: 0.1 });
    const rate = (name: string): number => {
      const ups = risingCrossings(r, name, 0.02);
      return (ups.length - 1) / (ups[ups.length - 1]! - ups[0]!);
    };
    console.log(`DigitalCounter: QA ${rate("v(bus_qa)").toFixed(2)} Hz, QB ${rate("v(bus_qb)").toFixed(2)}, QC ${rate("v(bus_qc)").toFixed(2)}, QD ${rate("v(bus_qd)").toFixed(2)}`);
    expect(Math.abs(rate("v(bus_qa)") - 500)).toBeLessThan(0.5);
    expect(Math.abs(rate("v(bus_qb)") - 250)).toBeLessThan(0.5);
    expect(Math.abs(rate("v(bus_qc)") - 125)).toBeLessThan(0.5);
    expect(Math.abs(rate("v(bus_qd)") - 62.5)).toBeLessThan(0.5);
  }, 60000);

  it("gives SwitchDebounce's 4520B defined outputs", () => {
    const r = simulate(load("SwitchDebounce"), { type: "tran", tstep: 1e-6, tstop: 0.01 });
    for (const n of ["v(4)", "v(5)", "v(6)", "v(7)"]) {
      const v = at(r, n, 0.009);
      console.log(`SwitchDebounce ${n} = ${v.toFixed(3)}`);
      expect(Math.abs(v - 2.5)).toBeGreaterThan(1);
    }
  }, 60000);

  it("oscillates PulseWidthModulator's Schmitt RC near the hand value", () => {
    const start = Date.now();
    const r = simulate(load("PulseWidthModulator"), { type: "tran", tstep: 1e-6, tstop: 20e-3 });
    const ups = risingCrossings(r, "v(1)", 1e-3);
    const f = (ups.length - 1) / (ups[ups.length - 1]! - ups[0]!);
    console.log(`PulseWidthModulator: ${(f / 1e3).toFixed(2)} kHz in ${Date.now() - start} ms, ${r.stats.steps} steps`);
    expect(Math.abs(f - 110e3) / 110e3).toBeLessThan(0.05);
    expect(r.stats.steps).toBeLessThan(500000);
  }, 60000);

  it("runs the stored transients that ask for far too many steps instead of refusing them", () => {
    for (const name of ["ControlledRectifier", "Semikron SkiiP 6-Pack Single Level Inverter"]) {
      const file = findSample(name)!;
      const imported = importMs14(new Uint8Array(readFileSync(file)));
      const doc = imported.schematic;
      const stored = imported.analyses.find((a) => a.type === "tran");
      expect(stored?.type).toBe("tran");
      const start = Date.now();
      const r = simulate(buildNetlist(doc).text, stored!, { shouldStop: () => Date.now() - start > 2000 });
      const t = r.axis!.re;
      console.log(`${name} stored ${JSON.stringify(stored)}: reached ${t[t.length - 1]!.toExponential(3)} s, ${r.stats.steps} steps, in 2 s`);
      expect(t.length).toBeGreaterThan(100);
    }
  }, 60000);

  it.runIf(process.env.CORPUS_STORED)("runs every stored analysis", () => {
    let total = 0;
    const failures: string[] = [];
    let stopped = 0;
    for (const file of listSamples()) {
      const imported = importMs14(new Uint8Array(readFileSync(file)));
      const text = buildNetlist(imported.schematic).text;
      for (const request of imported.analyses) {
        total++;
        const start = Date.now();
        try {
          const r = simulate(text, request, { shouldStop: () => Date.now() - start > 1500 });
          if (r.warnings.some((w) => /partial/.test(w))) stopped++;
        } catch (e) {
          failures.push(`${basename(file)} ${request.type}: ${String(e).slice(0, 110)}`);
        }
      }
    }
    console.log(`stored analyses: ${total}, failed ${failures.length}, stopped at the 1.5 s test limit ${stopped}\n${failures.join("\n")}`);
  }, 900000);

  it("gives BrushlessDCDriveSixStep an operating point with its .ic held", () => {
    // A commutated motor has no equilibrium, so .op falls back to the state a transient starts from.
    const r = simulate(load("BrushlessDCDriveSixStep"), { type: "op" });
    expect(r.warnings.join()).toMatch(/no free DC solution/);
  }, 60000);

  it("solves every sample at the operating point or reports why", () => {
    const rows = listSamples().map((f) => runSample(f, { type: "op" }, 5000));
    console.log(report(tally(rows)));
    expect(rows.filter((r) => r.failureCode === "internal").map((r) => r.failure)).toEqual([]);
  }, 300000);
});
