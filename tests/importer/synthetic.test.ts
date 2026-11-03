// End-to-end import of a small circuit written by hand: a source, a resistor and a ground,
// plus a hierarchical block. All names and values here are invented for the test.
import { describe, expect, it } from "vitest";
import { buildNetlist } from "../../src/core/netlist";
import { importMs14 } from "../../src/importer";
import { ascii, buildContainer, buildImplode, importBoth, netlistOf } from "./helpers";

function component(id: string, name: string, sym: string, template: string, params: string[], ports: string[], model?: string): string {
  const paramList = `<CiaParamList Class="CiaParamList"><doubles/><strings/><parameters>${params.map((v) => `<Item Value="&amp;ASC${v}"/>`).join("")}</parameters><paramindicators/></CiaParamList>`;
  const tmpl = `<CiaSpiceTmpltExprt Class="CiaSpiceTmpltExprt" String="&amp;ASC${template}"/>`;
  const names = `<CiaCollString Class="CiaCollString"><strings><Item Value="&amp;ASCF"/><Item Value="&amp;ASCP"/></strings></CiaCollString>`;
  const ident = `<CiaCollString Class="CiaCollString"><strings><Item Value=""/><Item Value=""/><Item Value=""/><Item Value=""/><Item Value="&amp;ASCR%d"/></strings></CiaCollString>`;
  return `<Item CiID="${id}" Class="CiComponent"><CiComponent Class="CiComponent" LocalName="&amp;ASC${name}" SymCompID="${sym}"${model ? ` Model="${model}"` : ""}>` +
    `<Attributes><Item/><Item>${tmpl}</Item><Item>${paramList}</Item><Item/><Item>${names}</Item><Item>${ident}</Item></Attributes>` +
    `<Ports>${ports.map((p) => `<Item CiID="${p}"/>`).join("")}</Ports></CiComponent></Item>`;
}

const port = (id: string, name: string, owner: string, node?: string) =>
  `<Item CiID="${id}" Class="CiPort"><CiPort Class="CiPort" LocalName="&amp;ASC${name}" Component="${owner}"><Nodes>${node ? `<Item CiID="${node}"/>` : "<Item/>"}</Nodes></CiPort></Item>`;
const node = (id: string, name: string) => `<Item CiID="${id}" Class="CiNode"><CiNode Class="CiNode" LocalName="&amp;ASC${name}"/></Item>`;

function pinSymbol(id: string, name: string, x: number, y: number): string {
  return `<Item ID="${id}" Class="CIITPinSymbolComp"><CIITPinSymbolComp Class="CIITPinSymbolComp" PinName="&amp;ASC${name}" ShowName="0" ShowNumber="0"><Objects>` +
    `<Item ID="${id}1" Class="CIITPinConnectorComp"><CIITPinConnectorComp Class="CIITPinConnectorComp" ptCenterX="${x}" ptCenterY="${y}"/></Item>` +
    `<Item ID="${id}2" Class="CODLineComp"><CODLineComp Class="CODLineComp" pt0X="${x}" pt0Y="${y}" pt1X="${x + 1}" pt1Y="${y}"/></Item>` +
    `</Objects></CIITPinSymbolComp></Item>`;
}

function symbol(id: string, owner: string, x: number, y: number, flip: number, pins: string, cls = "CIITSymbolComp", extra = "", name = NAMES[owner]): string {
  return `<Item ID="${id}" Class="${cls}"><${cls} Class="${cls}" CiComponent="${owner}" OrientationFlip="${flip}" NumSections="1" ` +
    `Transformer-M00="1." Transformer-M01="0." Transformer-M10="0." Transformer-M11="1." Transformer-M20="${x}." Transformer-M21="${y}.">` +
    `<Objects>${name ? `<Item ID="${id}8" Class="CIITSymTextCompName"><CIITSymTextCompName Class="CIITSymTextCompName" Output="&amp;ASC${name}"/></Item>` : ""}${pins}<Item ID="${id}9" Class="CODRectComp"><CODRectComp Class="CODRectComp" pt0X="0" pt0Y="0" pt1X="9" pt1Y="18" Brush-Style="1"/></Item></Objects>${extra}</${cls}></Item>`;
}

function wire(id: string, nodeId: string, points: [number, number][]): string {
  return `<Item ID="${id}" Class="CIITLinkComp"><CIITLinkComp Class="CIITLinkComp" Node="${nodeId}"><Points>${points.map(([x, y]) => `<Item X="${x}" Y="${y}"/>`).join("")}</Points></CIITLinkComp></Item>`;
}

function sheet(title: string, objects: string, elements: string, simState = ""): string {
  return `<SheetContainer Class="CSheetContainer"><Sheet><Variable><DesignSheet Class="CSCH_CAPSubSheet" Title="&amp;ASC${title}"><Sheet><XMLSubSheet><CIITHierDoc Class="CIITHierDoc"><Diagram>` +
    `<CIITDiagram Class="CIITDiagram"${simState ? ` SimState="&amp;ASC${simState}"` : ""}><Components><CODComposite Class="CODComposite"><Objects>${objects}</Objects></CODComposite></Components><Elements>${elements}</Elements></CIITDiagram>` +
    `</Diagram></CIITHierDoc></XMLSubSheet></Sheet></DesignSheet></Variable></Sheet></SheetContainer>`;
}

function file(sheets: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="ASCII"?>\n<MSMElectronicsWorkbench Schema="67"><Project Class="CProject" Name="&amp;ASCTest" AppName="&amp;ASCTool" AppVersion="&amp;ASC14.0.1"><UniqueSheets><SheetInfos>${sheets}</SheetInfos></UniqueSheets></Project></MSMElectronicsWorkbench>`;
  const bytes = ascii(xml);
  return buildContainer([{ size: bytes.length, data: buildImplode(bytes, false) }]);
}

const NAMES: Record<string, string> = { "1": "V1", "2": "R1", "4": "V1", "5": "X1", "6": "R1", "7": "R2" };

const R_TEMPLATE = "r%p %t1 %t2 #1 ";
const V_TEMPLATE = "v%p %t1 %t2 dc #1 ";

const flat = () =>
  sheet(
    "Main",
    symbol("100", "1", 90, 90, 0, pinSymbol("101", "1", 0, 0) + pinSymbol("102", "2", 0, 18)) +
      symbol("200", "2", 180, 90, 1, pinSymbol("201", "1", 0, 0) + pinSymbol("202", "2", 0, 18)) +
      wire("300", "21", [[90, 90], [180, 90]]) +
      wire("301", "20", [[90, 108], [180, 108]]),
    node("20", "0") + node("21", "out") +
      component("1", "V1", "100", V_TEMPLATE, ["0", "5"], ["11", "12"]) +
      component("2", "R1", "200", R_TEMPLATE, ["0", "1k"], ["13", "14"]) +
      port("11", "1", "1", "21") + port("12", "2", "1", "20") +
      port("13", "1", "2", "21") + port("14", "2", "2", "20"),
    "SIMULATION_INFO:list{ANALYSES:list{OP:list{}\n}\n}",
  );

describe("hand-written circuit", () => {
  it("imports components, nets, wires and analyses", () => {
    const result = importBoth(file(flat())).view;
    expect(result.format).toEqual({ schema: "67", application: "Tool", version: "14.0.1" });
    expect(result.analyses).toEqual([{ type: "op" }]);
    expect(result.schematic.name).toBe("Test");
    expect(result.schematic.wires).toHaveLength(2);
    expect(netlistOf(result.schematic)).toContain("rR1 out 0 1k");
    expect(netlistOf(result.schematic)).toContain("vV1 out 0 dc 5");
  });

  it("places rotated pins exactly where the wires land, and the real netlister agrees", () => {
    const { schematic } = importMs14(file(flat()));
    const r1 = schematic.components.find((c) => c.refDes === "R1")!;
    expect(r1.rotation).toBe(90);
    const text = buildNetlist(schematic);
    expect(text.pinNets.get(r1.id)?.get("1")).toBe("out");
    expect(text.pinNets.get(r1.id)?.get("2")).toBe("0");
  });

  it("reports a file with no components", () => {
    const result = importMs14(file(sheet("Empty", "", "")));
    expect(result.schematic.components).toEqual([]);
    expect(result.issues.some((i) => /no components/.test(i.message))).toBe(true);
  });

  it("flattens a block, joins its port, keeps sheets apart and names parts uniquely", () => {
    const blockSymbol = symbol("500", "5", 300, 90, 0, pinSymbol("501", "IN", 0, 0), "CIITMacroComponent",
      `<HierBlock><CHierBlock Class="CHierBlock" FileName="&amp;ASCInner" Subcircuit="1"/></HierBlock>`);
    const top = sheet(
      "Main",
      symbol("400", "4", 90, 90, 0, pinSymbol("401", "1", 0, 0) + pinSymbol("402", "2", 0, 18)) + blockSymbol + wire("450", "41", [[90, 90], [300, 90]]),
      node("40", "0") + node("41", "sig") +
        component("4", "V1", "400", V_TEMPLATE, ["0", "1"], ["42", "43"]) + port("42", "1", "4", "41") + port("43", "2", "4", "40") +
        `<Item CiID="5" Class="CiInstComponent"><CiInstComponent Class="CiInstComponent" LocalName="&amp;ASCX1" SymCompID="500"><Attributes/><Ports><Item CiID="44"/></Ports></CiInstComponent></Item>` +
        port("44", "IN", "5", "41"),
    );
    const inner = sheet(
      "Inner",
      symbol("600", "6", 90, 90, 0, pinSymbol("601", "1", 0, 0) + pinSymbol("602", "2", 0, 18)) +
        symbol("610", "7", 90, 90, 0, pinSymbol("611", "1", 0, 18)),
      node("60", "0") + node("61", "IN") + node("62", "5") +
        component("6", "R1", "600", R_TEMPLATE, ["0", "2k"], ["63", "64"]) + port("63", "1", "6", "61") + port("64", "2", "6", "62") +
        component("7", "R2", "610", "r%p %t1 0 #1 ", ["0", "3k"], ["65"]) + port("65", "1", "7", "62"),
    );
    const both = importBoth(file(top + inner));
    const { schematic, issues } = both.bound;
    const netlist = netlistOf(both.view.schematic);
    expect(netlist).toContain("rR1 sig 5_X1 2k");
    expect(netlist).toContain("rR2 5_X1 0 3k");
    expect(issues.some((i) => /flattened/.test(i.message))).toBe(true);
    const ids = schematic.components.map((c) => c.refDes.toLowerCase()).filter((r) => r);
    expect(new Set(ids).size).toBe(ids.length);
    // The inner sheet's pin at (90,90) would otherwise land on the main sheet's source pin.
    const nets = buildNetlist(schematic).pinNets;
    const v1 = schematic.components.find((c) => c.refDes === "V1")!;
    const r2 = schematic.components.find((c) => c.refDes === "R2")!;
    expect(nets.get(v1.id)?.get("2")).toBe("0");
    expect(nets.get(r2.id)?.get("1")).toBe("5_X1");
  });

  it("reports a block whose sheet is not in the file", () => {
    const top = sheet(
      "Main",
      symbol("500", "5", 300, 90, 0, pinSymbol("501", "IN", 0, 0), "CIITMacroComponent",
        `<HierBlock><CHierBlock Class="CHierBlock" FileName="&amp;ASCelsewhere.ms14" Subcircuit="0"/></HierBlock>`),
      node("41", "sig") +
        `<Item CiID="5" Class="CiInstComponent"><CiInstComponent Class="CiInstComponent" LocalName="&amp;ASCHB1" SymCompID="500"><Attributes/><Ports><Item CiID="44"/></Ports></CiInstComponent></Item>` +
        port("44", "IN", "5", "41"),
    );
    const { issues } = importMs14(file(top));
    expect(issues.some((i) => i.severity === "error" && /not in this file/.test(i.message))).toBe(true);
  });

  it("wires, not stored nets, carry the connection", () => {
    const { schematic } = importMs14(file(flat()));
    const r1 = schematic.components.find((c) => c.refDes === "R1")!;
    expect(r1.pins.every((p) => p.net === undefined)).toBe(true);
    const cut = { ...schematic, wires: schematic.wires.slice(1) };
    expect(buildNetlist(cut).pinNets.get(r1.id)?.get("1")).not.toBe("out");
  });

  it("marks plain parts so their value can be swept", () => {
    const { schematic } = importMs14(file(flat()));
    const r1 = schematic.components.find((c) => c.refDes === "R1")!;
    expect(r1.family).toBe("resistor");
    expect(r1.valueKey).toBe("p1");
    expect(r1.paramLabels).toEqual({ p1: "Resistance" });
    const changed = { ...r1, params: { ...r1.params, [r1.valueKey!]: "47k" } };
    expect(buildNetlist({ ...schematic, components: schematic.components.map((c) => (c === r1 ? changed : c)) }).text).toContain("47k");
    expect(buildNetlist(schematic).text).not.toContain("47k");
  });

  it("a hostile file cannot add netlist lines through values or names", () => {
    const evil = "1k&#10;VEVIL a 0 1";
    const newline = "1k\nVEVIL a 0 1";
    const hostile = sheet(
      "Main",
      symbol("100", "1", 90, 90, 0, pinSymbol("101", "1", 0, 0) + pinSymbol("102", "2", 0, 18)),
      node("20", "0") + node("21", "out") +
        component("1", "V1", "100", "v%p %t1 %t2 dc #1 B%p %m #2 ", ["0", newline, newline], ["11", "12"], "30") +
        port("11", "1", "1", "21") + port("12", "2", "1", "20") +
        `<Item CiID="30" Class="CiModel"><CiModel Class="CiModel" LocalName="&amp;ASCM\nVEVIL2 a 0 1"><Attributes><Item><CiaCString Class="CiaCString" String="&amp;ASC*x"/></Item></Attributes></CiModel></Item>`,
    ).replace(/^/, "");
    expect(evil).toContain("&#10;");
    const xml = hostile.replace('Title="&amp;ASCMain"', 'Title="&amp;ASCMain"');
    const result = importMs14(file(xml));
    const text = buildNetlist(result.schematic).text;
    expect(text.split("\n").filter((l) => /^\s*VEVIL/i.test(l))).toEqual([]);
    expect(result.schematic.components[0].params.p1).not.toMatch(/[\r\n]/);

    const named = file(flat()).length;
    expect(named).toBeGreaterThan(0);
  });

  it("a hostile project name stays one comment line", () => {
    const xml = `<?xml version="1.0"?><MSMElectronicsWorkbench Schema="67"><Project Class="CProject" Name="&amp;ASCT\nVEVIL a 0 1"><UniqueSheets><SheetInfos>${flat()}</SheetInfos></UniqueSheets></Project></MSMElectronicsWorkbench>`;
    const bytes = ascii(xml);
    const text = buildNetlist(importMs14(buildContainer([{ size: bytes.length, data: buildImplode(bytes, false) }])).schematic).text;
    expect(text.split("\n").filter((l) => /^\s*VEVIL/i.test(l))).toEqual([]);
  });

  it("a hidden name stays hidden, and a part simulates through its id", () => {
    const hidden = sheet(
      "Main",
      symbol("100", "1", 90, 90, 0, pinSymbol("101", "1", 0, 0) + pinSymbol("102", "2", 0, 18), "CIITSymbolComp", "", ""),
      node("20", "0") + node("21", "out") + component("1", "V1", "100", V_TEMPLATE, ["0", "5"], ["11", "12"]) +
        port("11", "1", "1", "21") + port("12", "2", "1", "20"),
    );
    const { view } = importBoth(file(hidden));
    expect(view.schematic.components[0].refDes).toBe("");
    expect(netlistOf(view.schematic)).toContain(`vP_${view.schematic.components[0].id} out 0 dc 5`);
  });
});
