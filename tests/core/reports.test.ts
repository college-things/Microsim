import { describe, expect, it } from "vitest";
import { Doc } from "../../src/core/doc";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { buildNetlist, pinWorld } from "../../src/core/netlist";
import { billOfMaterials, bomToCsv, bomToHtml, electricalRulesCheck, kicadNetlist } from "../../src/core/reports";

describe("bill of materials", () => {
  it("groups kind, value and model, sorts references naturally and leaves the schematic alone", () => {
    const doc = new Doc();
    for (const ref of ["R10", "R2", "R1"]) doc.addPart("resistor", 0, 0).refDes = ref;
    doc.addPart("resistor", 0, 100, { value: "2k" });
    doc.addPart("capacitor", 0, 200, { value: "1k" });
    doc.addPart("subcircuit", 0, 300, { model: "FIRST" }).displayValue = "same";
    doc.addPart("subcircuit", 0, 400, { model: "SECOND" }).displayValue = "same";
    const before = structuredClone(doc.schematic);
    const rows = billOfMaterials(doc.schematic);
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.quantity === 3)).toMatchObject({ references: ["R1", "R2", "R10"], description: "Resistor", value: "1k", footprint: "" });
    expect(doc.schematic).toEqual(before);
  });

  it("excludes instruments, ground and annotation in the original examples", () => {
    const schematic = buildExample(EXAMPLES[0]);
    schematic.texts.push({ id: "note", x: 0, y: 0, text: "Not a part" });
    schematic.components.push({ ...structuredClone(schematic.components[0]), id: "annotation", kind: "annotation", pins: [], spice: "" });
    expect(billOfMaterials(schematic).map((r) => r.kind).sort()).toEqual(["capacitor", "resistor", "vsin"]);
  });

  it("retains known footprints and separates different packages", () => {
    const doc = new Doc();
    doc.addPart("resistor", 0, 0, { footprint: "Resistor_SMD:R_0603" });
    doc.addPart("resistor", 0, 100, { footprint: "Resistor_SMD:R_0805" });
    expect(billOfMaterials(doc.schematic).map((r) => r.footprint)).toEqual(["Resistor_SMD:R_0603", "Resistor_SMD:R_0805"]);
  });

  it("quotes commas, quotes and line breaks in RFC 4180 CSV and escapes HTML", () => {
    const doc = new Doc();
    doc.addPart("resistor", 0, 0, { value: 'a,"b"\r\n<script>&' });
    const rows = billOfMaterials(doc.schematic);
    expect(bomToCsv(rows)).toBe('Quantity,References,Description,Value,Footprint\r\n1,R1,Resistor,"a,""b""\r\n<script>&",\r\n');
    expect(bomToHtml(rows)).toContain('<th scope="col">Quantity</th>');
    expect(bomToHtml(rows)).toContain('&lt;script&gt;&amp;');
    expect(bomToHtml(rows)).not.toContain("<script>");
    expect(bomToHtml([])).toContain("<tbody>");
  });
});

describe("electrical rules check", () => {
  it("reports unconnected required pins once, including instruments, and respects optional pins", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    r.pins[1].optional = true;
    const serial = doc.addPart("serial-terminal", 300, 100);
    const scope = doc.addPart("oscilloscope", 500, 100);
    const open = electricalRulesCheck(doc.schematic).filter((f) => f.message.includes("not connected"));
    expect(open.filter((f) => f.componentIds.includes(r.id))).toHaveLength(1);
    expect(open.filter((f) => f.componentIds.includes(scope.id))).toHaveLength(3);
    expect(open.some((f) => f.componentIds.includes(serial.id))).toBe(false);
  });

  it("reports a net with only one pin even when it has a dangling wire", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    const p = pinWorld(r, r.pins[0]);
    doc.addWire([p, { x: p.x - 100, y: p.y }]);
    expect(electricalRulesCheck(doc.schematic).find((f) => f.message.includes("only one connection"))).toMatchObject({ severity: "warning", componentIds: [r.id], nets: [buildNetlist(doc.schematic).pinNets.get(r.id)!.get("1")] });
  });

  it("reports multiple digital output pins on the same net, including outputs on one part", () => {
    const doc = new Doc();
    const a = doc.addPart("and", 0, 0);
    const b = doc.addPart("not", 300, 0);
    a.pins.find((p) => p.name === "y")!.net = "bus";
    b.pins.find((p) => p.name === "y")!.net = "bus";
    expect(electricalRulesCheck(doc.schematic).find((f) => f.message.includes("digital output"))).toMatchObject({ severity: "error", componentIds: [a.id, b.id], nets: ["bus"] });
    b.pins.find((p) => p.name === "y")!.net = "other";
    expect(electricalRulesCheck(doc.schematic).some((f) => f.message.includes("digital output"))).toBe(false);
    const ff = doc.addPart("dff", 600, 0);
    ff.pins.filter((p) => p.name.startsWith("Q")).forEach((p) => p.net = "joined");
    expect(electricalRulesCheck(doc.schematic).find((f) => f.nets.includes("joined") && f.severity === "error")?.componentIds).toEqual([ff.id]);
  });

  it("reports missing ground once and accepts ground from labels or an imported deck", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    expect(electricalRulesCheck(doc.schematic).filter((f) => f.message.includes("no ground"))).toHaveLength(1);
    r.pins[0].net = "gnd";
    expect(electricalRulesCheck(doc.schematic).some((f) => f.message.includes("no ground"))).toBe(false);
    r.pins = [];
    r.spice = "R1 out 0 1k";
    expect(electricalRulesCheck(doc.schematic).some((f) => f.message.includes("no ground"))).toBe(false);
  });

  it.each(["vdc", "vsin", "vpulse", "function-generator", "clock"])("reports a shorted %s voltage source", (kind) => {
    const doc = new Doc();
    const v = doc.addPart(kind, 0, 0);
    v.pins.forEach((p) => p.net = "0");
    expect(electricalRulesCheck(doc.schematic).find((f) => f.message.includes("voltage source terminals"))).toMatchObject({ severity: "error", componentIds: [v.id], nets: ["0"] });
    v.pins[0].net = "out";
    expect(electricalRulesCheck(doc.schematic).some((f) => f.message.includes("voltage source terminals"))).toBe(false);
  });

  it("does not mistake current sources or resistors for voltage sources", () => {
    const doc = new Doc();
    for (const kind of ["idc", "resistor"]) doc.addPart(kind, 0, 100).pins.forEach((p) => p.net = "0");
    expect(electricalRulesCheck(doc.schematic).some((f) => f.message.includes("voltage source terminals"))).toBe(false);
  });

  it("reports duplicate references with all part IDs, ignoring case", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    b.refDes = "r1";
    const duplicates = electricalRulesCheck(doc.schematic).filter((f) => f.message.includes("parts are named"));
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ severity: "error", componentIds: [a.id, b.id] });
  });

  it("reuses netlist validation messages with their severity and involved part", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0, { value: "oops" });
    doc.addPart("capacitor", 300, 0, { value: "-1" });
    const netlist = buildNetlist(doc.schematic);
    const findings = electricalRulesCheck(doc.schematic);
    for (const message of netlist.errors) expect(findings.filter((f) => f.message === message)).toHaveLength(1);
    expect(findings.find((f) => f.message === netlist.errors[0])).toMatchObject({ severity: "error", componentIds: [r.id] });
  });

  it("accepts the connected RC example without findings", () => {
    expect(electricalRulesCheck(buildExample(EXAMPLES[0]))).toEqual([]);
  });
});

// A small reader checks the exported tree rather than only matching substrings.
type Expr = string | Expr[];
function parseSexpr(text: string): Expr[] {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g)!;
  let index = 0;
  const read = (): Expr => {
    const token = tokens[index++];
    if (token !== "(") return token.startsWith('"') ? JSON.parse(token) : token;
    const list: Expr[] = [];
    while (tokens[index] !== ")") {
      if (index >= tokens.length) throw new Error("Unclosed expression");
      list.push(read());
    }
    index++;
    return list;
  };
  const tree = read() as Expr[];
  expect(index).toBe(tokens.length);
  return tree;
}

describe("KiCad netlist", () => {
  it.each(EXAMPLES.map((example) => [example.name, example] as const))("exports components and connected pins from %s", (_, example) => {
    const schematic = buildExample(example);
    const tree = parseSexpr(kicadNetlist(schematic));
    expect(tree[0]).toBe("export");
    const section = (name: string) => tree.find((e) => Array.isArray(e) && e[0] === name) as Expr[];
    expect(section("version")).toEqual(["version", "E"]);
    const components = section("components").slice(1) as Expr[][];
    const refs = components.map((c) => (c[1] as Expr[])[1]);
    const included = schematic.components.filter((c) => c.kind !== "ground" && !c.instrument && c.pins.length);
    expect(refs).toHaveLength(included.length);
    const pinNets = buildNetlist(schematic).pinNets;
    const codes = new Set<string>();
    let count = 0;
    for (const net of section("nets").slice(1) as Expr[][]) {
      expect(net[0]).toBe("net");
      const code = (net[1] as string[])[1];
      expect(codes.has(code)).toBe(false);
      codes.add(code);
      const name = (net[2] as string[])[1];
      for (const node of net.slice(3) as Expr[][]) {
        const ref = (node[1] as string[])[1], pin = (node[2] as string[])[1];
        expect(refs).toContain(ref);
        expect(pinNets.get(included.find((c) => c.refDes === ref)!.id)?.get(pin)).toBe(name);
        count++;
      }
    }
    expect(count).toBe(included.reduce((sum, c) => sum + (pinNets.get(c.id)?.size ?? 0), 0));
  });

  it("escapes quoted atoms and omits unconnected pins", () => {
    const doc = new Doc();
    doc.schematic.name = 'Circuit "A"\\B\nC';
    const r = doc.addPart("resistor", 0, 0, { footprint: 'Custom:"small"' });
    r.refDes = 'R"1';
    const output = kicadNetlist(doc.schematic);
    const tree = parseSexpr(output);
    expect(JSON.stringify(tree)).toContain(JSON.stringify(doc.schematic.name).slice(1, -1));
    expect(output).toContain('(footprint "Custom:\\"small\\"")');
    expect(output).not.toContain("(node");
    expect(parseSexpr(kicadNetlist(new Doc().schematic))[0]).toBe("export");
  });
});
