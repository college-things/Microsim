// The original two-page fixture for the hierarchy tests: a block whose parts connect through named pin nets.
// The user-facing "Two-page gain stages" example builds a similar circuit with drawn wires instead.
import { Doc } from "../../src/core/doc";
import { blockSymbol } from "../../src/core/hierarchy";
import { emptySchematic, type BlockDefinition, type Schematic } from "../../src/core/schematic";

export function twoPageFixture(): Schematic {
  const doc = new Doc();
  doc.schematic.name = "Two-page gain stages";
    const blockDoc = new Doc();
  const amp = blockDoc.addPart("opamp", 0, 0);
  // An original ideal voltage gain stage, with explicit input, output and return.
  amp.kind = "imported"; amp.refDes = "E1"; amp.params = {};
  amp.graphics = [{ kind: "polygon", points: [{ x: -20, y: -20 }, { x: -20, y: 20 }, { x: 20, y: 0 }], filled: false }];
  amp.spice = "E{ref} {pin:out} {pin:return} {pin:in} {pin:return} 2";
  amp.pins = [{ name: "in", x: -30, y: 0, net: "IN" }, { name: "out", x: 30, y: 0, net: "OUT" }, { name: "return", x: 0, y: 30, net: "COM" }];
  const block: BlockDefinition = { ...blockDoc.schematic, id: "gain-stage", name: "Gain stage (2 V/V)" };
  for (const [i, name] of ["IN", "OUT", "COM"].entries()) block.components.push({ id: `gain-port-${i}`, refDes: `P${i + 1}`, kind: "hierarchy-port", x: -100, y: i * 60, rotation: 0, mirrored: false, params: { name }, displayValue: name, pins: [{ name: "port", x: 0, y: 0, net: name }], spice: "", graphics: [{ kind: "ellipse", cx: 0, cy: 0, rx: 4, ry: 4, filled: false }] });
  doc.schematic.blocks = [block];
  const first = blockSymbol(block, "gain-first", "X1", 50, 0);
  first.pins.forEach((p, i) => p.net = ["INPUT", "BETWEEN", "0"][i]);
  doc.schematic.components.push(first);
  const source = doc.addPart("vdc", -200, 0, { value: "1" });
  source.pins[0].net = "INPUT"; source.pins[1].net = "0";
  doc.addWire([{ x: -200, y: -30 }, { x: -200, y: -80 }, { x: -160, y: -80 }, { x: -160, y: -60 }, { x: -120, y: -60 }, { x: -120, y: -20 }, { x: 0, y: -20 }]);
  doc.addWire([{ x: -200, y: 30 }, { x: -200, y: 80 }, { x: -160, y: 80 }, { x: -160, y: 60 }, { x: -120, y: 60 }, { x: -120, y: 20 }, { x: 0, y: 20 }]);
  doc.schematic.labels.push({ id: "between-first", x: 0, y: 0, net: "BETWEEN" });
  const second = blockSymbol(block, "gain-second", "X2", 50, 0);
  second.pins.forEach((p, i) => p.net = ["BETWEEN", "OUTPUT", "0"][i]);
  const page = emptySchematic("Second stage");
  page.components.push(second);
  page.labels.push({ id: "between-second", x: 0, y: -20, net: "BETWEEN" });
  doc.schematic.pages = [page];
  doc.schematic.texts.push({ id: "gain-note", x: -250, y: 100, text: "1 V input → 2 V between pages → 4 V output. Both instances share one gain-stage definition." });
  return doc.schematic;
}
