// Local format experiments. The reference is a user-created blank native file,
// never a vendor library asset. Generated files stay in the supplied output folder.
import { createServer } from "vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const [reference, output] = process.argv.slice(2);
if (!reference || !output) throw new Error("Usage: node scripts/ms14-lab.mjs blank-native.ms14 output-directory");
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, server: { middlewareMode: true } });
try {
  const writer = await server.ssrLoadModule("/src/importer/writer.ts");
  const { decodeContainer } = await server.ssrLoadModule("/src/importer/container.ts");
  const { parseXml, bytesToText, path } = await server.ssrLoadModule("/src/importer/xml.ts");
  const { emptySchematic } = await server.ssrLoadModule("/src/core/schematic.ts");
  const { Doc } = await server.ssrLoadModule("/src/core/doc.ts");
  const { buildExample, EXAMPLES } = await server.ssrLoadModule("/src/core/examples.ts");
  const render = (node) => `<${node.tag}${Object.entries(node.attrs).map(([key, value]) => ` ${key}="${value}"`).join("")}>${node.children.map(render).join("")}</${node.tag}>`;
  const native = parseXml(bytesToText(decodeContainer(await readFile(reference))));
  const generated = parseXml(writer.ms14Xml({ schematic: buildExample(EXAMPLES[0]), analyses: [], issues: [] }));
  const getDiagram = (root) => path(root, "Project", "UniqueSheets", "SheetInfos", "SheetContainer", "Sheet", "Variable", "DesignSheet", "Sheet", "XMLSubSheet", "CIITHierDoc", "Diagram", "CIITDiagram");
  const cases = new Map();
  for(let i=0;i<EXAMPLES.length;i++) {
    try {cases.set(`p7-example-${i}`,parseXml(writer.ms14Xml({schematic:buildExample(EXAMPLES[i]),analyses:[],issues:[]})))}catch(e){console.log(`${EXAMPLES[i].name}: ${e.message}`)}
  }
  for (const bend of [false,true]) for (const rotation of [0,90]) {
    const doc=new Doc(); const a=doc.addPart('resistor',200,200),b=doc.addPart('capacitor',350,bend?300:200); b.rotation=rotation;
    doc.connectPins(a,'2',b,'1');
    cases.set(`p6-bend-${bend}-rot-${rotation}`,parseXml(writer.ms14Xml({schematic:doc.schematic,analyses:[],issues:[]})));
  }
  for (const kind of ["resistor", "ground", "vdc", "oscilloscope", "vsin", "capacitor", "bode-plotter"]) {
    const doc = new Doc(); doc.addPart(kind, 200, 200);
    cases.set(`p3-only-${kind}`, parseXml(writer.ms14Xml({ schematic: doc.schematic, analyses: [], issues: [] })));
  }
  cases.set("generated-empty", parseXml(writer.ms14Xml({ schematic: emptySchematic("Empty"), analyses: [], issues: [] })));
  cases.set("generated-rc", structuredClone(generated));
  const shell = structuredClone(native), diagram = getDiagram(shell), fresh = getDiagram(generated);
  for (const tag of ["Components", "Elements", "CiCircuitXMLizeHelper"]) {
    diagram.children = diagram.children.filter((n) => n.tag !== tag);
    diagram.children.push(structuredClone(fresh.children.find((n) => n.tag === tag)));
  }
  cases.set("native-shell-generated-diagram", shell);
  const nativeSheet = structuredClone(generated);
  path(nativeSheet, "Project", "UniqueSheets", "SheetInfos").children = structuredClone(path(native, "Project", "UniqueSheets", "SheetInfos").children);
  cases.set("generated-shell-native-sheet", nativeSheet);
  const appMetadata = structuredClone(generated);
  Object.assign(path(appMetadata, "Project").attrs, { AppName: "&amp;ASCMultisim", AppVersion: "&amp;ASC14.20.49240", AppExeVer: "&amp;ASC14.2.101.0", CurrentVersion: "", Dusted: "0", IsElvisProject: "0", ElvisProjectVersion: "0", LockedByUser: "" });
  cases.set("generated-native-app-metadata", appMetadata);
  const shellBlank = structuredClone(native);
  getDiagram(shellBlank).attrs.SimState = "";
  cases.set("native-no-simstate", shellBlank);
  for (const tag of ["Background", "CircPrefs", "Restrictions", "PCBLayers", "HiddenTitleBlockStorage"]) {
    const root = structuredClone(nativeSheet);
    getDiagram(root).children = getDiagram(root).children.filter((n) => n.tag !== tag);
    cases.set(`p2-without-${tag}`, root);
  }
  for (const wired of [false, true]) {
    const doc = new Doc(); const a = doc.addPart("resistor", 200, 200), b = doc.addPart("resistor", 350, 200);
    if (wired) doc.connectPins(a, "2", b, "1");
    cases.set(`p4-two-resistors-${wired ? "wired" : "unwired"}`, parseXml(writer.ms14Xml({schematic:doc.schematic,analyses:[],issues:[]})));
  }
  const noWires = structuredClone(generated);
  const objectList = path(getDiagram(noWires), "Components", "CODComposite", "Objects");
  objectList.children = objectList.children.filter(n=>!["CIITLinkComp", "CODPinComp"].includes(n.attrs.Class));
  cases.set("p4-rc-no-wires", noWires);
  const rc = buildExample(EXAMPLES[0]);
  for (let i = 0; i < rc.wires.length; i++) {
    cases.set(`p5-wire-${i}`, parseXml(writer.ms14Xml({schematic:{...rc,wires:[rc.wires[i]]},analyses:[],issues:[]})));
  }
  const shifted = structuredClone(rc);
  for (const c of shifted.components) {c.x+=500;c.y+=400;}
  for (const w of shifted.wires) for (const p of w.points) {p.x+=500;p.y+=400;}
  for (const p of [...shifted.labels,...shifted.texts]) {p.x+=500;p.y+=400;}
  cases.set("p5-shifted-rc",parseXml(writer.ms14Xml({schematic:shifted,analyses:[],issues:[]})));
  const empty = cases.get("generated-empty");
  const emptyDiagram = structuredClone(nativeSheet);
  const holder = path(emptyDiagram, "Project", "UniqueSheets", "SheetInfos", "SheetContainer", "Sheet", "Variable", "DesignSheet", "Sheet", "XMLSubSheet", "CIITHierDoc", "Diagram");
  holder.children = [structuredClone(getDiagram(empty))];
  cases.set("p2-generated-empty-diagram", emptyDiagram);
  const circuitOnly = structuredClone(nativeSheet);
  const circuitDiagram = getDiagram(circuitOnly);
  for (const tag of ["Elements", "CiCircuitXMLizeHelper"]) circuitDiagram.children = circuitDiagram.children.map((n) => n.tag === tag ? structuredClone(getDiagram(empty).children.find((c) => c.tag === tag)) : n);
  cases.set("p2-generated-empty-circuit", circuitOnly);
  const composite = structuredClone(shell);
  const compositeNode = path(getDiagram(composite), "Components", "CODComposite");
  Object.assign(compositeNode.attrs, path(getDiagram(native), "Components", "CODComposite").attrs);
  cases.set("p2-composite-native-attributes", composite);
  for (const [name, root] of cases) {
    const xml = `<?xml version="1.0" encoding="ASCII"?>\n${render(root)}`;
    const file = resolve(join(output, `${name}.ms14`));
    await writeFile(file, writer.encodeContainer(Uint8Array.from(xml, (c) => c.charCodeAt(0))));
    console.log(file);
  }
} finally { await server.close(); }
