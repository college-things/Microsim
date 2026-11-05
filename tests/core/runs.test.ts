// A result belongs to the connections it was run with: what an instrument watches counts, unwired
// pins stay apart, and a plot draws signals rather than the solver's floor.
import { describe, expect, it } from "vitest";
import { acDecibels, acSignals, findVector } from "../../src/core/analyses";
import { Doc, PartMove } from "../../src/core/doc";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { buildNetlist, frequencyProblem, pinNetsKey, runSignature } from "../../src/core/netlist";
import { simulate } from "../../src/engine/index";

const signature = (doc: Doc) => runSignature(buildNetlist(doc.schematic));

function amplifier(): Doc {
  const doc = new Doc();
  doc.replace(buildExample(EXAMPLES.find((e) => e.name === "Common-emitter amplifier")!));
  return doc;
}
const part = (doc: Doc, refDes: string) => doc.schematic.components.find((c) => c.refDes === refDes)!;

describe("what a run depends on", () => {
  it("counts rewiring a scope, though the netlist text stays the same", () => {
    const doc = amplifier();
    const before = signature(doc);
    const text = buildNetlist(doc.schematic).text;
    const scope = part(doc, "XSC1");
    const lead = doc.schematic.wires.find((w) => w.points.some((p) => p.x === scope.x - 15 && p.y === scope.y + 30))!;
    doc.schematic.wires = doc.schematic.wires.filter((w) => w !== lead);
    doc.notify();
    expect(buildNetlist(doc.schematic).text).toBe(text);
    expect(signature(doc)).not.toBe(before);
  });

  it.each([
    ["oscilloscope", "A"], ["logic-analyzer", "1"], ["bode-plotter", "out+"], ["multimeter", "p"],
  ])("counts moving a %s lead to another net", (kind, pin) => {
    const doc = amplifier();
    const { id } = doc.addPart(kind, 500, 300);
    const wire = (to: string) => {
      doc.checkpoint();
      doc.connectPins(doc.schematic.components.find((c) => c.id === id)!, pin, part(doc, "Q1"), to);
      return buildNetlist(doc.schematic);
    };
    const collector = wire("C");
    doc.undo();
    const emitter = wire("E");
    expect(emitter.text).toBe(collector.text);
    expect(runSignature(emitter)).not.toBe(runSignature(collector));
  });

  it("goes back to the same signature when an undo restores a lead", () => {
    const doc = amplifier();
    const meter = doc.addPart("multimeter", 500, 300);
    doc.connectPins(meter, "p", part(doc, "Q1"), "E");
    const wired = signature(doc);
    doc.checkpoint();
    doc.schematic.wires.pop();
    doc.notify();
    expect(signature(doc)).not.toBe(wired);
    doc.undo();
    expect(signature(doc)).toBe(wired);
  });

  it("doesn't count moving a part or an instrument, wires and all", () => {
    const doc = amplifier();
    const before = signature(doc);
    for (const comp of [part(doc, "R2"), part(doc, "XSC1")]) {
      const move = new PartMove(doc, [comp]);
      move.shift(40, 60);
      expect(move.settle()).toBe(true);
    }
    expect(signature(doc)).toBe(before);
  });

  it("doesn't count renaming an instrument or changing how it's displayed", () => {
    const doc = amplifier();
    const before = signature(doc);
    const scope = part(doc, "XSC1");
    scope.refDes = "XSC9";
    Object.assign(scope.params, { timePerDiv: "0.001", voltsPerDivA: "2", triggerLevel: "5.5" });
    expect(signature(doc)).toBe(before);
  });

  it("keeps a setting from touching which nets pins are on", () => {
    const doc = amplifier();
    const nets = pinNetsKey(buildNetlist(doc.schematic).pinNets);
    part(doc, "R3").params.value = "3.3k";
    expect(pinNetsKey(buildNetlist(doc.schematic).pinNets)).toBe(nets);
    expect(buildNetlist(doc.schematic).text).toContain("3300");
  });

  it("leaves it alone when an unwired instrument is placed", () => {
    const doc = amplifier();
    const before = signature(doc);
    doc.addPart("oscilloscope", 500, 300);
    expect(signature(doc)).toBe(before);
  });
});

describe("unconnected pins", () => {
  const blank = () => {
    const doc = new Doc();
    doc.replace({ name: "t", components: [], wires: [], labels: [], texts: [], definitions: "" });
    return doc;
  };

  it("keeps a wattmeter's current pins apart, so an unwired one can run", () => {
    const doc = blank();
    const ground = doc.addPart("ground", 0, 200);
    const source = doc.addPart("vdc", 0, 0);
    const load = doc.addPart("resistor", 100, 0);
    doc.connectPins(source, "n", ground, "g");
    doc.connectPins(load, "2", ground, "g");
    doc.connectPins(source, "p", load, "1");
    const meter = doc.addPart("wattmeter", 300, 0);
    const { text } = buildNetlist(doc.schematic);
    const [, plus, minus] = text.split("\n").find((line) => line.startsWith(`V${meter.refDes} `))!.split(" ");
    expect(plus).not.toBe(minus);
    const result = simulate(text, { type: "op" });
    expect(findVector(result, `v(${buildNetlist(doc.schematic).pinNets.get(load.id)!.get("1")})`)!.re[0]).toBeCloseTo(12, 6);
  });

  it("doesn't tie an unwired op-amp's inputs together", () => {
    const doc = blank();
    const amp = doc.addPart("opamp", 0, 0);
    const line = buildNetlist(doc.schematic).text.split("\n").find((l) => l.startsWith(`X${amp.refDes}`))!;
    const [, plus, minus] = line.split(" ");
    expect(plus).toMatch(/^nc_/);
    expect(plus).not.toBe(minus);
  });

  it("uses one name for one pin, however often a part's SPICE mentions it", () => {
    const doc = blank();
    const pot = doc.addPart("potentiometer", 0, 0);
    const { text } = buildNetlist(doc.schematic);
    const wiper = `nc_${pot.refDes}_w`;
    expect(text.split(wiper).length - 1).toBe(2);
  });

  it("keeps names apart across parts, and clear of named nets", () => {
    const doc = blank();
    const a = doc.addPart("resistor", 0, 0);
    a.refDes = "R1";
    const b = doc.addPart("resistor", 200, 0);
    b.refDes = "R1_1";
    // Named to collide with R1 pin 1's natural name, and the pin that wears it stays apart.
    b.pins[0].name = "x";
    doc.schematic.labels.push({ id: "l", net: "nc_R1_1", x: 900, y: 900 });
    const other = doc.addPart("resistor", 900, 870);
    other.pins[0].net = "nc_R1_1";
    const { text } = buildNetlist(doc.schematic);
    const line = text.split("\n").find((l) => l.startsWith("R1 "))!;
    expect(line.split(" ")[1]).toBe("nc_R1_1_2");
  });
});

describe("AC plots", () => {
  const ac = () => {
    const doc = amplifier();
    return simulate(buildNetlist(doc.schematic).text, { type: "ac", sweep: "dec", points: 10, fstart: 10, fstop: 1e6 });
  };

  it("doesn't count a supply rail as a signal", () => {
    const result = ac();
    const signals = acSignals(result);
    expect(signals.has("v(n1)")).toBe(false);
    expect(signals.has("v(n4)")).toBe(true);
    expect(signals.has("v(n2)")).toBe(true);
  });

  it("leaves no floor for an axis to reach down to", () => {
    const decibels = acDecibels(ac());
    expect([...decibels.get("v(n1)")!].every(Number.isNaN)).toBe(true);
    const gain = decibels.get("v(n4)")!;
    expect(Math.max(...gain)).toBeGreaterThan(40);
    expect(gain.every((value) => value > -100)).toBe(true);
  });

  it("finds no signal at all in a circuit with no AC source", () => {
    const result = simulate("t\nV1 1 0 DC 5\nR1 1 2 1k\nR2 2 0 1k\n.end\n", { type: "ac", sweep: "dec", points: 5, fstart: 1, fstop: 100 });
    expect(acSignals(result).size).toBe(0);
  });
});

describe("a part that repeats", () => {
  const generator = (kind: string, freq: string) => {
    const doc = new Doc();
    doc.replace({ name: "t", components: [], wires: [], labels: [], texts: [], definitions: "" });
    return { doc, part: doc.addPart(kind, 0, 0, { freq }) };
  };

  it.each(["function-generator", "clock"])("refuses a %s frequency of zero rather than running another", (kind) => {
    const { doc, part: comp } = generator(kind, "0");
    expect(frequencyProblem(comp)).toMatch(/greater than zero/);
    expect(buildNetlist(doc.schematic).errors.join()).toMatch(/Frequency must be/);
  });

  it("accepts a real frequency and gives an unreadable one a single message", () => {
    expect(buildNetlist(generator("function-generator", "1k").doc.schematic).errors).toEqual([]);
    expect(buildNetlist(generator("function-generator", "soon").doc.schematic).errors).toHaveLength(1);
    expect(buildNetlist(generator("function-generator", "-5").doc.schematic).errors).toHaveLength(1);
  });

  it("asks only instruments that repeat", () => {
    const { part: comp } = generator("vsin", "0");
    expect(frequencyProblem(comp)).toBeUndefined();
  });
});
