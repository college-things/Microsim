import { twoPageFixture } from "./hierarchy-fixture";
import { describe, expect, it } from "vitest";
import { Doc } from "../../src/core/doc";
import { parseCircuit, serializeCircuit } from "../../src/core/file";
import { flattenCircuit } from "../../src/core/hierarchy";
import { buildNetlist, pinWorld } from "../../src/core/netlist";
import { circuitPages, emptySchematic } from "../../src/core/schematic";
import { billOfMaterials, kicadNetlist } from "../../src/core/reports";
import { schematicToSvg } from "../../src/core/export";
import { jpegPagesToPdf, renderPrintPages } from "../../src/core/print";
import { runTool } from "../../src/agent/tools";
import { ms14Xml, serializeMs14 } from "../../src/importer/writer";
import { importMs14 } from "../../src/importer";
import { simulate } from "../../src/engine";
import { op } from "../engine/helpers";

const saved = (doc: Doc) => serializeCircuit({ schematic: doc.schematic, analyses: [], issues: [] });
const gainCircuit = () => {
  const doc = new Doc();
  doc.replace(twoPageFixture());
  return doc;
};
function undoable(doc: Doc, change: () => void) {
  const before = saved(doc);
  change();
  const after = saved(doc);
  expect(after).not.toBe(before);
  doc.undo(); expect(saved(doc)).toBe(before);
  doc.redo(); expect(saved(doc)).toBe(after);
}

describe("pages", () => {
  it("round trips extra pages without changing the old page-one fields", () => {
    const doc = new Doc();
    const first = doc.addPart("resistor", 0, 0);
    doc.addPage("Power");
    const second = doc.addPart("resistor", 0, 0);
    expect(first.refDes).toBe("R1"); expect(second.refDes).toBe("R2");
    expect(doc.schematic.components).toEqual([first]);
    expect(doc.sheet.components).toEqual([second]);
    expect(parseCircuit(saved(doc)).schematic).toEqual(doc.schematic);
  });

  it("never joins geometry across sheets, but does join labels and label aliases", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    doc.addPage("Second");
    const b = doc.addPart("resistor", 0, 0);
    let nets = buildNetlist(doc.schematic).pinNets;
    expect(nets.get(a.id)?.get("1")).not.toBe(nets.get(b.id)?.get("1"));
    doc.schematic.labels.push({ id: "a", ...pinWorld(a, a.pins[0]), net: "SHARED" });
    doc.sheet.labels.push({ id: "b", ...pinWorld(b, b.pins[0]), net: "SHARED" });
    doc.sheet.labels.push({ id: "alias", ...pinWorld(b, b.pins[0]), net: "ALIAS" });
    nets = buildNetlist(doc.schematic).pinNets;
    expect(nets.get(a.id)?.get("1")).toBe(nets.get(b.id)?.get("1"));
    const result = buildNetlist(doc.schematic);
    expect(result.namedNets.get("SHARED")).toBe(result.namedNets.get("ALIAS"));
  });

  it("undoes and redoes add, rename, reorder and delete, including page one", () => {
    const doc = new Doc();
    doc.schematic.definitions = ".model example D";
    doc.addPart("resistor", 0, 0);
    undoable(doc, () => doc.addPage("Second"));
    undoable(doc, () => doc.renamePage(1, "Supply"));
    undoable(doc, () => doc.movePage(1, 0));
    expect(doc.schematic.name).toBe("Supply");
    expect(doc.schematic.definitions).toBe(".model example D");
    undoable(doc, () => doc.deletePage(0));
    expect(doc.schematic.components[0].refDes).toBe("R1");
    expect(() => doc.deletePage(0)).toThrow(/at least one/);
  });

  it("copies and pastes only the active page and numbers across every page", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    doc.addPage("Second");
    const b = doc.addPart("resistor", 0, 0);
    doc.checkpoint();
    doc.paste({ components: [b], wires: [] }, 200, 0);
    expect(doc.sheet.components.map((c) => c.refDes)).toEqual(["R2", "R3"]);
    expect(doc.schematic.components).toEqual([a]);
    doc.undo(); expect(doc.sheet.components.length).toBe(1);
    doc.redo(); expect(doc.sheet.components.length).toBe(2);
  });

  it("reserves automatic link names across all pages", () => {
    const doc = new Doc();
    doc.schematic.labels.push({ id: "reserved", x: 700, y: 700, net: "LINK1" });
    doc.addPage("Second");
    const a = doc.addPart("resistor", 0, 0), b = doc.addPart("resistor", 200, 0);
    doc.clearRoute = () => undefined;
    doc.connectPins(a, "1", b, "1");
    expect(doc.sheet.labels.map((l) => l.net)).toEqual(["LINK2", "LINK2"]);
  });

  it("lets the assistant see every page and explicitly switch its editing page", async () => {
    const doc = gainCircuit();
    const noSim = async () => { throw new Error("Unexpected simulation"); };
    const summary = await runTool(doc, "get_circuit", {}, noSim) as any;
    expect(summary.pages).toHaveLength(2);
    expect(summary.components.some((c: any) => c.ref === "X2.E1")).toBe(true);
    await runTool(doc, "open_page", { page: 2 }, noSim);
    await runTool(doc, "add_component", { kind: "resistor", x: 400, y: 0 }, noSim);
    expect(doc.sheet.components.at(-1)?.kind).toBe("resistor");
    expect(doc.schematic.components.some((c) => c.kind === "resistor")).toBe(false);
  });
});

describe("shared hierarchical blocks", () => {
  it("extracts a selected part and wires with one named port per boundary net", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 140, 0);
    const wire = doc.addWire([{ x: 30, y: 0 }, { x: 110, y: 0 }]);
    doc.schematic.labels.push({ id: "input", x: -30, y: 0, net: "INPUT" });
    let instanceId = "";
    undoable(doc, () => { instanceId = doc.createBlock(new Set([a.id, wire.id]), "Series resistor", { INPUT: "in" }).id; });
    const definition = doc.schematic.blocks![0];
    expect(definition.wires).toHaveLength(1);
    expect(definition.components.filter((c) => c.kind === "hierarchy-port").map((c) => c.params.name)).toContain("in");
    expect(doc.schematic.components.some((c) => c.id === a.id)).toBe(false);
    const result = buildNetlist(doc.schematic);
    expect(result.errors).toEqual([]);
    expect(result.pinNets.get(`${instanceId}/${a.id}`)?.get("2")).toBe(result.pinNets.get(b.id)?.get("1"));
    expect(result.pinNets.get(instanceId)?.get("in")).toBe(result.pinNets.get(`${instanceId}/${a.id}`)?.get("1"));
    expect(parseCircuit(saved(doc)).schematic).toEqual(doc.schematic);
  });

  it("finds a boundary where an unselected wire passes through a selected pin", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    doc.addWire([{ x: 30, y: -60 }, { x: 30, y: 60 }]);
    const c = doc.createBlock(new Set([r.id]), "T junction");
    expect(c.pins).toHaveLength(1);
  });

  it("flattens two shared instances with separate internal ids, references and nets", () => {
    const doc = gainCircuit();
    const flat = flattenCircuit(doc.schematic);
    expect(flat.components.map((c) => c.refDes)).toContain("X1.E1");
    expect(flat.components.map((c) => c.refDes)).toContain("X2.E1");
    const netlist = buildNetlist(doc.schematic);
    expect(netlist.errors).toEqual([]);
    expect(op(simulate(netlist.text, { type: "op" }), "v(output)")).toBeCloseTo(4, 8);
    const equivalent = simulate("Flat gain stages\nV1 INPUT 0 1\nE1 BETWEEN 0 INPUT 0 2\nE2 OUTPUT 0 BETWEEN 0 2\n.end", { type: "op" });
    expect(op(simulate(netlist.text, { type: "op" }), "v(output)")).toBeCloseTo(op(equivalent, "v(output)"), 10);
  });

  it("flattens nested blocks two levels deep with correct connectivity", () => {
    const doc = gainCircuit();
    const original = doc.schematic.components.find((c) => c.blockId)!;
    undoable(doc, () => { doc.createBlock(new Set([original.id]), "Wrapped stage"); });
    const result = buildNetlist(doc.schematic);
    expect(result.errors).toEqual([]);
    expect(flattenCircuit(doc.schematic).components.some((c) => c.refDes.endsWith(".X1.E1"))).toBe(true);
    expect(op(simulate(result.text, { type: "op" }), "v(output)")).toBeCloseTo(4, 8);
    expect(parseCircuit(saved(doc)).schematic).toEqual(doc.schematic);
  });

  it("scopes internal labels separately for each instance", () => {
    const doc = gainCircuit();
    doc.openBlock("gain-stage");
    const a = doc.addPart("resistor", 200, 0);
    const b = doc.addPart("resistor", 300, 0);
    a.pins[0].net = "OUT"; a.pins[1].net = "mid";
    b.pins[0].net = "mid"; b.pins[1].net = "COM";
    const firstId = doc.schematic.components[0].id;
    const secondId = doc.schematic.pages![0].components[0].id;
    const result = buildNetlist(doc.schematic);
    expect(result.errors).toEqual([]);
    const firstMid = result.pinNets.get(`${firstId}/${a.id}`)?.get("2");
    const secondMid = result.pinNets.get(`${secondId}/${a.id}`)?.get("2");
    expect(firstMid).toBe("X1.mid");
    expect(secondMid).toBe("X2.mid");
    expect(op(simulate(result.text, { type: "op" }), "v(output)")).toBeCloseTo(4, 8);
  });

  it("joins externally bound ports that share one internal net without shorting another pin", () => {
    const doc = gainCircuit();
    const block = doc.schematic.blocks![0];
    block.components = block.components.filter((c) => c.kind === "hierarchy-port");
    for (const p of block.components) p.pins[0].net = p.params.name === "COM" ? "0" : "short";
    const netlist = buildNetlist(doc.schematic);
    expect(netlist.errors).toEqual([]);
    expect(op(simulate(netlist.text, { type: "op" }), `v(${netlist.namedNets.get("OUTPUT")!.toLowerCase()})`)).toBeCloseTo(1, 8);
  });

  it("undoes placement and shared definition edits, port add/rename/remove and pin synchronization", () => {
    const doc = gainCircuit();
    undoable(doc, () => { doc.placeBlock("gain-stage", 500, 0); });
    doc.openBlock("gain-stage");
    undoable(doc, () => { doc.addBlockPort("extra", 300, 300); });
    const portId = doc.sheet.components.find((c) => c.params.name === "extra")!.id;
    undoable(doc, () => doc.renameBlockPort(portId, "test"));
    expect(circuitPages(doc.schematic).flatMap((p) => p.components).filter((c) => c.blockId).every((c) => c.pins.some((p) => p.name === "test"))).toBe(true);
    undoable(doc, () => { doc.checkpoint(); doc.removeComponentAndWires(portId); doc.notify(); });
    undoable(doc, () => { doc.checkpoint(); doc.sheet.components.find((c) => c.refDes === "E1")!.spice = "E{ref} {pin:out} {pin:return} {pin:in} {pin:return} 3"; doc.notify(); });
    doc.openPage(0);
    expect(op(simulate(buildNetlist(doc.schematic).text, { type: "op" }), "v(output)")).toBeCloseTo(9, 8);
  });

  it("rejects missing and recursive definitions, bad ports and instruments in blocks", () => {
    const doc = gainCircuit();
    doc.openBlock("gain-stage");
    expect(() => doc.placeBlock("gain-stage", 0, 0)).toThrow(/cannot contain itself/);
    expect(() => doc.addPart("oscilloscope", 0, 0)).toThrow(/outside blocks/);
    const bad = structuredClone(doc.schematic);
    bad.blocks = [];
    expect(() => parseCircuit(serializeCircuit({ schematic: bad, analyses: [], issues: [] }))).toThrow(/missing block/);
    const recursive = structuredClone(doc.schematic);
    recursive.blocks![0].components.push(structuredClone(recursive.components[0]));
    expect(() => parseCircuit(serializeCircuit({ schematic: recursive, analyses: [], issues: [] }))).toThrow(/recursive block/);
  });
});

describe("whole-circuit output", () => {
  it("includes every sheet and both instances in reports, SVG, printing and native export", () => {
    const doc = gainCircuit();
    const bom = billOfMaterials(doc.schematic);
    expect(bom.flatMap((r) => r.references)).toEqual(expect.arrayContaining(["X1.E1", "X2.E1"]));
    expect(bom.some((r) => r.kind.startsWith("hierarchy-"))).toBe(false);
    expect(kicadNetlist(doc.schematic)).toContain("X2.E1");
    expect(schematicToSvg(doc.schematic)).toContain("Second stage");
    const pages = renderPrintPages(doc.schematic);
    expect(pages).toHaveLength(3);
    expect(pages[1].svg).toContain("Sheet 2 of 3");
    expect(pages[2].svg).toContain("Gain stage");
    const bytes = jpegPagesToPdf(pages.map((page) => ({ page, jpeg: new Uint8Array([255, 216, 255, 217]), pixels: { width: 1, height: 1 } })));
    expect(new TextDecoder().decode(bytes)).toContain("/Count 3");
    const xml = ms14Xml({ schematic: doc.schematic, analyses: [], issues: [] });
    expect(xml).toContain("X2");
    expect(xml).toContain("Microsim");
    expect(importMs14(serializeMs14({ schematic: doc.schematic, analyses: [], issues: [] })).schematic).toEqual(doc.schematic);
  });

  it("rejects duplicate references and malformed page arrays on reopen", () => {
    const doc = new Doc();
    doc.addPart("resistor", 0, 0);
    doc.addPage("Second");
    doc.addPart("resistor", 0, 0).refDes = "R1";
    expect(() => parseCircuit(saved(doc))).toThrow(/duplicate reference/);
    const bad = { ...emptySchematic(), pages: [{ name: "Missing arrays" }] };
    expect(() => parseCircuit(JSON.stringify(bad))).toThrow(/valid circuit/);
  });
});

describe("the two-page example", () => {
  it("gives 1 V in, 2 V between the pages and 4 V out, through drawn wires", async () => {
    const { simulate } = await import("../../src/engine");
    const { buildNetlist } = await import("../../src/core/netlist");
    const { EXAMPLES, buildExample } = await import("../../src/core/examples");
    const schematic = buildExample(EXAMPLES.find((e) => e.name === "Two-page gain stages")!);
    const netlist = buildNetlist(schematic);
    expect(netlist.warnings).toEqual([]);
    const result = simulate(netlist.text, { type: "op" });
    const v = (name: string) => result.vectors.find((x) => x.name.toLowerCase() === `v(${name})`)?.re[0];
    expect(v("between")).toBeCloseTo(2, 3);
    expect(v("output")).toBeCloseTo(4, 3);
    // The block's own parts are joined by drawn wires, not only by hidden pin nets.
    expect(schematic.blocks![0].wires.length).toBeGreaterThan(2);
  });
});
