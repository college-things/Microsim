// Regressions from the fourth review: meter windows, disconnects, redo, unsimulated parts.
import { describe, expect, it } from "vitest";
import { runTool, summarize } from "../../src/agent/tools";
import { acRms, settledMean } from "../../src/core/analyses";
import { Doc } from "../../src/core/doc";
import { limitIssues, unsimulatedParts } from "../../src/core/limits";
import { buildNetlist, pinWorld } from "../../src/core/netlist";
import { emptySchematic } from "../../src/core/schematic";
import { simulate } from "../../src/engine/index";

const run = async (netlist: string, request: any) => simulate(netlist, request);
const net = (doc: Doc, comp: { id: string }, pin: string) => buildNetlist(doc.schematic).pinNets.get(comp.id)?.get(pin);

const sine = (seconds: number, cycles: number, offset: number, amp: number) => {
  const n = Math.round(cycles * 40);
  const time = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * seconds);
  return { time, values: time.map((t) => offset + amp * Math.sin((2 * Math.PI * cycles * t) / seconds)) };
};

describe("meter windows", () => {
  it("reads zero DC from a pure sine at any phase", () => {
    for (const cycles of [10.13, 25.5, 40.77]) {
      const { time, values } = sine(0.05, cycles, 0, 10);
      expect(Math.abs(settledMean(values, time))).toBeLessThan(0.05);
    }
  });

  it("reads the offset of a sine with DC", () => {
    const { time, values } = sine(0.05, 33.3, 2, 1);
    expect(settledMean(values, time)).toBeCloseTo(2, 1);
    expect(acRms(values, time)).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it("follows a step quickly when nothing repeats", () => {
    const n = 2000;
    const time = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 15);
    // A switch opens 0.5 s before the end of a 15 s window.
    const values = time.map((t) => (t < 14.5 ? 10 : 0));
    expect(settledMean(values, time)).toBeCloseTo(0, 6);
    // AC looks further back when no periods exist, so it clears once the step is further behind.
    const earlier = time.map((t) => (t < 10 ? 10 : 0));
    expect(acRms(earlier, time)).toBeCloseTo(0, 6);
  });

  it("isn't misled by a signal that has changed character", () => {
    const n = 8000;
    const time = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 0.1);
    // A 1 kHz sine that stops halfway through the window.
    const stopped = time.map((t) => (t < 0.05 ? 10 * Math.sin(2 * Math.PI * 1000 * t) : 0));
    expect(acRms(stopped, time)).toBeCloseTo(0, 3);
    // A charging supply with ripple reads near its present level, not an old crossing.
    const charging = time.map((t) => 10 * (1 - Math.exp(-t / 0.03)) + 0.1 * Math.sin(2 * Math.PI * 1000 * t));
    expect(Math.abs(settledMean(charging, time) - 9.64)).toBeLessThan(0.15);
    // Clustered crossings from chatter aren't taken as periods.
    const chatter = time.map((t, i) => (t < 0.09 ? 5 : 5 + (i % 2 ? 0.5 : -0.5)));
    expect(settledMean(chatter, time)).toBeCloseTo(5, 0);
  });

  it("gets something sensible from a slow signal just starting", () => {
    const n = 2000;
    const time = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 2.5);
    const values = time.map((t) => 10 * Math.sin(2 * Math.PI * 0.1 * t));
    // Only a quarter period so far, so a true RMS isn't knowable, but it must not read near zero.
    expect(acRms(values, time)).toBeGreaterThan(0.1);
  });

  it("isn't fooled by solver residue", () => {
    const n = 200;
    const time = Float64Array.from({ length: n }, (_, i) => i / (n - 1));
    const values = time.map((_, i) => 5 + (i % 2 ? 1e-12 : -1e-12));
    expect(settledMean(values, time)).toBeCloseTo(5, 6);
  });

  it("gives the assistant the true mean of a sine", () => {
    const { time, values } = sine(0.0123, 12.3, 0, 1);
    const out = summarize({
      analysis: "tran", axis: { name: "time", unit: "s", re: time },
      vectors: [{ name: "v(a)", unit: "V", re: values }],
      warnings: [], stats: { unknowns: 0, iterations: 0, steps: 0, elapsedMs: 0 },
    }) as any;
    expect(Math.abs(out.vectors[0].settled_mean)).toBeLessThan(0.02);
    expect(out.vectors[0].settled_rms).toBeCloseTo(Math.SQRT1_2, 1);
  });
});

describe("disconnecting a pin in a chain", () => {
  it("keeps the other parts joined", () => {
    const doc = new Doc();
    const v = doc.addPart("vdc", -300, 0);
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 300, 200);
    doc.connectPins(v, "p", r1, "1");
    doc.connectPins(r1, "1", r2, "1");
    expect(net(doc, v, "p")).toBe(net(doc, r2, "1"));
    doc.disconnectPin(r1, "1");
    expect(net(doc, r1, "1")).toBeUndefined();
    expect(net(doc, v, "p")).toBe(net(doc, r2, "1"));
  });

  it("keeps a tap on the removed wire connected to the far end", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 400, 0);
    const c = doc.addPart("resistor", 200, 200);
    c.rotation = 90;
    doc.connectPins(a, "2", b, "1");
    const tee = pinWorld(c, c.pins[0]);
    doc.addWire([tee, { x: tee.x, y: 0 }]);
    doc.disconnectPin(b, "1");
    expect(net(doc, b, "1")).toBeUndefined();
    expect(net(doc, a, "2")).toBeTruthy();
    expect(net(doc, a, "2")).toBe(net(doc, c, "1"));
  });

  it("keeps parts sharing a net name with a wire connected", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    const c = doc.addPart("resistor", 600, 0);
    const atA = pinWorld(a, a.pins[1]);
    const atB = pinWorld(b, b.pins[0]);
    doc.schematic.labels.push({ id: "1", ...atA, net: "X" }, { id: "2", ...atB, net: "X" });
    doc.connectPins(b, "1", c, "1");
    expect(net(doc, a, "2")).toBe(net(doc, c, "1"));
    doc.disconnectPin(b, "1");
    expect(net(doc, a, "2")).toBe(net(doc, c, "1"));
    expect(net(doc, b, "1")).toBeUndefined();
  });

  it("refuses a pin that can't leave its net, and leaves the circuit alone", () => {
    const doc = new Doc();
    // Two ground parts are always the same net, whatever is wired to them.
    const g1 = doc.addPart("ground", 0, 0);
    doc.addPart("ground", 300, 0);
    const before = JSON.stringify(doc.schematic);
    expect(() => doc.disconnectPin(g1, "g")).toThrow(/can't be separated/);
    expect(JSON.stringify(doc.schematic)).toBe(before);
  });

  it("refuses when a wire runs straight through the pin", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    doc.addWire([{ x: 30, y: -50 }, { x: 30, y: 50 }]);
    expect(() => doc.disconnectPin(r, "2")).toThrow(/runs straight through/);
  });
});

describe("redo after a refused edit", () => {
  it("keeps what could already be redone, and the saved state", () => {
    const doc = new Doc();
    doc.checkpoint();
    doc.addPart("resistor", 0, 0);
    doc.undo();
    doc.dirty = false;
    doc.checkpoint();
    doc.addPart("capacitor", 0, 0);
    doc.revert();
    expect(doc.dirty).toBe(false);
    expect(doc.schematic.components).toHaveLength(0);
    doc.redo();
    expect(doc.schematic.components.map((c) => c.kind)).toEqual(["resistor"]);
  });
});

describe("assistant input checks", () => {
  it("rejects unknown parameters, bad values and absurd positions", async () => {
    const doc = new Doc();
    await expect(runTool(doc, "add_component", { kind: "resistor", x: 0, y: 0, params: { nope: "1" } }, run)).rejects.toThrow(/no parameter/);
    await expect(runTool(doc, "add_component", { kind: "resistor", x: 0, y: 0, params: { value: "banana" } }, run)).rejects.toThrow(/not a valid/);
    await expect(runTool(doc, "add_component", { kind: "resistor", x: 1e9, y: 0 }, run)).rejects.toThrow(/too far/);
    const r = doc.addPart("resistor", 0, 0);
    await expect(runTool(doc, "move_component", { ref: r.refDes, x: 1e9, y: 0 }, run)).rejects.toThrow(/too far/);
    expect(r.x).toBe(0);
  });
});

describe("parts Microsim doesn't simulate", () => {
  const part = (refDes: string, spice: string) => ({
    id: refDes, refDes, kind: "imported", x: 0, y: 0, rotation: 0 as const, mirrored: false, params: {}, pins: [], spice,
  });

  it("names a microcontroller, directly or through its model", () => {
    const doc = emptySchematic();
    doc.components.push(part("U2", "a{ref} [p1] U2_MODEL"), part("R1", "r{ref} a b 1k"));
    doc.definitions = ".model U2_MODEL d_cpu(foo=1)";
    const notices = unsimulatedParts(doc);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("U2");
    expect(notices[0]).toContain("microcontroller");
    expect(notices[0]).not.toContain("R1");
    expect(limitIssues(doc)[0].severity).toBe("error");
  });

  it("matches a model by its whole name, and writes proper sentences", () => {
    const doc = emptySchematic();
    doc.components.push(part("Q1", "q{ref} c b e 2N3904"), part("U1", "a{ref} [p1] 2N"), part("U2", "a{ref} [p2] d_lcd44780"));
    doc.definitions = ".model 2N d_cpu(foo=1)";
    const text = unsimulatedParts(doc).join(" ");
    expect(text).not.toContain("Q1");
    expect(text).toContain("U1 is a microcontroller");
    expect(text).toContain("U2 is an LCD");
  });

  it("stays quiet about ordinary circuits", () => {
    const doc = emptySchematic();
    doc.components.push(part("R1", "r{ref} a b 1k"));
    doc.definitions = ".model D1 d(is=1n)";
    expect(unsimulatedParts(doc)).toEqual([]);
  });
});
