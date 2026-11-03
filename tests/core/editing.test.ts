// Deletion, refused edits, fallback connections and layout, checked by what stays connected.
import { describe, expect, it } from "vitest";
import { runTool } from "../../src/agent/tools";
import { Doc } from "../../src/core/doc";
import { runsToCsv } from "../../src/core/export";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { buildNetlist, connectivitySignature, pinWorld } from "../../src/core/netlist";
import { simulate } from "../../src/engine/index";
import { settledMean } from "../../src/ui/instruments";

const run = async (netlist: string, request: any) => simulate(netlist, request);
const net = (doc: Doc, comp: { id: string }, pin: string) => buildNetlist(doc.schematic).pinNets.get(comp.id)?.get(pin);

describe("deleting a part", () => {
  it("keeps a wire that still joins two other parts", () => {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 400, 0);
    const r3 = doc.addPart("resistor", 200, 200);
    r3.rotation = 90;
    doc.connectPins(r1, "2", r2, "1");
    const trunk = doc.schematic.wires[0];
    const tee = pinWorld(r3, r3.pins[0]);
    doc.addWire([tee, { x: tee.x, y: trunk.points[0].y }]);
    expect(net(doc, r1, "2")).toBe(net(doc, r3, "1"));
    doc.removeComponentAndWires(r2.id);
    expect(net(doc, r1, "2")).toBeTruthy();
    expect(net(doc, r1, "2")).toBe(net(doc, r3, "1"));
  });

  it("keeps two parts joined only through the deleted part's pin", () => {
    const doc = new Doc();
    const middle = doc.addPart("resistor", 200, 0);
    const a = doc.addPart("resistor", 0, 200);
    const b = doc.addPart("resistor", 400, 200);
    doc.connectPins(a, "1", middle, "1");
    doc.connectPins(b, "1", middle, "1");
    expect(net(doc, a, "1")).toBe(net(doc, b, "1"));
    doc.removeComponentAndWires(middle.id);
    expect(net(doc, a, "1")).toBe(net(doc, b, "1"));
  });

  it("removes a wire that served only the deleted part", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    doc.connectPins(a, "2", b, "1");
    doc.removeComponentAndWires(b.id);
    expect(doc.schematic.wires).toHaveLength(0);
  });
});

describe("refused edits", () => {
  it("revert leaves nothing for redo to bring back", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    doc.checkpoint();
    r.x = 500;
    doc.revert();
    expect(doc.schematic.components[0].x).toBe(0);
    doc.redo();
    expect(doc.schematic.components[0].x).toBe(0);
  });
});

describe("connections with no clear route", () => {
  function forced() {
    const doc = new Doc();
    doc.clearRoute = () => undefined;
    return doc;
  }

  it("connects through visible labels that can be seen and removed", () => {
    const doc = forced();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    doc.connectPins(a, "2", b, "1");
    expect(net(doc, a, "2")).toBe(net(doc, b, "1"));
    expect(doc.schematic.labels).toHaveLength(2);
    expect(doc.schematic.labels.every((l) => !l.hidden)).toBe(true);
    expect(a.pins[1].net).toBeUndefined();
    doc.disconnectPin(a, "2");
    expect(net(doc, a, "2")).not.toBe(net(doc, b, "1"));
  });

  it("gives separate fallback connections separate names", () => {
    const doc = forced();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    const c = doc.addPart("resistor", 0, 300);
    const d = doc.addPart("resistor", 300, 300);
    doc.connectPins(a, "2", b, "1");
    doc.connectPins(c, "2", d, "1");
    expect(net(doc, a, "2")).not.toBe(net(doc, c, "2"));
  });
});

describe("disconnecting", () => {
  it("cuts only that pin", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    const c = doc.addPart("resistor", 600, 0);
    doc.connectPins(a, "2", b, "1");
    doc.connectPins(b, "2", c, "1");
    doc.disconnectPin(a, "2");
    expect(net(doc, a, "2")).toBeUndefined();
    expect(net(doc, b, "2")).toBe(net(doc, c, "1"));
    expect(() => doc.disconnectPin(a, "nope")).toThrow(/Pins:/);
  });
});

describe("tidy layout", () => {
  for (const example of EXAMPLES) {
    it(`keeps every connection in ${example.name}`, () => {
      const doc = new Doc();
      doc.schematic = buildExample(example);
      const before = connectivitySignature(doc.schematic);
      expect(doc.tidyLayout()).toBe(true);
      expect(connectivitySignature(doc.schematic)).toBe(before);
    });
  }

  it("separates parts that were stacked on one spot", () => {
    const doc = new Doc();
    const v = doc.addPart("vdc", 0, 0);
    const r = doc.addPart("resistor", 0, 0);
    const g = doc.addPart("ground", 0, 0);
    // Wired before moving, by shared names, because stacked pins would collide.
    v.pins[0].net = "a";
    r.pins[0].net = "a";
    v.pins[1].net = "0";
    r.pins[1].net = "0";
    expect(doc.tidyLayout()).toBe(true);
    const spots = new Set([v, r, g].map((c) => `${c.x},${c.y}`));
    expect(spots.size).toBe(3);
  });
});

describe("assistant measurement", () => {
  const doc = () => {
    const d = new Doc();
    const v = d.addPart("vsin", -200, 0, { amp: "1", freq: "1k" });
    const r = d.addPart("resistor", -40, -30, { value: "1k" });
    const c = d.addPart("capacitor", 120, 40, { value: "159n" });
    const g = d.addPart("ground", -200, 130);
    d.connectPins(v, "p", r, "1");
    d.connectPins(r, "2", c, "1");
    d.connectPins(c, "2", g, "g");
    d.connectPins(v, "n", g, "g");
    return { d, c };
  };

  it("reports magnitude and phase at a chosen frequency", async () => {
    const { d, c } = doc();
    const out = (await runTool(d, "run_analysis", { type: "ac", fstart: 1, fstop: 1e5, at_hz: 1000 }, run)) as any;
    const node = net(d, c, "1");
    const row = out.at_frequency.vectors.find((v: any) => v.name === `v(${node})`);
    expect(row.magnitude).toBeCloseTo(Math.SQRT1_2, 1);
    expect(row.phase_deg).toBeCloseTo(-45, -1);
  });

  it("reports distortion and gain", async () => {
    const { d } = doc();
    const tran = (await runTool(d, "run_analysis", { type: "tran", tstop: 10e-3, tmax: 1e-5, thd_at_hz: 1000 }, run)) as any;
    expect(tran.distortion[0].thd_percent).toBeLessThan(1);
    const gain = (await runTool(d, "run_analysis", { type: "transfer", output: `v(${net(d, d.findByRef("R1")!, "2")})`, source: "V1" }, run)) as any;
    expect(gain.transfer.gain).toBeCloseTo(1, 3);
  });

  it("finds a source by its sheet name", async () => {
    const { d } = doc();
    await expect(runTool(d, "run_analysis", { type: "dc", source: "nope", start: 0, stop: 1, step: 1 }, run)).rejects.toThrow(/Sources: V1/);
  });

  it("returns pin positions when placing", async () => {
    const out = (await runTool(new Doc(), "add_component", { kind: "resistor", x: 100, y: 100 }, run)) as any;
    expect(out.pins).toEqual([{ name: "1", x: 70, y: 100 }, { name: "2", x: 130, y: 100 }]);
  });
});

describe("meters and exports", () => {
  it("averages the latest half for a DC reading", () => {
    const n = 2000;
    const time = Float64Array.from({ length: n }, (_, i) => i / (n - 1));
    const values = time.map((t) => (t < 0.5 ? 0 : 9.3));
    expect(settledMean(values, time)).toBeCloseTo(9.3, 1);
  });

  it("includes every run in a multi-run CSV", () => {
    const result = (value: number) => ({
      analysis: "tran" as const, axis: { name: "time", unit: "s" as const, re: Float64Array.of(0, 1) },
      vectors: [{ name: "v(a)", unit: "V" as const, re: Float64Array.of(value, value) }],
      warnings: [], stats: { unknowns: 0, iterations: 0, steps: 0, elapsedMs: 0 },
    });
    const lines = runsToCsv([{ label: "R=1", result: result(1) }, { label: "R,2", result: result(2) }]).trim().split("\n");
    expect(lines[0]).toBe("run,time,v(a)");
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe('"R,2",0,2');
  });
});
