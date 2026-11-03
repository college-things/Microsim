import { describe, expect, it } from "vitest";
import { fourier, monteCarlo, parameterSweep, rms } from "../../src/core/analyses";
import { Doc } from "../../src/core/doc";
import { buildNetlist, parseValue, pinWorld } from "../../src/core/netlist";
import type { SimResult } from "../../src/core/sim";

function divider() {
  const doc = new Doc();
  const v = doc.addPart("vdc", 0, 0, { value: "10" });
  const r1 = doc.addPart("resistor", 100, -50);
  const r2 = doc.addPart("resistor", 200, 0);
  const gnd = doc.addPart("ground", 0, 100);
  doc.connectPins(v, "p", r1, "1");
  doc.connectPins(r1, "2", r2, "1");
  doc.connectPins(r2, "2", gnd, "g");
  doc.connectPins(v, "n", gnd, "g");
  return { doc, v, r1, r2, gnd };
}

describe("netlister", () => {
  it("resolves wires into nets and maps ground to node 0", () => {
    const { doc, v, r1, r2 } = divider();
    const out = buildNetlist(doc.schematic);
    expect(out.warnings).toEqual([]);
    const nets = out.pinNets;
    expect(nets.get(v.id)!.get("n")).toBe("0");
    expect(nets.get(r2.id)!.get("2")).toBe("0");
    expect(nets.get(v.id)!.get("p")).toBe(nets.get(r1.id)!.get("1"));
    expect(nets.get(r1.id)!.get("2")).toBe(nets.get(r2.id)!.get("1"));
    expect(nets.get(r1.id)!.get("1")).not.toBe(nets.get(r1.id)!.get("2"));
    expect(out.text).toContain("V1 ");
    expect(out.text).toMatch(/R1 \S+ \S+ 1000/);
  });

  it("joins a wire ending on another wire but not a plain crossing", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 0, 100);
    const horizontal = pinWorld(a, a.pins[1]);
    doc.addWire([horizontal, { x: 200, y: horizontal.y }]);
    // Crosses the horizontal wire without ending on it.
    doc.addWire([{ x: 100, y: -50 }, { x: 100, y: 50 }]);
    const pin = pinWorld(b, b.pins[1]);
    doc.addWire([pin, { x: 150, y: pin.y }, { x: 150, y: horizontal.y }]);
    const nets = buildNetlist(doc.schematic).pinNets;
    expect(nets.get(a.id)!.get("2")).toBe(nets.get(b.id)!.get("2"));

    const crossing = new Doc();
    const c = crossing.addPart("resistor", 0, 0);
    const d = crossing.addPart("resistor", 100, -100);
    const cPin = pinWorld(c, c.pins[1]);
    crossing.addWire([cPin, { x: 200, y: cPin.y }]);
    const dPin = pinWorld(d, d.pins[0]);
    crossing.addWire([dPin, { x: 70, y: 100 }]);
    const crossed = buildNetlist(crossing.schematic).pinNets;
    expect(crossed.get(c.id)?.get("2")).not.toBe(crossed.get(d.id)?.get("1"));
  });

  it("joins pins that share a named net without any wire", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 500, 500);
    a.pins[0].net = "shared";
    b.pins[1].net = "shared";
    const nets = buildNetlist(doc.schematic).pinNets;
    expect(nets.get(a.id)!.get("1")).toBe("shared");
    expect(nets.get(b.id)!.get("2")).toBe("shared");
  });

  it("warns about open pins and a missing ground", () => {
    const doc = new Doc();
    doc.addPart("resistor", 0, 0);
    const warnings = buildNetlist(doc.schematic).warnings.join(" ");
    expect(warnings).toContain("R1: pin 1 is not connected");
    expect(warnings).toContain("no ground");
  });

  it("adds shared model text once", () => {
    const doc = new Doc();
    doc.addPart("diode", 0, 0);
    doc.addPart("diode", 0, 100);
    const text = buildNetlist(doc.schematic).text;
    expect(text.match(/\.model D_GENERIC/g)).toHaveLength(1);
  });

  it("rotates and mirrors pins consistently", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 100, 100);
    expect(pinWorld(r, r.pins[1])).toEqual({ x: 130, y: 100 });
    r.rotation = 90;
    expect(pinWorld(r, r.pins[1])).toEqual({ x: 100, y: 130 });
    r.rotation = 180;
    expect(pinWorld(r, r.pins[1])).toEqual({ x: 70, y: 100 });
    r.rotation = 0;
    r.mirrored = true;
    expect(pinWorld(r, r.pins[1])).toEqual({ x: 70, y: 100 });
  });

  it("configures instruments as circuit elements only when they need to be", () => {
    const doc = new Doc();
    const meter = doc.addPart("multimeter", 0, 0, { mode: "volts" });
    expect(buildNetlist(doc.schematic).text).not.toContain(`V${meter.refDes}`);
    meter.params.mode = "amps";
    expect(buildNetlist(doc.schematic).text).toContain(`V${meter.refDes}`);
    meter.params.mode = "ohms";
    expect(buildNetlist(doc.schematic).text).toContain(`I${meter.refDes}`);
    const gen = doc.addPart("function-generator", 0, 200, { shape: "square", freq: "1k", amp: "5" });
    expect(buildNetlist(doc.schematic).text).toContain(`V${gen.refDes}`);
    expect(buildNetlist(doc.schematic).text).toContain("PULSE(-5 5");
  });
});

describe("document", () => {
  it("undoes and redoes edits", () => {
    const doc = new Doc();
    doc.checkpoint();
    doc.addPart("resistor", 0, 0);
    expect(doc.schematic.components).toHaveLength(1);
    doc.undo();
    expect(doc.schematic.components).toHaveLength(0);
    doc.redo();
    expect(doc.schematic.components).toHaveLength(1);
  });

  it("numbers references without collisions", () => {
    const doc = new Doc();
    expect(doc.addPart("resistor", 0, 0).refDes).toBe("R1");
    expect(doc.addPart("resistor", 0, 0).refDes).toBe("R2");
    doc.removeComponent(doc.schematic.components[0].id);
    expect(doc.addPart("resistor", 0, 0).refDes).toBe("R1");
  });

  it("rejects unknown pins with a helpful message", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 100, 0);
    expect(() => doc.connectPins(a, "x", b, "1")).toThrow(/Pins: 1, 2/);
  });
});

describe("values and analyses", () => {
  it("parses engineering suffixes", () => {
    expect(parseValue("10k")).toBe(10000);
    expect(parseValue("2.2u")).toBeCloseTo(2.2e-6, 12);
    expect(parseValue("1meg")).toBe(1e6);
    expect(parseValue("3m")).toBeCloseTo(3e-3, 12);
    expect(parseValue("1e3")).toBe(1000);
    expect(parseValue("nonsense")).toBe(0);
  });

  it("finds harmonics and distortion of a known waveform", () => {
    const f = 1000;
    const n = 20000;
    const time = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 5e-3);
    const values = time.map((t) => 2 + 3 * Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 3 * f * t));
    const out = fourier(time, values, f);
    expect(out.dc).toBeCloseTo(2, 2);
    expect(out.rows[0].magnitude).toBeCloseTo(3, 2);
    expect(out.rows[2].magnitude).toBeCloseTo(0.3, 2);
    expect(out.thd).toBeCloseTo(10, 0);
  });

  it("computes RMS of a sine", () => {
    const n = 5000;
    const time = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 1e-3);
    const values = time.map((t) => 10 * Math.sin(2 * Math.PI * 1000 * t));
    expect(rms(values, time)).toBeCloseTo(10 / Math.SQRT2, 2);
  });

  const fake = (seen: string[]) => async (netlist: string): Promise<SimResult> => {
    seen.push(netlist);
    return { analysis: "op", vectors: [], warnings: [], stats: { unknowns: 0, iterations: 0, steps: 0, elapsedMs: 0 } };
  };

  it("sweeps a parameter across its range without touching the document", async () => {
    const { doc } = divider();
    const seen: string[] = [];
    const runs = await parameterSweep(doc.schematic, "R1", "value", 1000, 3000, 3, { type: "op" }, fake(seen));
    expect(runs.map((r) => r.label)).toEqual(["R1.value=1000", "R1.value=2000", "R1.value=3000"]);
    expect(seen[2]).toMatch(/R1 \S+ \S+ 3000/);
    expect(doc.schematic.components.find((c) => c.refDes === "R1")!.params.value).toBe("1k");
  });

  it("varies passives within tolerance in Monte Carlo", async () => {
    const { doc } = divider();
    const seen: string[] = [];
    await monteCarlo(doc.schematic, 2, 10, { type: "op" }, fake(seen), () => 1);
    expect(seen[0]).toMatch(/R1 \S+ \S+ 1100/);
    expect(seen[0]).toContain("DC 10");
  });
});
