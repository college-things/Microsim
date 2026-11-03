import { describe, expect, it } from "vitest";
import { summarize } from "../../src/agent/tools";
import { Doc } from "../../src/core/doc";
import { parseCircuit } from "../../src/core/file";
import { connectivitySignature, listSources, resolveSource } from "../../src/core/netlist";
import { LiveBuffer } from "../../src/sim/live";
import { acRms } from "../../src/ui/instruments";

const ramp = (from: number, to: number) => Float64Array.from({ length: to - from }, (_, i) => from + i);

describe("live buffer", () => {
  it("keeps samples in order and returns the newest window", () => {
    const buffer = new LiveBuffer(["v(a)"], 100);
    buffer.append(ramp(0, 10), [ramp(100, 110)]);
    buffer.append(ramp(10, 20), [ramp(110, 120)]);
    const snap = buffer.snapshot(4)!;
    expect(Array.from(snap.axis!.re)).toEqual([15, 16, 17, 18, 19]);
    expect(Array.from(snap.vectors[0].re)).toEqual([115, 116, 117, 118, 119]);
    expect(snap.vectors[0].name).toBe("v(a)");
  });

  it("stays within its capacity and keeps the newest data on a long run", () => {
    const buffer = new LiveBuffer(["v(a)"], 100);
    for (let start = 0; start < 5000; start += 30) buffer.append(ramp(start, start + 30), [ramp(start, start + 30)]);
    expect(buffer.length).toBeLessThanOrEqual(100);
    const snap = buffer.snapshot(1e9)!;
    const values = Array.from(snap.axis!.re);
    expect(values[values.length - 1]).toBe(5009);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBe(values[i - 1] + 1);
    expect(Array.from(snap.vectors[0].re)).toEqual(values);
  });

  it("handles a chunk larger than the whole buffer", () => {
    const buffer = new LiveBuffer(["v(a)"], 10);
    buffer.append(ramp(0, 3), [ramp(0, 3)]);
    buffer.append(ramp(3, 53), [ramp(3, 53)]);
    expect(Array.from(buffer.snapshot(1e9)!.axis!.re)).toEqual(Array.from(ramp(43, 53)));
  });

  it("has nothing to show before any data", () => {
    expect(new LiveBuffer(["v(a)"], 10).snapshot(1)).toBeUndefined();
  });
});

describe("measurement", () => {
  it("reads AC RMS correctly over a partial number of periods", () => {
    const n = 40000;
    const time = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 5.37e-3);
    const values = time.map((t) => 3 + 5 * Math.sin(2 * Math.PI * 1000 * t));
    expect(acRms(values, time)).toBeCloseTo(5 / Math.SQRT2, 2);
  });

  it("gives the assistant a settled frequency and RMS", () => {
    const n = 20000;
    const re = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 10e-3);
    const summary = summarize({
      analysis: "tran", axis: { name: "time", unit: "s", re },
      vectors: [{ name: "v(a)", unit: "V", re: re.map((t) => 2 * Math.sin(2 * Math.PI * 1000 * t)) }],
      warnings: [], stats: { unknowns: 0, iterations: 0, steps: 0, elapsedMs: 0 },
    }) as any;
    expect(summary.vectors[0].settled_frequency_hz).toBeCloseTo(1000, 0);
    expect(summary.vectors[0].settled_rms).toBeCloseTo(Math.SQRT2, 2);
  });
});

describe("source names", () => {
  const netlist = "* t\nV1 a 0 1\nvV2 b 0 1\nI3 c 0 1\nR1 a b 1\n.subckt S x\nV9 x 0 1\n.ends\n.end";

  it("lists only top-level independent sources", () => {
    expect(listSources(netlist)).toEqual(["V1", "vV2", "I3"]);
  });

  it("finds a source from its name on the sheet", () => {
    expect(resolveSource(netlist, "v1")).toBe("V1");
    expect(resolveSource(netlist, "V2")).toBe("vV2");
    expect(resolveSource(netlist, "3")).toBe("I3");
    expect(resolveSource(netlist, "V9")).toBeUndefined();
  });
});

describe("edits that used to lose or corrupt state", () => {
  it("marks the document changed after undoing past a save", () => {
    const doc = new Doc();
    doc.checkpoint();
    doc.addPart("resistor", 0, 0);
    doc.dirty = false;
    doc.undo();
    expect(doc.dirty).toBe(true);
    doc.dirty = false;
    doc.redo();
    expect(doc.dirty).toBe(true);
  });

  it("removes labels left on a deleted part's pins", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    doc.schematic.labels.push({ id: "l", x: 30, y: 0, net: "SIG", hidden: true });
    doc.removeComponentAndWires(r.id);
    expect(doc.schematic.labels).toHaveLength(0);
    const next = doc.addPart("resistor", 0, 0);
    expect(connectivitySignature(doc.schematic)).toBe("");
    expect(next).toBeTruthy();
  });

  it("routes wires around labels so they can't join a net by accident", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    doc.schematic.labels.push({ id: "l", x: 150, y: 0, net: "OTHER" });
    doc.connectPins(a, "2", b, "1");
    const wire = doc.schematic.wires[0];
    const crosses = wire.points.some((p, i) => {
      if (i === 0) return false;
      const q = wire.points[i - 1];
      return q.y === 0 && p.y === 0 && Math.min(q.x, p.x) <= 150 && Math.max(q.x, p.x) >= 150;
    });
    expect(crosses).toBe(false);
  });

  it("rejects a file whose wires are absurdly far away", () => {
    const hostile = JSON.stringify({
      name: "x", definitions: "", components: [], labels: [], texts: [],
      wires: [{ id: "w", points: [{ x: 0, y: 0 }, { x: 1e6, y: 1e6 }] }],
    });
    expect(() => parseCircuit(hostile)).toThrow(/wire position/);
  });
});
