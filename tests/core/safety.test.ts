// Regressions for the ways an edit or a file could silently change what gets simulated.
import { beforeEach, describe, expect, it } from "vitest";
import { Doc } from "../../src/core/doc";
import { parseCircuit, serializeCircuit } from "../../src/core/file";
import { buildNetlist, connectivitySignature, parseValue, pinWorld, readValue } from "../../src/core/netlist";
import { findVector, monteCarlo, parameterSweep } from "../../src/core/analyses";
import { MUTATING_TOOLS, runTool, TOOL_SPECS, validateToolInput } from "../../src/agent/tools";
import { simulate } from "../../src/engine/index";

function series() {
  const doc = new Doc();
  const v = doc.addPart("vdc", -200, 0, { value: "12" });
  const r1 = doc.addPart("resistor", -40, -30, { value: "1k" });
  const r2 = doc.addPart("resistor", 120, -30, { value: "3k" });
  const gnd = doc.addPart("ground", -200, 110);
  doc.connectPins(v, "p", r1, "1");
  doc.connectPins(r1, "2", r2, "1");
  doc.connectPins(r2, "2", gnd, "g");
  doc.connectPins(v, "n", gnd, "g");
  return { doc, v, r1, r2, gnd };
}

const midpoint = (doc: Doc, comp: { id: string }, pin: string) => {
  const n = buildNetlist(doc.schematic);
  return findVector(simulate(n.text, { type: "op" }), `v(${n.pinNets.get(comp.id)!.get(pin)})`)!.re[0];
};

describe("turning parts keeps connections", () => {
  it("survives every rotation and mirror", () => {
    const { doc, r1, r2 } = series();
    const before = connectivitySignature(doc.schematic);
    const expected = midpoint(doc, r2, "1");
    for (const rotation of [90, 180, 270, 0] as const) {
      expect(doc.transformParts([r1], (c) => { c.rotation = rotation; }), `rotation ${rotation}`).toBe(true);
      expect(connectivitySignature(doc.schematic)).toBe(before);
      expect(midpoint(doc, r2, "1")).toBeCloseTo(expected, 6);
    }
    expect(doc.transformParts([r1], (c) => { c.mirrored = true; })).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(before);
    expect(midpoint(doc, r2, "1")).toBeCloseTo(expected, 6);
  });

  it("moves wired parts without changing connections", () => {
    const { doc, r1 } = series();
    const before = connectivitySignature(doc.schematic);
    expect(doc.transformParts([r1], (c) => { c.x += 60; c.y -= 150; })).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(before);
  });

  it("carries a hidden link label with its pin", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 500, 500);
    const at = pinWorld(a, a.pins[1]);
    const far = pinWorld(b, b.pins[0]);
    doc.schematic.labels.push({ id: "1", x: at.x, y: at.y, net: "LINK", hidden: true }, { id: "2", x: far.x, y: far.y, net: "LINK", hidden: true });
    const before = connectivitySignature(doc.schematic);
    expect(doc.transformParts([a], (c) => { c.x += 100; c.y += 50; })).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(before);
    expect(doc.schematic.labels[0]).toMatchObject({ x: at.x + 100, y: at.y + 50 });
  });

  it("lets a simulated part keep its name when a drawing has the same one", () => {
    const doc = new Doc();
    const drawing = doc.addPart("resistor", 0, 0);
    drawing.kind = "imported";
    drawing.spice = "";
    drawing.refDes = "V5";
    const source = doc.addPart("vdc", 300, 0);
    source.refDes = "V5";
    expect(buildNetlist(doc.schematic).refs.get(source.id)).toBe("V5");
  });

  it("restores the circuit when a transform can't keep connections", () => {
    const { doc, r1, gnd } = series();
    // Landing a pin on ground's pin connects them no matter how wires route.
    const target = pinWorld(gnd, gnd.pins[0]);
    const snapshot = JSON.stringify(doc.schematic);
    const ok = doc.transformParts([r1], (c) => { c.x = target.x + 30; c.y = target.y; });
    expect(ok).toBe(false);
    expect(JSON.stringify(doc.schematic)).toBe(snapshot);
  });
});

describe("display names can't change the part", () => {
  for (const name of ["Load", "Cin", "Vout", "Input", "R 1", "*R1", ".R1", "1", "a\nV9 x 0 5"]) {
    it(`renaming a resistor to ${JSON.stringify(name)} keeps it a resistor`, () => {
      const { doc, r1, r2 } = series();
      r1.refDes = name;
      const netlist = buildNetlist(doc.schematic);
      expect(netlist.text.split("\n").filter((l) => /^R/i.test(l))).toHaveLength(2);
      expect(netlist.text).not.toMatch(/^V9/m);
      expect(midpoint(doc, r2, "1")).toBeCloseTo(9, 6);
    });
  }

  it("handles an empty name", () => {
    const { doc, r1, r2 } = series();
    r1.refDes = "";
    expect(midpoint(doc, r2, "1")).toBeCloseTo(9, 6);
  });

  it("keeps duplicate names apart and warns", () => {
    const { doc, r1, r2 } = series();
    r1.refDes = "RX";
    r2.refDes = "RX";
    const netlist = buildNetlist(doc.schematic);
    expect(netlist.warnings.join(" ")).toContain("Two parts are named RX");
    expect(midpoint(doc, r2, "1")).toBeCloseTo(9, 6);
  });

  it("gives instruments their sense source under the safe name", () => {
    const doc = new Doc();
    const meter = doc.addPart("multimeter", 0, 0, { mode: "amps" });
    meter.refDes = "my meter!";
    const netlist = buildNetlist(doc.schematic);
    expect(netlist.text).toContain(`V${netlist.refs.get(meter.id)} `);
    expect(netlist.refs.get(meter.id)).toBe("my_meter_");
  });
});

describe("value entry", () => {
  it.each([
    ["1M", 1e6], ["1Meg", 1e6], ["1MEG", 1e6], ["1m", 1e-3], ["1Mohm", 1e6], ["10kOhm", 1e4], ["2.2uF", 2.2e-6],
    ["4.7n", 4.7e-9], ["1G", 1e9], ["100", 100], ["1e3", 1000], ["-5", -5], [".5", 0.5], ["1.5k", 1500], ["3 k", 3000], ["5V", 5], ["1H", 1],
  ])("reads %s as %d", (text, value) => {
    expect(readValue(text)).toBeCloseTo(value, 12);
  });

  it.each(["abc", "1k2", "1,5k", "10%", "2 3", "1e400", "", "1e3k", "--1", "1k k"])("rejects %j", (text) => {
    expect(readValue(text)).toBeUndefined();
    expect(parseValue(text)).toBe(0);
  });

  it("makes a typed 1M a megohm in the simulation", () => {
    const { doc, r1, r2 } = series();
    r1.params.value = "1M";
    r2.params.value = "1Meg";
    expect(midpoint(doc, r2, "1")).toBeCloseTo(6, 4);
  });

  it("blocks a run on bad or impossible values", () => {
    const { doc, r1, v } = series();
    r1.params.value = "10%";
    expect(buildNetlist(doc.schematic).errors[0]).toContain('"10%"');
    r1.params.value = "-1k";
    expect(buildNetlist(doc.schematic).errors[0]).toContain("greater than zero");
    r1.params.value = "1k";
    v.params.value = "-5";
    expect(buildNetlist(doc.schematic).errors).toEqual([]);
  });
});

describe("net labels", () => {
  it("keeps labels distinct even when their characters aren't legal in SPICE", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 300);
    doc.schematic.labels.push({ id: "1", x: 30, y: 0, net: "a b" }, { id: "2", x: 330, y: 300, net: "a_b" });
    const nets = buildNetlist(doc.schematic).pinNets;
    expect(nets.get(a.id)!.get("2")).not.toBe(nets.get(b.id)!.get("2"));
  });

  it("does not let label text add netlist lines", () => {
    const doc = new Doc();
    doc.addPart("resistor", 0, 0);
    doc.schematic.labels.push({ id: "1", x: 30, y: 0, net: "x\nV9 y 0 5" });
    expect(buildNetlist(doc.schematic).text).not.toMatch(/^V9/m);
  });

  it("does not let a stored value add netlist lines", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    r.spice = "{ref} {pin:1} {pin:2} {param:x}";
    r.kind = "imported";
    r.params.x = "1k\nV9 y 0 5";
    expect(buildNetlist(doc.schematic).text).not.toMatch(/^V9/m);
  });
});

describe("deleting", () => {
  it("removes the wires that end on a part's pins", () => {
    const { doc, r1 } = series();
    const wires = doc.schematic.wires.length;
    doc.removeComponentAndWires(r1.id);
    expect(doc.schematic.wires.length).toBe(wires - 2);
  });

  it("joins named nets correctly when routing falls back, keeping ground", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    a.pins[0].net = "0";
    b.pins[0].net = "sig";
    const c = doc.addPart("resistor", 600, 0);
    c.pins[0].net = "sig";
    doc.clearRoute = () => undefined;
    doc.connectPins(a, "1", b, "1");
    const nets = buildNetlist(doc.schematic).pinNets;
    expect(nets.get(a.id)!.get("1")).toBe("0");
    expect(nets.get(b.id)!.get("1")).toBe("0");
    expect(nets.get(c.id)!.get("1")).toBe("0");
  });
});

describe("circuit files", () => {
  it("round-trips a circuit with its analyses", () => {
    const { doc } = series();
    const text = serializeCircuit({ schematic: doc.schematic, analyses: [{ type: "op" }], issues: [{ severity: "info", message: "m" }] });
    const file = parseCircuit(text);
    expect(file.schematic).toEqual(JSON.parse(JSON.stringify(doc.schematic)));
    expect(file.analyses).toEqual([{ type: "op" }]);
    expect(file.issues).toHaveLength(1);
  });

  it.each([
    ["{}"], ["[1,2,3]"], ["null"], ["not json"], [`{"name":"x"}`],
    [`{"name":"x","definitions":"","components":[{}],"wires":[],"labels":[],"texts":[]}`],
    [`{"name":"x","definitions":"","components":[],"wires":[{"id":"w","points":[{"x":"a","y":1}]}],"labels":[],"texts":[]}`],
    [`{"format":"ohmlet","version":99,"schematic":{}}`],
  ])("rejects %s", (text) => {
    expect(() => parseCircuit(text)).toThrow();
  });
});

describe("sweeps", () => {
  const fake = (seen: string[]) => async (netlist: string) => {
    seen.push(netlist);
    return { analysis: "op" as const, vectors: [], warnings: [], stats: { unknowns: 0, iterations: 0, steps: 0, elapsedMs: 0 } };
  };

  it("rejects a parameter the part doesn't have", async () => {
    const { doc } = series();
    await expect(parameterSweep(doc.schematic, "R1", "nope", 1, 2, 2, { type: "op" }, fake([]))).rejects.toThrow(/no parameter "nope"/);
  });

  it("rejects a bad run count and a circuit with nothing to vary", async () => {
    const { doc } = series();
    await expect(monteCarlo(doc.schematic, NaN, 5, { type: "op" }, fake([]))).rejects.toThrow(/at least one run/);
    const empty = new Doc();
    empty.addPart("vdc", 0, 0);
    await expect(monteCarlo(empty.schematic, 2, 5, { type: "op" }, fake([]))).rejects.toThrow(/none it can change/);
  });

  it("varies imported parts through valueKey", async () => {
    const doc = new Doc();
    doc.schematic.components.push({
      id: "x", refDes: "R7", kind: "imported", x: 0, y: 0, rotation: 0, mirrored: false, params: { p1: "1000" },
      pins: [{ name: "1", x: -30, y: 0, net: "a" }, { name: "2", x: 30, y: 0, net: "0" }], spice: "r{ref} {pin:1} {pin:2} {param:p1}",
      valueKey: "p1", family: "resistor",
    });
    const seen: string[] = [];
    await parameterSweep(doc.schematic, "R7", "value", 1000, 3000, 2, { type: "op" }, fake(seen));
    expect(seen[1]).toContain("3000");
    const mc: string[] = [];
    await monteCarlo(doc.schematic, 1, 10, { type: "op" }, fake(mc), () => 1);
    expect(mc[0]).toContain("1100");
  });
});

describe("assistant tools", () => {
  const run = async (netlist: string, request: any) => simulate(netlist, request);
  let doc: Doc;
  beforeEach(() => { doc = series().doc; });

  it("checks every field against the schema", () => {
    const spec = (name: string) => TOOL_SPECS.find((t) => t.name === name)!;
    expect(validateToolInput(spec("add_component"), { kind: "resistor", x: 0, y: "abc" })).toContain("y must be a number");
    expect(validateToolInput(spec("add_component"), { kind: "resistor", x: 0, y: 0, rotation: 45 })).toContain("rotation");
    expect(validateToolInput(spec("add_component"), { kind: "resistor", x: 0, y: 0, extra: 1 })).toContain("Unknown input");
    expect(validateToolInput(spec("add_component"), { kind: "resistor", x: 0, y: 0, params: { value: 5 } })).toContain("params");
    expect(validateToolInput(spec("add_component"), "text")).toContain("object");
    expect(validateToolInput(spec("add_component"), { kind: "resistor", x: 0, y: 0, params: { value: "1k" } })).toBeUndefined();
  });

  it("rejects unknown parameters and bad values, and clears stale labels", async () => {
    await expect(runTool(doc, "set_parameter", { ref: "R1", param: "nope", value: "1" }, run)).rejects.toThrow(/no parameter/);
    await expect(runTool(doc, "set_parameter", { ref: "R1", param: "value", value: "abc" }, run)).rejects.toThrow(/not a valid/);
    const r1 = doc.findByRef("R1")!;
    r1.displayValue = "old";
    await runTool(doc, "set_parameter", { ref: "R1", param: "value", value: "2k" }, run);
    expect(r1.params.value).toBe("2k");
    expect(r1.displayValue).toBeUndefined();
  });

  it("removes a part's wires with it", async () => {
    const before = doc.schematic.wires.length;
    await runTool(doc, "remove_component", { ref: "R1" }, run);
    expect(doc.schematic.wires.length).toBe(before - 2);
  });

  it("moves and rotates without changing connections", async () => {
    const before = connectivitySignature(doc.schematic);
    await runTool(doc, "rotate_component", { ref: "R1", rotation: 90 }, run);
    await runTool(doc, "move_component", { ref: "R2", x: 150, y: -90 }, run);
    expect(connectivitySignature(doc.schematic)).toBe(before);
  });

  it("connects distant parts by net name", async () => {
    const a = doc.addPart("resistor", 800, 800);
    await runTool(doc, "name_net", { ref: a.refDes, pin: "1", net: "SIG" }, run);
    await runTool(doc, "name_net", { ref: "R1", pin: "2", net: "SIG" }, run);
    const nets = buildNetlist(doc.schematic).pinNets;
    expect(nets.get(a.id)!.get("1")).toBe(nets.get(doc.findByRef("R1")!.id)!.get("2"));
  });

  it("refuses to simulate invalid values", async () => {
    doc.findByRef("R1")!.params.value = "bad";
    await expect(runTool(doc, "run_analysis", { type: "op" }, run)).rejects.toThrow(/not a valid/);
  });

  it("lists mutating tools correctly", () => {
    for (const t of ["add_component", "connect", "set_parameter", "remove_component", "move_component", "rotate_component", "name_net"]) {
      expect(MUTATING_TOOLS.has(t)).toBe(true);
    }
    for (const t of ["list_parts", "get_circuit", "run_analysis"]) expect(MUTATING_TOOLS.has(t)).toBe(false);
  });
});
