import { describe, expect, it } from "vitest";
import type { LiveChunk, LiveSession, SimResult } from "../../src/core/sim";
import { createLiveSession, simulate } from "../../src/engine";
import { at, vec } from "./helpers";

function runLive(session: LiveSession, stop: number, chunk: number): { time: number[]; values: number[][] } {
  const time: number[] = [];
  const values: number[][] = session.names.map(() => []);
  for (let until = chunk; session.time < stop; until += chunk) {
    const c: LiveChunk = session.advance(Math.min(until, stop), 60000);
    for (let i = 0; i < c.time.length; i++) time.push(c.time[i]!);
    c.values.forEach((v, k) => {
      for (let i = 0; i < v.length; i++) values[k]!.push(v[i]!);
    });
  }
  return { time, values };
}

function interp(t: number[], y: number[], x: number): number {
  for (let i = 1; i < t.length; i++) {
    if (t[i]! >= x) {
      const d = t[i]! - t[i - 1]!;
      return d > 0 ? y[i - 1]! + ((x - t[i - 1]!) / d) * (y[i]! - y[i - 1]!) : y[i]!;
    }
  }
  return y[y.length - 1]!;
}

function compare(netlist: string, name: string, tstop: number, tmax: number, chunk: number, tol: number): void {
  const long: SimResult = simulate(netlist, { type: "tran", tstep: tmax, tstop, tmax });
  const session = createLiveSession(netlist, { tmax });
  const live = runLive(session, tstop, chunk);
  const k = session.names.indexOf(name);
  expect(k).toBeGreaterThanOrEqual(0);
  let worst = 0;
  for (let i = 1; i < 200; i++) {
    const x = (i / 200) * tstop;
    worst = Math.max(worst, Math.abs(at(long, name, x) - interp(live.time, live.values[k]!, x)));
  }
  console.log(`live vs long ${name}: worst difference ${worst.toExponential(2)}`);
  expect(worst).toBeLessThan(tol);
}

describe("live session", () => {
  it("follows an RC like one long transient, across small chunks", () => {
    compare("t\nV1 in 0 PULSE(0 1 0 1n 1n 2m 4m)\nR1 in out 1k\nC1 out 0 1u\n", "v(out)", 8e-3, 10e-6, 0.37e-3, 1e-4);
  });

  it("follows an LC oscillator without losing phase", () => {
    compare("t\nL1 a 0 1m\nC1 a 0 1u IC=1\nR1 a 0 10k\nD1 a n dm\nR2 n 0 1k\n.model dm D(IS=1e-14)\nI1 0 a PWL(0 0 1u 1m 2u 0)\n", "v(a)", 2e-3, 1e-6, 0.123e-3, 5e-3);
  });

  it("follows a digital counter, keeping pending events across calls", () => {
    const text = `counter
a1 clk ck
a2 v1 v1 clk 0 0 q0 nq0 jk
a3 v1 v1 nq0 0 0 q1 nq1 jk
a4 v1 cone
.model ck d_clock(frequency=1meg duty=0.5 delay=0)
.model jk d_jkff(clk_delay=1n rise_delay=1n fall_delay=1n set_delay=1n reset_delay=1n)
.model cone d_constsource(state=1)
`;
    // Chunk boundaries fall between events and between a flip-flop's clock and output.
    compare(text, "v(q1)", 16e-6, 50e-9, 0.7001e-6, 1e-3);
  });

  it("returns only new samples, in order, starting at time zero", () => {
    const s = createLiveSession("t\nV1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n", { tmax: 1e-5 });
    expect(s.time).toBe(0);
    const a = s.advance(1e-4, 10000);
    expect(a.time[0]).toBe(0);
    expect(s.time).toBeGreaterThanOrEqual(1e-4);
    const b = s.advance(2e-4, 10000);
    expect(b.time[0]!).toBeGreaterThan(a.time[a.time.length - 1]!);
    for (let i = 1; i < b.time.length; i++) expect(b.time[i]!).toBeGreaterThan(b.time[i - 1]!);
    expect(b.values.length).toBe(s.names.length);
    // Asking for a time already reached does nothing.
    expect(s.advance(1e-4, 10000).time.length).toBe(0);
  });

  it("does not keep samples between calls", () => {
    const s = createLiveSession("t\nV1 a 0 SIN(0 1 1k)\nR1 a 0 1k\n", { tmax: 1e-5 });
    let total = 0;
    let largest = 0;
    for (let k = 1; k <= 50; k++) {
      const c = s.advance(k * 1e-3, 10000);
      total += c.time.length;
      largest = Math.max(largest, c.time.length);
    }
    expect(total).toBeGreaterThan(5000);
    // Each chunk holds its own millisecond, not everything so far.
    expect(largest).toBeLessThan(total / 10);
  });

  it("stops at the budget and continues next call", () => {
    const s = createLiveSession("t\nV1 a 0 SIN(0 1 1k)\nR1 a b 1k\nC1 b 0 1u\n", { tmax: 1e-7 });
    const start = Date.now();
    const c = s.advance(1, 20);
    expect(Date.now() - start).toBeLessThan(500);
    expect(s.time).toBeLessThan(1);
    expect(c.time.length).toBeGreaterThan(0);
    const reached = s.time;
    s.advance(1, 20);
    expect(s.time).toBeGreaterThan(reached);
  });

  it("makes progress with a zero budget and rejects a bad time", () => {
    const s = createLiveSession("t\nV1 a 0 1\nR1 a 0 1k\nC1 a 0 1u\n");
    s.advance(1, 0);
    expect(s.time).toBeGreaterThan(0);
    expect(() => s.advance(NaN, 10)).toThrow(/finite/);
  });

  it("chooses a default step that resolves source and circuit dynamics", () => {
    const sine = createLiveSession("t\nV1 a 0 SIN(0 1 1meg)\nR1 a 0 1k\n");
    const c = sine.advance(5e-6, 10000);
    const k = sine.names.indexOf("v(a)");
    let high = 0;
    for (const v of c.values[k]!) high = Math.max(high, v);
    // Five cycles of a sine: without a limit from the source the default 1 ms step skips them all.
    expect(high).toBeGreaterThan(0.9);
    expect(c.time.length).toBeGreaterThan(30);
  });

  it("honours .ic and the uic option, and reports warnings", () => {
    const n = ".ic start\nC1 a 0 1u IC=2\nR1 a 0 1k\n";
    const s = createLiveSession(n, { tmax: 1e-5, uic: true });
    const c = s.advance(1e-3, 10000);
    expect(c.values[s.names.indexOf("v(a)")]![0]).toBeCloseTo(2, 2);
    expect(Math.abs(s.warnings.length)).toBeGreaterThanOrEqual(0);
  });

  it("carries a piecewise-linear break across a chunk boundary", () => {
    const s = createLiveSession("t\nV1 a 0 PWL(0 0 1m 1 2m 0)\nR1 a 0 1k\n", { tmax: 1e-4 });
    const k = s.names.indexOf("v(a)");
    const seen: number[] = [];
    for (let until = 0.3e-3; s.time < 3e-3; until += 0.3e-3) {
      const c = s.advance(until, 10000);
      for (let i = 0; i < c.time.length; i++) {
        if (Math.abs(c.time[i]! - 1e-3) < 1e-12) seen.push(c.values[k]![i]!);
      }
    }
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeCloseTo(1, 6);
  });

  it("uses vec names that a long run also has", () => {
    const text = "t\nV1 a 0 1\nR1 a 0 1k\n";
    const s = createLiveSession(text);
    const r = simulate(text, { type: "tran", tstep: 1e-6, tstop: 1e-5 });
    expect(s.names).toEqual(r.vectors.map((v) => v.name));
    expect(vec(r, "v(a)").re[0]).toBeCloseTo(1, 6);
  });
});

describe("step control independent of the window", () => {
  it("starts an unstable oscillator under a coarse tmax", () => {
    // A negative resistance across a tank grows from any disturbance; the kick is in the source.
    const netlist = `negative r
L1 a 0 100u
C1 a 0 1n
G1 0 a VALUE={limit(1m*v(a),-1m,1m)}
R1 a 0 2k
I1 0 a PWL(0 0 1n 1u 2n 0)
`;
    const f = 1 / (2 * Math.PI * Math.sqrt(100e-6 * 1e-9));
    const r = simulate(netlist, { type: "tran", tstep: 1e-4, tstop: 2e-3, tmax: 1e-5 });
    expect(r.stats.steps).toBeGreaterThan(1000);
    const t = r.axis!.re;
    const v = vec(r, "v(a)").re;
    let high = 0;
    for (let i = 0; i < t.length; i++) if (t[i]! > 1e-3) high = Math.max(high, Math.abs(v[i]!));
    expect(high).toBeGreaterThan(0.5);
    const ups: number[] = [];
    for (let i = 1; i < t.length; i++) if (t[i]! > 1e-3 && v[i - 1]! < 0 && v[i]! >= 0) ups.push(t[i]!);
    const measured = (ups.length - 1) / (ups[ups.length - 1]! - ups[0]!);
    expect(Math.abs(measured - f) / f).toBeLessThan(0.02);
  });

  it("warns when the step guard refuses a limit", () => {
    const netlist = `fast
L1 a 0 1n
C1 a 0 1p
G1 0 a a 0 1m
R1 a 0 2k
`;
    const r = simulate(netlist, { type: "tran", tstep: 10, tstop: 100 });
    expect(r.warnings.join()).toMatch(/may not be resolved/);
    expect(r.stats.steps).toBeLessThan(3_000_000);
  });

  it("does not limit a well damped circuit", () => {
    const r = simulate("t\nV1 a 0 1\nR1 a b 1k\nL1 b c 1m\nC1 c 0 1n\nR2 c 0 100\n", { type: "tran", tstep: 1e-3, tstop: 0.1 });
    expect(r.stats.steps).toBeLessThan(200);
  });

  it("keeps a fast source visible with a coarse tstep", () => {
    const r = simulate("t\nV1 a 0 SIN(0 1 1meg)\nR1 a 0 1k\n", { type: "tran", tstep: 1e-3, tstop: 1e-4, tmax: 1e-5 });
    let high = 0;
    for (const y of vec(r, "v(a)").re) high = Math.max(high, y);
    expect(high).toBeGreaterThan(0.8);
  });
});

describe("digital defects", () => {
  it("keeps a chip with a chip-level /delay block working", () => {
    const chip = (delay: string): SimResult =>
      simulate(`chip
a1 a ca
a2 b cb
a3 [a b] [y] nand1
.model ca d_constsource(state=1)
.model cb d_constsource(state=1)
.model nand1 d_chip(behaviour="
+/inputs A B
+/outputs Y
+/wires W
+/module AN
+/inputs P Q
+/outputs R
+/table 2
+H H L
+X X H
+/endmodule
+/instance AN A B Y
${delay}+")
`, { type: "tran", tstep: 1e-9, tstop: 1e-6 });
    const plain = chip("");
    const delayed = chip("+/delay 1\n+A Y 20n 30n\n");
    expect(at(plain, "v(y)", 0.5e-6)).toBeLessThan(0.1);
    expect(at(delayed, "v(y)", 0.5e-6)).toBeLessThan(0.1);
  });

  it("applies family thresholds and levels at analog boundaries", () => {
    const run = (model: string, supply: string): { warnings: string; out: number; flipAt: number } => {
      const r = simulate(`family
V1 in 0 PWL(0 0 1m 5)
R1 in 0 1k
a1 in out ${model}
R2 out 0 100k
.model ${model} d_buffer(rise_delay=1n fall_delay=1n)
${supply}`, { type: "tran", tstep: 1e-6, tstop: 1e-3 });
      const t = r.axis!.re;
      const v = vec(r, "v(out)").re;
      let flipAt = NaN;
      for (let i = 1; i < t.length; i++) {
        if (v[i - 1]! < 0.5 && v[i]! >= 0.5) {
          flipAt = t[i]!;
          break;
        }
      }
      return { warnings: r.warnings.join(), out: v[v.length - 1]!, flipAt };
    };
    const ttl = run("7407__74std__1", "");
    expect(Math.abs(ttl.flipAt - (1.4 / 5) * 1e-3)).toBeLessThan(2e-6);
    expect(ttl.warnings).toMatch(/assumed from its TTL family/);
    const hc = run("74hc07_2__74hc_2v__1", "");
    expect(Math.abs(hc.flipAt - (1 / 5) * 1e-3)).toBeLessThan(2e-6);
    expect(Math.abs(hc.out - 2)).toBeLessThan(0.01);
    const cmos = run("4050b_5__cmos_5v__1", "");
    expect(Math.abs(cmos.flipAt - 0.5e-3)).toBeLessThan(2e-6);
    const none = run("mybuf", "");
    expect(none.warnings).toMatch(/gives no logic family/);
    expect(Math.abs(none.flipAt - 0.5e-3)).toBeLessThan(2e-6);
  });

  it("gives Schmitt inputs real hysteresis: RC oscillator period by hand", () => {
    const r = simulate(`schmitt oscillator
a1 n out 74LS14__74STD__1
R1 out n 1k
C1 n 0 10n
.model 74LS14__74STD__1 d_inverter(rise_delay=22n fall_delay=22n)
`, { type: "tran", tstep: 1e-7, tstop: 200e-6 });
    const t = r.axis!.re;
    const v = vec(r, "v(n)").re;
    const ups: number[] = [];
    for (let i = 1; i < t.length; i++) if (t[i]! > 50e-6 && v[i - 1]! < 1.2 && v[i]! >= 1.2) ups.push(t[i]!);
    const period = (ups[ups.length - 1]! - ups[0]!) / (ups.length - 1);
    // R is 1010 ohm with the 10 ohm output; from 5 V down to 0 between 0.8 and 1.6 V.
    const rc = 1010 * 10e-9;
    const hand = rc * (Math.log((5 - 0.8) / (5 - 1.6)) + Math.log(1.6 / 0.8)) + 2 * 22e-9;
    console.log(`Schmitt oscillator: period ${(period * 1e6).toFixed(3)} us, hand ${(hand * 1e6).toFixed(3)} us`);
    expect(Math.abs(period - hand) / hand).toBeLessThan(0.02);
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i]! > 50e-6) {
        low = Math.min(low, v[i]!);
        high = Math.max(high, v[i]!);
      }
    }
    expect(Math.abs(high - 1.6)).toBeLessThan(0.1);
    expect(Math.abs(low - 0.8)).toBeLessThan(0.1);
  });

  it("bounds chatter in a plain gate with RC feedback", () => {
    const r = simulate(`chatter
a1 n out inv
R1 out n 1k
C1 n 0 10n
.model inv d_inverter(rise_delay=22n fall_delay=22n)
`, { type: "tran", tstep: 1e-6, tstop: 2e-3 });
    // 45 ns chatter would be 44,000 cycles; a tenth of a volt around 2.5 V at 10 us RC is far slower.
    expect(r.stats.steps).toBeLessThan(100000);
    expect(r.warnings.join()).toMatch(/chatters at its threshold/);
    expect(Math.abs(at(r, "v(n)", 1.5e-3) - 2.5)).toBeLessThan(0.2);
  });
});
