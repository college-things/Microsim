import { describe, expect, it } from "vitest";
import { evaluate, minimize, truthTable } from "../../src/core/logic";
import { simulate } from "../../src/engine";
import { Doc } from "../../src/core/doc";
import { buildNetlist } from "../../src/core/netlist";

describe("minimizing to a sum of products", () => {
  it("gives the textbook forms", () => {
    expect(minimize(["A", "B"], [0, 1, 1, 0])).toBe("A'B + AB'");
    expect(minimize(["A", "B"], [0, 0, 0, 1])).toBe("AB");
    expect(minimize(["A", "B", "C"], [0, 0, 0, 1, 0, 1, 1, 1])).toBe("AB + AC + BC");
    expect(minimize(["A", "B"], [0, 0, 0, 0])).toBe("0");
    expect(minimize(["A", "B"], [1, 1, 1, 1])).toBe("1");
    expect(minimize(["A", "B", "C"], [1, 1, 1, 1, 0, 0, 0, 0])).toBe("A'");
  });
  it("uses undecided rows as don't-cares", () => {
    expect(minimize(["A", "B"], [0, 1, undefined, 1])).toBe("B");
  });
  it("reproduces every row of 500 random tables of up to 6 inputs", () => {
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let t = 0; t < 500; t++) {
      const n = 1 + (t % 6);
      const names = "ABCDEFGH".slice(0, n).split("");
      const table = Array.from({ length: 1 << n }, () => (random() < 0.5 ? 1 : 0) as 0 | 1);
      const expression = minimize(names, table);
      table.forEach((v, row) => expect(evaluate(expression, names, row), `${table.join("")} -> ${expression}`).toBe(v));
    }
  });
});

describe("reading a circuit's truth table", () => {
  it("finds a NAND gate's table and expression", async () => {
    const doc = new Doc();
    const gate = doc.addPart("nand", 0, 0);
    const load = doc.addPart("resistor", 120, 0, { value: "10k" });
    const gnd = doc.addPart("ground", 120, 120);
    doc.connectPins(gate, "y", load, "1");
    doc.connectPins(load, "2", gnd, "g");
    // The converter's own wires give the inputs nets; here, light pull-downs do.
    const pins = gate.pins.map((p) => p.name).filter((p) => p !== "y");
    pins.forEach((pin, i) => {
      const pull = doc.addPart("resistor", -120, i * 60, { value: "100k" });
      doc.connectPins(gate, pin, pull, "1");
      doc.connectPins(pull, "2", gnd, "g");
    });
    const netlist = buildNetlist(doc.schematic);
    const nets = netlist.pinNets.get(gate.id)!;
    const run = async (text: string, request: Parameters<typeof simulate>[1]) => simulate(text, request);
    const table = await truthTable(netlist.text, pins.map((p, i) => ({ name: "AB"[i], net: nets.get(p)! })), nets.get("y")!, run);
    expect(table.outputs).toEqual([1, 1, 1, 0]);
    expect(minimize(table.inputs, table.outputs)).toBe("A' + B'");
  });
});

import { EXAMPLES, buildExample } from "../../src/core/examples";

describe("the majority example", () => {
  it("reads back AB + AC + BC through the converter's own pins", async () => {
    const schematic = buildExample(EXAMPLES.find((e) => e.name === "Logic converter majority")!);
    const netlist = buildNetlist(schematic);
    expect(netlist.errors).toEqual([]);
    const converter = schematic.components.find((c) => c.instrument === "logic-converter")!;
    const nets = netlist.pinNets.get(converter.id)!;
    const inputs = "ABC".split("").map((name) => ({ name, net: nets.get(name)! }));
    const table = await truthTable(netlist.text, inputs, nets.get("OUT")!, async (text, request) => simulate(text, request));
    expect(minimize(table.inputs, table.outputs)).toBe("AB + AC + BC");
  });
});
