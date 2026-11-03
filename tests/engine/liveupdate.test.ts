import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNetlist } from "../../src/core/netlist";
import type { SchComponent, Schematic } from "../../src/core/schematic";
import type { LiveSession } from "../../src/core/sim";
import { createLiveSession, simulate } from "../../src/engine";
import { Analysis } from "../../src/engine/analysis";
import { elaborate, parseDeck } from "../../src/engine/netlist";
import { importMs14 } from "../../src/importer";
import { applyInteractive } from "../../src/importer/interactive";
import { findSample, listSamples } from "./corpus";
import { vec } from "./helpers";

/** Value of a vector at the end of an advance to the given time. */
function valueAt(s: LiveSession, name: string, until: number): number {
  const c = s.advance(until, 60000);
  const k = s.names.indexOf(name);
  if (k < 0) throw new Error(`no ${name}`);
  const y = c.values[k]!;
  return y[y.length - 1]!;
}

function peakBetween(s: LiveSession, name: string, until: number): { high: number; low: number } {
  const c = s.advance(until, 60000);
  const y = c.values[s.names.indexOf(name)]!;
  let high = -Infinity;
  let low = Infinity;
  for (let i = 0; i < y.length; i++) {
    high = Math.max(high, y[i]!);
    low = Math.min(low, y[i]!);
  }
  return { high, low };
}

describe("update keeps circuit state", () => {
  const rc = (r: string): string => `rc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR1 in out ${r}\nC1 out 0 1u\n`;

  it("keeps a capacitor's voltage across a resistor change, then follows the new time constant", () => {
    const s = createLiveSession(rc("1k"), { tmax: 1e-5 });
    const v0 = valueAt(s, "v(out)", 1e-3);
    expect(Math.abs(v0 - (1 - Math.exp(-1)))).toBeLessThan(1e-3);
    const t0 = s.time;
    expect(s.update(rc("10k"))).toBe(true);
    expect(s.time).toBe(t0);
    // Just after the change the voltage has not moved.
    const next = s.advance(t0 + 2e-6, 60000);
    const k = s.names.indexOf("v(out)");
    expect(Math.abs(next.values[k]![0]! - v0)).toBeLessThan(1e-3);
    // Afterwards it charges with RC = 10 ms from where it was.
    const dt = 5e-3;
    const v1 = valueAt(s, "v(out)", t0 + dt);
    const expected = 1 - (1 - v0) * Math.exp(-(s.time - t0) / 10e-3);
    expect(Math.abs(v1 - expected)).toBeLessThan(2e-3);
  });

  it("keeps voltage when the capacitor's own value changes, and current in an inductor", () => {
    const circuit = (c: string): string => `t\nR1 a 0 1k\nC1 a 0 ${c} IC=2\n`;
    const s = createLiveSession(circuit("1u"), { tmax: 1e-5, uic: true });
    const v0 = valueAt(s, "v(a)", 1e-3);
    expect(Math.abs(v0 - 2 * Math.exp(-1))).toBeLessThan(2e-3);
    const t0 = s.time;
    expect(s.update(circuit("2u"))).toBe(true);
    const v1 = valueAt(s, "v(a)", t0 + 2e-3);
    expect(Math.abs(v1 - v0 * Math.exp(-(s.time - t0) / 2e-3))).toBeLessThan(2e-3);

    const rl = (r: string): string => `t\nL1 a 0 1m IC=1\nR1 a 0 ${r}\n`;
    const l = createLiveSession(rl("1"), { tmax: 1e-5, uic: true });
    const i0 = valueAt(l, "i(l1)", 1e-3);
    const t1 = l.time;
    expect(l.update(rl("2"))).toBe(true);
    const i1 = valueAt(l, "i(l1)", t1 + 1e-3);
    expect(Math.abs(i1 - i0 * Math.exp(-(l.time - t1) / 0.5e-3))).toBeLessThan(2e-3);
  });

  const flop = (r: string): string => `dff
a1 clk ck
a2 d cd
a3 d clk 0 0 q nq ff
V1 x 0 1
R1 x 0 ${r}
.model ck d_clock(frequency=1meg duty=0.5 delay=100n)
.model cd d_clock(frequency=100k duty=0.5 delay=0)
.model ff d_dff(clk_delay=1n rise_delay=1n fall_delay=1n set_delay=1n reset_delay=1n)
`;

  it("keeps a flip-flop's output and pending events across an unrelated change", () => {
    const run = (withUpdate: boolean): number[] => {
      const s = createLiveSession(flop("1k"), { tmax: 5e-8 });
      const out: number[] = [];
      for (let k = 1; k <= 40; k++) {
        out.push(valueAt(s, "v(q)", k * 0.5e-6 + 0.27e-6));
        // Mid-period: the clock's next edge is a pending event that must survive.
        if (withUpdate && k % 7 === 0) expect(s.update(flop(`${k}k`))).toBe(true);
      }
      return out;
    };
    expect(run(true)).toEqual(run(false));
  });

  it("keeps a chip's counter across an update", () => {
    const chip = (r: string): string => `chip
a1 clk ck
a2 [clk] [q0 q1] cnt
V1 x 0 1
R1 x 0 ${r}
.model ck d_clock(frequency=1meg duty=0.5 delay=0)
.model cnt d_chip(behaviour="
+/inputs CLK
+/outputs Q0 Q1
+/clock CLK + 2 1 0
+X XX F+0 F+1
+/table 1
+X XX F0 F1
+")
`;
    const s = createLiveSession(chip("1k"), { tmax: 5e-8 });
    const count = (until: number): number => {
      const c = s.advance(until, 60000);
      const last = (name: string): number => {
        const y = c.values[s.names.indexOf(name)]!;
        return y[y.length - 1]!;
      };
      return (last("v(q0)") > 2.5 ? 1 : 0) + (last("v(q1)") > 2.5 ? 2 : 0);
    };
    // Rising edges at 0, 1 and 2 us have counted three by 2.5 us.
    const before = count(2.5e-6);
    expect(before).toBe(3);
    expect(s.update(chip("2k"))).toBe(true);
    expect(count(2.8e-6)).toBe(before);
    expect(count(3.5e-6)).toBe(0);
  });

  it("gives the same trajectory as no update when nothing changes much", () => {
    const text = rc("1k");
    const a = createLiveSession(text, { tmax: 1e-5 });
    const b = createLiveSession(text, { tmax: 1e-5 });
    const v1 = valueAt(a, "v(out)", 0.5e-3);
    valueAt(b, "v(out)", 0.5e-3);
    expect(b.update(text)).toBe(true);
    const va = valueAt(a, "v(out)", 2e-3);
    const vb = valueAt(b, "v(out)", 2e-3);
    expect(v1).toBeGreaterThan(0);
    expect(Math.abs(va - vb)).toBeLessThan(1e-3);
  });

  it("returns false and leaves the session alone when the structure differs", () => {
    const s = createLiveSession(rc("1k"), { tmax: 1e-5 });
    const v0 = valueAt(s, "v(out)", 1e-3);
    const t0 = s.time;
    // Another device, a rewired device, a renamed device and a different class.
    expect(s.update(`${rc("1k")}R2 out 0 1k\n`)).toBe(false);
    expect(s.update("rc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR1 out in 1k\nC1 out 0 1u\n")).toBe(false);
    expect(s.update("rc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR9 in out 1k\nC1 out 0 1u\n")).toBe(false);
    // A rewiring that keeps every matrix entry: the resistor moves to a parallel path.
    expect(s.update("rc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nC1 in out 1u\nR1 out 0 1k\n")).toBe(false);
    // A netlist that cannot be read.
    expect(s.update("rc\nV1 in 0 1\nR1 in\n")).toBe(false);
    expect(s.update("rc\nV1 in 0 1\nR1 in out {nosuch}\nC1 out 0 1u\n")).toBe(false);
    expect(s.time).toBe(t0);
    const v1 = valueAt(s, "v(out)", 2e-3);
    expect(Math.abs(v1 - (1 - (1 - v0) * Math.exp(-(s.time - t0) / 1e-3)))).toBeLessThan(2e-3);
  });

  it("rejects a series resistance that creates an internal node", () => {
    const d = (m: string): string => `t\nV1 a 0 1\nR1 a b 1k\nD1 b 0 dm\n.model dm D(IS=1e-14${m})\n`;
    const s = createLiveSession(d(""), { tmax: 1e-5 });
    s.advance(1e-4, 60000);
    expect(s.update(d(" RS=5"))).toBe(false);
    expect(s.update(d(" N=1.2"))).toBe(true);
  });

  it("updates subcircuit parameters, expressions, source values and switch models", () => {
    const text = (r: string, von: string, v: string): string => `t
.param rr=${r}
.subckt load a b q=1
R1 a b {q*rr}
.ends
V1 c 0 ${v}
Rc c 0 1k
V2 in 0 5
S1 in out c 0 sm
X1 out 0 load q=2
.model sm SW(VT=${von} RON=1 ROFF=1g)
`;
    const s = createLiveSession(text("500", "1", "0"), { tmax: 1e-5 });
    expect(valueAt(s, "v(out)", 1e-4)).toBeLessThan(0.01);
    expect(s.update(text("500", "1", "3"))).toBe(true);
    expect(valueAt(s, "v(out)", 2e-4)).toBeGreaterThan(4.9);
    // Moving the threshold above the control opens it again.
    expect(s.update(text("500", "4", "3"))).toBe(true);
    expect(valueAt(s, "v(out)", 3e-4)).toBeLessThan(0.01);
    // A smaller load with the switch closed: 5 V across 1 ohm and 20 ohm.
    expect(s.update(text("10", "1", "3"))).toBe(true);
    expect(Math.abs(valueAt(s, "v(out)", 4e-4) - (5 * 20) / 21)).toBeLessThan(1e-3);
  });

  it("reports a failure to converge from the next advance, not from update", () => {
    const text = (extra: string): string => `t\nV1 a 0 1\nR1 a 0 1k\nB1 b 0 I=${extra}\nR2 b 0 1\n`;
    const s = createLiveSession(text("0"), { tmax: 1e-5 });
    s.advance(1e-4, 60000);
    expect(s.update(text("if(v(b)>0,1,-1)"))).toBe(false);
  });
});

const available = listSamples().length > 0;

describe.skipIf(!available)("update on imported circuits", () => {
  const load = (name: string): Schematic => {
    const file = findSample(name);
    if (!file) throw new Error(`no sample ${name}`);
    return importMs14(new Uint8Array(readFileSync(file))).schematic;
  };
  const withPart = (doc: Schematic, comp: SchComponent, value: number): Schematic => ({
    ...doc,
    components: doc.components.map((c) => (c.id === comp.id ? applyInteractive(comp, value) : c)),
  });

  it("reverses Up-DownCounter mid-count without losing the count", () => {
    const doc = load("Up-DownCounter");
    const sw = doc.components.find((c) => c.interactive?.kind === "switch" && c.interactive.key === "Space");
    if (!sw || sw.interactive?.kind !== "switch") throw new Error("no Space switch");
    const text = buildNetlist(doc).text;
    const display = /^x\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+hex_display/im.exec(text);
    if (!display) throw new Error("no display");
    const bits = [display[1]!, display[2]!, display[3]!, display[4]!].map((n) => `v(${n.toLowerCase()})`);
    const s = createLiveSession(text, { tmax: 1e-5 });
    const read = (until: number): number => {
      const c = s.advance(until, 60000);
      let value = 0;
      bits.forEach((b, i) => {
        const y = c.values[s.names.indexOf(b)]!;
        if (y[y.length - 1]! > 2.5) value += 2 ** i;
      });
      return value;
    };
    const seq: number[] = [];
    for (let k = 0; k < 9; k++) seq.push(read((k + 0.75) * 1e-3));
    expect(s.update(buildNetlist(withPart(doc, sw, sw.interactive.position === 0 ? 1 : 0)).text)).toBe(true);
    const after: number[] = [];
    for (let k = 9; k < 18; k++) after.push(read((k + 0.75) * 1e-3));
    console.log(`Up-DownCounter: before ${seq.join(" ")} | after ${after.join(" ")}`);
    const step = (a: number[]): number => (a[1]! - a[0]! + 16) % 16;
    const d = step(seq);
    expect(d === 1 || d === 15).toBe(true);
    for (let i = 1; i < seq.length; i++) expect((seq[i]! - seq[i - 1]! + 16) % 16).toBe(d);
    // Every step after the flip goes the other way, starting from the count it had.
    const reverse = 16 - d;
    expect((after[0]! - seq[seq.length - 1]! + 16) % 16).toBe(reverse);
    for (let i = 1; i < after.length; i++) expect((after[i]! - after[i - 1]! + 16) % 16).toBe(reverse);
  }, 120000);

  it("holds and resumes DecimalCounter's count with its enable key", () => {
    const doc = load("DecimalCounter");
    const built = buildNetlist(doc);
    const j2 = doc.components.find((c) => c.interactive?.kind === "switch" && [...(built.pinNets.get(c.id)?.values() ?? [])].some((n) => n.toLowerCase() === "bus2_en"));
    if (!j2 || j2.interactive?.kind !== "switch") throw new Error("no enable switch");
    const text = built.text;
    const position = j2.interactive.position;
    const s = createLiveSession(text, { tmax: 1e-5 });
    const read = (until: number): number => {
      const c = s.advance(until, 60000);
      let value = 0;
      ["v(bus_qa)", "v(bus_qb)", "v(bus_qc)", "v(bus_qd)"].forEach((b, i) => {
        const y = c.values[s.names.indexOf(b)]!;
        if (y[y.length - 1]! > 2.5) value += 2 ** i;
      });
      return value;
    };
    const enabled = buildNetlist(withPart(doc, j2, position === 0 ? 1 : 0)).text;
    read(0.75e-3);
    expect(s.update(enabled)).toBe(true);
    const counting: number[] = [];
    for (let k = 1; k <= 7; k++) counting.push(read((k + 0.75) * 1e-3));
    expect(s.update(text)).toBe(true);
    const held: number[] = [];
    for (let k = 8; k <= 12; k++) held.push(read((k + 0.75) * 1e-3));
    expect(s.update(enabled)).toBe(true);
    const resumed: number[] = [];
    for (let k = 13; k <= 18; k++) resumed.push(read((k + 0.75) * 1e-3));
    console.log(`DecimalCounter: counting ${counting.join(" ")} | held ${held.join(" ")} | resumed ${resumed.join(" ")}`);
    const moves = new Set<number>();
    for (let i = 1; i < counting.length; i++) moves.add((counting[i]! - counting[i - 1]! + 10) % 10);
    expect(moves.size).toBe(1);
    const d = [...moves][0]!;
    expect(d).not.toBe(0);
    // Held at the count it reached, allowing for the edge in progress as the key moved.
    expect(new Set(held).size).toBe(1);
    const last = counting[counting.length - 1]!;
    expect([last, (last + d) % 10]).toContain(held[0]);
    for (let i = 1; i < resumed.length; i++) expect((resumed[i]! - resumed[i - 1]! + 10) % 10).toBe(d);
    expect([held[0], (held[0]! + d) % 10]).toContain(resumed[0]);
  }, 120000);

  it("starts WienBridgeOscillator from its present state when R1 moves", () => {
    const doc = load("WienBridgeOscillator");
    const r1 = doc.components.find((c) => c.refDes === "R1");
    if (!r1) throw new Error("no R1");
    const built = buildNetlist(doc);
    const out = `v(${built.pinNets.get(r1.id)!.get("3")!.toLowerCase()})`;
    const s = createLiveSession(built.text);
    const before = peakBetween(s, out, 20e-3);
    const t0 = s.time;
    expect(s.update(buildNetlist(withPart(doc, r1, 25)).text)).toBe(true);
    expect(s.time).toBe(t0);
    peakBetween(s, out, 60e-3);
    const after = peakBetween(s, out, 100e-3);
    // The same setting from a fresh start settles to about the same swing.
    const fresh = createLiveSession(buildNetlist(withPart(doc, r1, 25)).text);
    peakBetween(fresh, out, 60e-3);
    const settled = peakBetween(fresh, out, 100e-3);
    expect(Math.abs(after.high - after.low - (settled.high - settled.low))).toBeLessThan(0.1 * (settled.high - settled.low));
    console.log(`Wien bridge: swing at 50% ${(before.high - before.low).toExponential(2)} V, after moving R1 to 25% ${(after.high - after.low).toFixed(3)} V`);
    expect(after.high - after.low).toBeGreaterThan(1);
    expect(after.high - after.low).toBeGreaterThan(10 * Math.max(before.high - before.low, 1e-3));
  }, 120000);
});

describe("live speed", () => {
  const filter = "t\nV1 in 0 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 159n\n";
  const supply = "V2 vcc 0 12\nL1 vcc rail 10u\nC2 rail 0 1n\nR2 rail 0 100k\nRs in2 0 1k\nVx in2 0 0\n";

  const rate = (text: string): number => {
    const s = createLiveSession(text);
    s.advance(1e-4, 1000);
    const t0 = s.time;
    const start = performance.now();
    s.advance(1e9, 300);
    return (s.time - t0) / ((performance.now() - start) / 1000);
  };

  it("does not pay for an unexcited lightly damped mode", () => {
    const plain = rate(filter);
    const withLc = rate(filter + supply);
    console.log(`live speed: filter alone ${plain.toFixed(1)} sim-s/s, with idle 1.6 MHz LC ${withLc.toFixed(1)} sim-s/s`);
    expect(withLc).toBeGreaterThan(plain / 10);
  });

  it("pays for that mode while something excites it, then stops paying", () => {
    const s = createLiveSession(`t\nV1 in 0 PULSE(0 1 1m 1n 1n 1 2)\nR1 in rail 10k\nL1 rail 0 10u\nC2 rail 0 1n\nR2 rail 0 100k\n`);
    const k = s.names.indexOf("v(rail)");
    const c = s.advance(1.02e-3, 60000);
    // A 1 V step through 10 k kicks 10 mV of ringing at 1.59 MHz, period 628 ns, Q about 91.
    let afterStep = 0;
    for (let i = 0; i < c.time.length; i++) if (c.time[i]! > 1e-3 && c.time[i]! < 1.002e-3) afterStep++;
    expect(afterStep).toBeGreaterThan(50);
    let peak = 0;
    for (let i = 0; i < c.time.length; i++) if (c.time[i]! > 1e-3) peak = Math.max(peak, Math.abs(c.values[k]![i]!));
    expect(peak).toBeGreaterThan(0.005);
    // Once the ringing has died, steps return to their large size.
    const later = s.advance(1.2e-3, 60000);
    const t = later.time;
    // The ringing step is T / 30, about 21 ns.
    expect(t[t.length - 1]! - t[t.length - 2]!).toBeGreaterThan(2e-7);
  });
});

describe("transient step limit", () => {
  it("returns partial results with an explanation past the limit", () => {
    const c = elaborate(parseDeck("t\nV1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n"));
    c.build();
    const a = new Analysis(c, {});
    a.stepLimit = 5000;
    const r = a.tran({ type: "tran", tstep: 5, tstop: 5000, tmax: 1e-4 }, 0);
    expect(r.axis!.re.length).toBeGreaterThan(4000);
    expect(r.warnings.join()).toMatch(/stopped at t = .* partial\. Raise tmax or shorten tstop/);
    expect(vec(r, "v(out)").re.length).toBe(r.axis!.re.length);
  });

  it("does not refuse a long stored run up front", () => {
    let calls = 0;
    const r = simulate("t\nV1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n", { type: "tran", tstep: 5, tstop: 5000, tmax: 1e-4 }, { shouldStop: () => ++calls > 2000 });
    expect(r.axis!.re.length).toBeGreaterThan(1000);
  });
});
