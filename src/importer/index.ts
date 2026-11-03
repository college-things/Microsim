// Imports a circuit file into Ohmlet's document model. See docs/ms14-format.md for the format.
import type { AnalysisRequest } from "../core/sim";
import type {
  FreeText,
  ImportIssue,
  ImportResult,
  InstrumentKind,
  NetLabel,
  Pin,
  Point,
  SchComponent,
  Wire,
} from "../core/schematic";
import { pinWorld } from "../core/netlist";
import { bindConnectivity, type FileNets, Geometry, geometryOf } from "./connectivity";
import { decodeContainer } from "./container";
import {
  apply,
  multiply,
  boundsOf,
  type Bounds,
  drawObject,
  IDENTITY,
  matrixOf,
  newDrawing,
  orientationOf,
  type PinGeometry,
  type Placement,
  primToGraphic,
  type Prim,
  toLocal,
} from "./geometry";
import { applyInteractiveState, indicatorOf } from "./interactive";
import { mapAnalyses } from "./simstate";
import { expandTemplate, labelParameters, rewriteMergeNodes } from "./template";
import { displayText, normalizeStoredValue, singleLine } from "./values";
import { bytesToText, child, kids, parseXml, path, textValue, walk, type XmlNode } from "./xml";

export { decodeContainer } from "./container";

const MAX_DEPTH = 16;
const MAX_COMPONENTS = 200_000;
const SHEET_GAP = 200;

const GROUND_NET = /^d?gnd$/i;
/** Stored for a net that never got a name. Such nodes are separate nets despite the shared text. */
const PLACEHOLDER_NET = /^(empty_name)?$/i;
const GLOBAL_POWER_NET = /^(vcc|vdd|vss|vee|vpp|vbb|avcc|avdd|dvcc|dvdd)$/i;
const MERGE_TO_GROUND = /^(?:\s*\*.*\n)*\s*\.subckt\s+\S+\s+(\S+)\s*\n\s*(?:\.mergenodes\s+\1\s+0|r\w*\s+\1\s+0\s+\S+)\s*\n\s*\.ends\s*$/i;

interface Sheet {
  title: string;
  diagram: XmlNode;
  elements: Map<string, XmlNode>;
  objects: XmlNode[];
  symbolsById: Map<string, XmlNode>;
  symbolsByComponent: Map<string, XmlNode>;
  instruments: Map<string, Record<string, string>>;
}

interface Bucket {
  components: SchComponent[];
  wires: Wire[];
  labels: NetLabel[];
  texts: FreeText[];
  bounds: Bounds | null;
  wireNets: Map<string, string>;
  /** Wires whose net name the file shows, labelled once the wire's final path is known. */
  shownNets: Wire[];
  probes: Probe[];
}

/** A current probe, drawn clamped on a wire instead of wired in. */
interface Probe {
  component: SchComponent;
  at: Point;
  /** Stored arrow: 1 up, 3 right, 5 down, 7 left. */
  direction: string;
}

interface ModelEntry {
  name: string;
  text: string;
}

interface Context {
  sheetsByTitle: Map<string, Sheet>;
  /** Reference shown on the sheet, by sheet title and stored name. See loadReferenceNames. */
  shownRefs: Map<string, string>;
  /** Pins with no drawing, as "component id/pin name". They keep Pin.net. */
  heldPins: Set<string>;
  /** Ground parts, whose pin keeps net 0. */
  groundParts: Set<string>;
  issues: ImportIssue[];
  refs: Set<string>;
  nets: Map<string, string>;
  devices: Map<string, string>;
  models: Map<string, ModelEntry>;
  usedModels: Map<string, ModelEntry>;
  counts: Map<string, number>;
  nextId: number;
  componentCount: number;
  instanced: Set<Sheet>;
}

const sanitize = (text: string) => text.replace(/[^\w]/g, "_");

function classOf(item: XmlNode): string {
  return item.attrs.Class ?? item.children[0]?.attrs.Class ?? "";
}

function count(ctx: Context, key: string): void {
  ctx.counts.set(key, (ctx.counts.get(key) ?? 0) + 1);
}

function loadSheet(container: XmlNode): Sheet | null {
  const design = path(container, "Sheet", "Variable", "DesignSheet");
  const doc = path(design, "Sheet", "XMLSubSheet", "CIITHierDoc");
  const diagram = path(doc, "Diagram", "CIITDiagram");
  if (!design || !doc || !diagram) return null;
  const elements = new Map<string, XmlNode>();
  for (const item of kids(child(diagram, "Elements"))) {
    if (item.attrs.CiID) elements.set(item.attrs.CiID, item);
  }
  const objects: XmlNode[] = [];
  const symbolsById = new Map<string, XmlNode>();
  const symbolsByComponent = new Map<string, XmlNode>();
  for (const composite of kids(child(diagram, "Components"))) {
    for (const item of kids(child(composite, "Objects"))) {
      objects.push(item);
      const node = item.children[0];
      if (!node) continue;
      if (item.attrs.ID) symbolsById.set(item.attrs.ID, item);
      if (node.attrs.CiComponent) symbolsByComponent.set(node.attrs.CiComponent, item);
    }
  }
  const instruments = new Map<string, Record<string, string>>();
  for (const entry of kids(child(doc, "InstrumentsData"))) {
    const longName = textValue(entry.attrs.CompLongName);
    const name = longName.split("#")[0];
    const props: Record<string, string> = {};
    for (const element of kids(path(entry, "InstrumentProperties", "CDataElementMap", "MapData"))) {
      const key = textValue(element.attrs.Key).replace(/^NI_EWB_/, "");
      const data = element.children[0]?.attrs.Data;
      if (key && data !== undefined) props[key] = textValue(data);
    }
    instruments.set(name, props);
  }
  return {
    title: textValue(design.attrs.Title),
    diagram,
    elements,
    objects,
    symbolsById,
    symbolsByComponent,
    instruments,
  };
}

/**
 * The reference a part shows, and the name SPICE knows it by, is held in a project-wide table.
 * LocalName and the symbol's name text can be stale: a part stored as R1 may show R6.
 */
function loadReferenceNames(project: XmlNode): Map<string, string> {
  const names = new Map<string, string>();
  walk(project, (node) => {
    if (node.tag !== "CIRToInfoMapItem") return;
    const info = child(node, "RefDesInfo");
    if (!info) return;
    const prefix = textValue(info.attrs.IRPrefix);
    if (!prefix) return;
    // The record is !0 separated: stored name, file, page, sheet title, then the instance path.
    const sheet = textValue(child(info, "RefDesInfoData")?.attrs.RefDes).split("!0")[6] ?? "";
    // The key is the symbol's stored name text, which is what a section is filed under: U2A can show as U1B.
    const key = `${sheet}\n${textValue(node.attrs.CIRKey)}`;
    const number = info.attrs.IRNumber;
    const shown = number === undefined || number === "-1" ? prefix : `${prefix}${number}`;
    if (!names.has(key)) names.set(key, shown + textValue(info.attrs.IRSection));
  });
  return names;
}

/** The net modifiers on an object: NI_EWB_NET_VIRTUAL and so on, each with a stated name. */
function modifiersOf(node: XmlNode): { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  for (const element of kids(path(node, "ElectricalObject", "ModifierInfo"))) {
    const kind = textValue(element.attrs.NetModifier);
    if (!kind) continue;
    out.push({ kind, value: singleLine(textValue(element.children[0]?.attrs.Value)) });
  }
  return out;
}

/** The modifier on one of a symbol's pins. */
function pinModifier(symbol: XmlNode, pinName: string): { kind: string; value: string } | undefined {
  for (const item of kids(child(symbol.children[0], "Objects"))) {
    if (classOf(item) !== "CIITPinSymbolComp" || !item.children[0]) continue;
    if (textValue(item.children[0].attrs.PinName) !== pinName) continue;
    return modifiersOf(item.children[0])[0];
  }
  return undefined;
}

function attributeOf(node: XmlNode, cls: string): XmlNode | undefined {
  for (const item of kids(child(node, "Attributes"))) {
    const inner = item.children[0];
    if (inner && inner.attrs.Class === cls) return inner;
  }
  return undefined;
}

function stringList(node: XmlNode | undefined): string[] {
  return kids(child(node, "strings")).map((item) => textValue(item.attrs.Value));
}

function modelOf(sheet: Sheet, id: string | undefined): ModelEntry | undefined {
  const item = id ? sheet.elements.get(id) : undefined;
  const node = item?.children[0];
  if (!node) return undefined;
  return { name: textValue(node.attrs.LocalName), text: textValue(attributeOf(node, "CiaCString")?.attrs.String).replace(/\r\n?/g, "\n") };
}

const isRealModel = (text: string) => /^\s*\.(subckt|model)\b/im.test(text);

function registerModels(ctx: Context, sheet: Sheet): void {
  for (const item of sheet.elements.values()) {
    if (classOf(item) !== "CiModel") continue;
    const node = item.children[0];
    if (!node) continue;
    const name = textValue(node.attrs.LocalName);
    const key = name.toLowerCase();
    if (!name || ctx.models.has(key)) continue;
    const text = textValue(attributeOf(node, "CiaCString")?.attrs.String).replace(/\r\n?/g, "\n");
    if (isRealModel(text)) ctx.models.set(key, { name, text });
  }
}

/** Marks a model used, along with every model its text names, without rescanning any text. */
function useModels(ctx: Context, text: string): void {
  const pending = [text];
  while (pending.length) {
    const body = pending.pop()!;
    for (const word of body.split(/[\s(),={}]+/)) {
      const key = word.toLowerCase();
      const model = ctx.models.get(key);
      if (model && !ctx.usedModels.has(key)) {
        ctx.usedModels.set(key, model);
        pending.push(model.text);
      }
    }
  }
}

function uniqueRef(ctx: Context, wanted: string, suffix = ""): string {
  const base = sanitize(wanted) || "U";
  let name = base;
  // A sheet placed twice repeats its names; the block's name tells the copies apart.
  if (suffix && ctx.refs.has(name.toLowerCase())) name = `${base}_${suffix}`;
  for (let n = 2; ctx.refs.has(name.toLowerCase()); n++) name = `${base}_${suffix ? `${suffix}_` : ""}${n}`;
  ctx.refs.add(name.toLowerCase());
  return name;
}

/** Gives every distinct net a SPICE-safe name, compared without case as SPICE does. */
function uniqueNet(ctx: Context, owner: string, wanted: string): string {
  const base = sanitize(wanted) || "net";
  let name = base;
  for (let n = 2; ; n++) {
    const taken = ctx.nets.get(name.toLowerCase());
    if (taken === undefined || taken === owner) break;
    name = `${base}_${n}`;
  }
  ctx.nets.set(name.toLowerCase(), owner);
  return name;
}

function addBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

/** Plain resistors, capacitors and inductors, whose main value can be swept or given a tolerance. */
function familyOf(spice: string): { family: "resistor" | "capacitor" | "inductor"; valueKey: string } | null {
  const match = /^([rcl])\{ref\}\s+\{pin:[^}]+\}\s+\{pin:[^}]+\}\s+\{param:([^}]+)\}/i.exec(spice);
  if (!match) return null;
  const family = ({ r: "resistor", c: "capacitor", l: "inductor" } as const)[match[1].toLowerCase() as "r" | "c" | "l"];
  return { family, valueKey: match[2] };
}

const SETTING_LABELS: Record<string, string> = {
  timePerDiv: "Time per division", voltsPerDivA: "Channel A volts per division", voltsPerDivB: "Channel B volts per division",
  positionA: "Channel A position", positionB: "Channel B position", triggerLevel: "Trigger level",
  fstart: "Start frequency", fstop: "Stop frequency",
  shape: "Waveform", freq: "Frequency", amp: "Amplitude", offset: "Offset", duty: "Duty cycle (%)", mode: "Mode",
  r1: "Upper segment", r2: "Lower segment",
};

/** Readable names for the params a part has. Anything without an established name stays out. */
function labelsFor(template: string, params: Record<string, string>, spice: string): Record<string, string> {
  const known = labelParameters(template);
  const labels: Record<string, string> = {};
  for (const key of Object.keys(params)) {
    if (key === "value") {
      labels.value = /VariableCapacitor/.test(spice) ? "Capacitance" : /VariableInductor/.test(spice) ? "Inductance" : /Current/.test(spice) ? "Current" : "Voltage";
    } else if (known[key] ?? SETTING_LABELS[key]) {
      labels[key] = known[key] ?? SETTING_LABELS[key];
    }
  }
  return labels;
}

interface InstrumentPlan {
  kind?: InstrumentKind;
  /** Stored pin name to Ohmlet pin name. */
  pins?: Record<string, string>;
}

const INSTRUMENT_PREFIXES: [RegExp, InstrumentKind, Record<string, string>?][] = [
  [/^XSC\d/i, "oscilloscope", { "1": "A", "2": "B", "3": "T+", "4": "G", "5": "B-", "6": "T-" }],
  [/^XFG\d/i, "function-generator", { "1": "p", "2": "n", "3": "neg" }],
  [/^XMM\d/i, "multimeter", { "1": "p", "2": "n" }],
  [/^XBP\d/i, "bode-plotter", { "1": "in+", "2": "in-", "3": "out+", "4": "out-" }],
  [/^XWM\d/i, "wattmeter"],
  [/^XLA\d/i, "logic-analyzer"],
];

/** Instruments are recognised by their reference prefix, stored as e.g. XSC%d. */
function planInstrument(name: string, identity: string[], portCount: number): InstrumentPlan | null {
  if (!/^X[A-Z]+%d$/.test(identity[4] ?? "")) return null;
  for (const [pattern, kind, pins] of INSTRUMENT_PREFIXES) {
    if (pattern.test(name)) {
      // Only the six-terminal scope has this pin layout; others keep their stored names.
      if (kind === "oscilloscope" && portCount !== 6) return { kind };
      return { kind, pins };
    }
  }
  return {};
}

function flattenSheet(ctx: Context, sheet: Sheet, suffix: string, parentNets: Map<string, string>, depth: number): Bucket[] {
  const bucket: Bucket = { components: [], wires: [], labels: [], texts: [], bounds: null, wireNets: new Map(), shownNets: [], probes: [] };
  const buckets: Bucket[] = [bucket];
  const owner = `scope:${suffix}`;
  registerModels(ctx, sheet);

  const nodeName = (id: string): string => textValue(sheet.elements.get(id)?.children[0]?.attrs.LocalName);
  // Who joins which node is settled below, once the drawing is known.
  const forcedByNode: [string, string][] = [];
  const groundNodes: string[] = [];
  const localFallback: [string, string][] = [];
  const netAliases = new Map<string, string>();
  /** What behavioural expressions may call a part, to its instance name in the output. */
  const devices = new Map<string, string>();
  const shownName = (key: string) => ctx.shownRefs.get(`${sheet.title}\n${key}`);
  const symbolOf = (item: XmlNode): XmlNode | undefined => {
    const node = item.children[0];
    return (node?.attrs.SymCompID ? sheet.symbolsById.get(node.attrs.SymCompID) : undefined) ??
      (item.attrs.CiID ? sheet.symbolsByComponent.get(item.attrs.CiID) : undefined);
  };
  const componentItems: XmlNode[] = [];
  /** Component id, shown reference ("" when the file hides it) and a name for messages. */
  const identities = new Map<XmlNode, { id: string; refDes: string; label: string }>();
  for (const item of sheet.elements.values()) {
    const cls = classOf(item);
    if (cls !== "CiComponent" && cls !== "CiInstComponent") continue;
    componentItems.push(item);
    const node = item.children[0];
    if (!node) continue;
    const name = textValue(node.attrs.LocalName);
    const portIds = kids(child(node, "Ports"));
    const firstPort = portIds[0] ? sheet.elements.get(portIds[0].attrs.CiID ?? "")?.children[0] : undefined;
    const firstNode = firstPort ? kids(child(firstPort, "Nodes"))[0]?.attrs.CiID : undefined;
    if (firstNode && parentNets.has(name) && portIds.length === 1) forcedByNode.push([firstNode, parentNets.get(name)!]);
    const model = modelOf(sheet, node.attrs.Model);
    if (model && MERGE_TO_GROUND.test(model.text) && firstNode) groundNodes.push(firstNode);
    if (firstNode && portIds.length === 1 && !attributeOf(node, "CiaSpiceTmpltExprt")?.attrs.String?.trim() && name) netAliases.set(name.toLowerCase(), firstNode);
    const instance = /^[ \t]*([^\s*%]*)%p/m.exec(textValue(attributeOf(node, "CiaSpiceTmpltExprt")?.attrs.String));

    // The stored name text is empty when the file hides the name, and otherwise keys the shown reference.
    const symbolNode = symbolOf(item)?.children[0];
    const nameText = textValue(kids(child(symbolNode, "Objects")).find((o) => classOf(o) === "CIITSymTextCompName")?.children[0]?.attrs.Output);
    const spiceName = shownName(nameText) ?? shownName(name);
    const isGroundPart = name === "0" || stringList(kids(child(node, "Attributes"))[4]?.children[0])[1] === "GROUND";
    const id = `c${ctx.nextId++}`;
    let refDes = isGroundPart || !nameText ? "" : singleLine(shownName(nameText) ?? nameText);
    // Parts that simulate need a name of their own; an empty one falls back on the id in the netlister.
    // That cannot work where the name alone selects the device, as in "%p ... %m" for an X call.
    if (!refDes && instance && !instance[1] && classOf(item) !== "CiInstComponent") refDes = spiceName ?? name;
    // Digital grounds and repeated supplies are one thing drawn many times, shown under one name.
    const groundOnly = MERGE_TO_GROUND.test(modelOf(sheet, node.attrs.Model)?.text ?? "");
    const supply = /^\s*V\S*%p\s+%t\S+\s+0\s+dc\s+#0/i.test(textValue(attributeOf(node, "CiaSpiceTmpltExprt")?.attrs.String));
    if (refDes && instance && classOf(item) !== "CiInstComponent" && !groundOnly && !supply) {
      refDes = uniqueRef(ctx, refDes, suffix);
    }
    const label = refDes || name || id;
    identities.set(item, { id, refDes, label });

    if (name && instance) {
      const shown = spiceName ?? name;
      const device = `${instance[1]}${refDes || `P_${id}`}`;
      // Expressions use the shown reference, with or without the instance letter. Stored names are a fallback.
      devices.set(shown.toLowerCase(), device);
      devices.set(`${instance[1]}${shown}`.toLowerCase(), device);
      localFallback.push([name.toLowerCase(), device], [`${instance[1]}${name}`.toLowerCase(), device]);
    }
  }
  for (const [key, device] of localFallback) if (!devices.has(key)) devices.set(key, device);
  // Parts on outer sheets can be named from inside a block, so they are kept for the blocks below.
  for (const [key, device] of devices) if (!ctx.devices.has(key)) ctx.devices.set(key, device);
  // Set once the drawing is known: the net for each stored node.
  let netOfKey: (key: string) => string = () => "";
  const netOf = (id: string | undefined): string | undefined => (id ? netOfKey(`n:${id}`) : undefined);
  const nodeByName = new Map<string, string>();
  for (const [id, item] of sheet.elements) {
    const name = nodeName(id);
    if (classOf(item) === "CiNode" && !PLACEHOLDER_NET.test(name) && !nodeByName.has(name.toLowerCase())) nodeByName.set(name.toLowerCase(), id);
  }
  /** Names wires carry as labels, which outrank what the node happens to be called. */
  const wireNames = new Map<string, string>();

  /** Behavioural expressions name nets and parts as the sheet does, so they follow any renaming. */
  const mapExpression = (refDes: string) => (text: string): string =>
    text.replace(/\b([vi])\s*\(\s*([^(),\s]+)\s*(?:,\s*([^(),\s]+)\s*)?\)/gi, (whole: string, kind: string, a: string, b: string | undefined) => {
      if (kind.toLowerCase() === "i") {
        if (b !== undefined) return whole;
        const key = a.toLowerCase();
        const device = devices.get(key) ?? ctx.devices.get(key);
        if (device) return `${kind}(${device})`;
        ctx.issues.push({ severity: "warning", refDes, message: `Template: expression refers to part ${a}, which was not found.` });
        return whole;
      }
      const resolve = (name: string): string => {
        if (name === "0") return "0";
        const key = name.toLowerCase();
        const net = netOf(wireNames.get(key) ?? netAliases.get(key) ?? nodeByName.get(key));
        if (net === undefined) {
          ctx.issues.push({ severity: "warning", refDes, message: `Template: expression refers to net ${name}, which is not on this sheet.` });
          return name;
        }
        return net;
      };
      return b === undefined ? `${kind}(${resolve(a)})` : `${kind}(${resolve(a)},${resolve(b)})`;
    });

  // Wires come first so hidden pins can avoid them.
  const occupied = new Set<string>();
  const occupy = (p: Point) => occupied.add(`${Math.round(p.x)},${Math.round(p.y)}`);
  const art = newDrawing();
  const wireByStoredId = new Map<string, Wire>();
  const storedWires: { wire: Wire; node: string }[] = [];
  const wireLabels = new Map<string, string>();
  const netTexts: XmlNode[] = [];
  let hoverNotes = 0;
  for (const item of sheet.objects) {
    const cls = classOf(item);
    const node = item.children[0];
    if (!node || node.attrs.CiComponent) continue;
    switch (cls) {
      case "CIITLinkComp": {
        if (node.attrs.LineHidden === "1") {
          count(ctx, "hidden wire");
          break;
        }
        const m = matrixOf(node);
        const points = kids(child(node, "Points")).map((p) => apply(m, parseFloat(p.attrs.X) || 0, parseFloat(p.attrs.Y) || 0));
        if (points.length < 2) break;
        points.forEach(occupy);
        bucket.wires.push({ id: `w${ctx.nextId++}`, points });
        if (item.attrs.ID) wireByStoredId.set(item.attrs.ID, bucket.wires[bucket.wires.length - 1]);
        if (node.attrs.Node) {
          storedWires.push({ wire: bucket.wires[bucket.wires.length - 1], node: node.attrs.Node });
          const label = modifiersOf(node).find((m) => m.kind === "NI_EWB_NET_NAME")?.value;
          if (label && !wireNames.has(label.toLowerCase())) wireNames.set(label.toLowerCase(), node.attrs.Node);
          if (label) wireLabels.set(node.attrs.Node, label);
        }
        bucket.bounds = addBounds(bucket.bounds, boundsOf([{ kind: "line", points }], []));
        break;
      }
      case "CODTextComp":
      case "CIITPostItComp": {
        // A note is an icon with text on hover unless ShowInfo pins it open.
        if (cls === "CIITPostItComp" && node.attrs.ShowInfo !== "1") {
          if (textValue(node.attrs.Text).trim()) hoverNotes++;
          break;
        }
        const text = displayText(textValue(cls === "CIITPostItComp" ? node.attrs.Text : node.attrs.Output)).trim();
        if (text) {
          const at = apply(matrixOf(node), cls === "CIITPostItComp" ? parseFloat(node.attrs.InfoBoxOffsetX ?? "0") || 0 : 0, cls === "CIITPostItComp" ? parseFloat(node.attrs.InfoBoxOffsetY ?? "0") || 0 : 0);
          bucket.texts.push({ id: `t${ctx.nextId++}`, x: at.x, y: at.y, text });
          bucket.bounds = addBounds(bucket.bounds, { minX: at.x, minY: at.y, maxX: at.x, maxY: at.y });
        }
        break;
      }
      case "CODRectComp":
      case "CODLineComp":
      case "CODMultiLineComp":
      case "CODPolygonComp":
      case "CODEllipseComp":
      case "CIITArcComp":
      case "CIITBusCompV8":
      case "CIITBusEntry":
      case "CIITBusName":
        drawObject(art, item, IDENTITY);
        break;
      case "CODPinComp":
        break;
      case "CODNodeTextComp":
        netTexts.push(node);
        break;
      default:
        count(ctx, cls);
    }
  }
  if (hoverNotes) ctx.issues.push({ severity: "info", message: `Drawing: ${hoverNotes} hover-only note(s) were not placed on the sheet.` });

  // First pass: drawings, so that every real pin position is known before hidden pins are placed.
  const parts = componentItems.map((item) => {
    const node = item.children[0];
    const symbol = symbolOf(item);
    const drawing = newDrawing(parseInt(symbol?.children[0]?.attrs.CurIndex ?? "0", 10) || 0);
    if (symbol) drawObject(drawing, symbol, IDENTITY);
    drawing.pins.forEach((pin) => occupy(pin.at));
    for (const [cls, n] of drawing.lost) {
      for (let i = 0; i < n; i++) count(ctx, cls);
    }
    return { item, node, symbol, drawing };
  });

  // The nets. A stored node is one piece of wire, and these say which pieces are one net.
  const joins = new Geometry();
  const allKeys = new Set<string>();
  const join = (a: string, b: string) => {
    allKeys.add(a);
    allKeys.add(b);
    joins.join(a, b);
  };
  const nameOfGroup = new Map<string, string>();
  const pointNodes = new Map<string, Set<string>>();
  const atPoint = (p: Point) => `${Math.round(p.x)},${Math.round(p.y)}`;
  for (const { wire, node } of storedWires) {
    allKeys.add(`n:${node}`);
    for (const point of wire.points) {
      const list = pointNodes.get(atPoint(point));
      if (list) list.add(node);
      else pointNodes.set(atPoint(point), new Set([node]));
    }
  }
  for (const [id, item] of sheet.elements) {
    if (classOf(item) !== "CiNode") continue;
    allKeys.add(`n:${id}`);
    const raw = nodeName(id);
    if (raw === "0" || GROUND_NET.test(raw)) join(`n:${id}`, "g:0");
    else if (GLOBAL_POWER_NET.test(raw)) join(`n:${id}`, `g:${raw.toLowerCase()}`);
  }
  for (const id of groundNodes) join(`n:${id}`, "g:0");

  // Two stored nodes of the same name that touch are one net; the name alone proves nothing.
  const byName = new Map<string, { wire: Wire; node: string }[]>();
  for (const stored of storedWires) {
    const name = nodeName(stored.node);
    const list = byName.get(name);
    if (list) list.push(stored);
    else byName.set(name, [stored]);
  }
  const touches = (p: Point, wire: Wire) => {
    for (let i = 1; i < wire.points.length; i++) {
      const a = wire.points[i - 1];
      const b = wire.points[i];
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (Math.abs(cross) <= 0.5 && p.x >= Math.min(a.x, b.x) - 0.5 && p.x <= Math.max(a.x, b.x) + 0.5
        && p.y >= Math.min(a.y, b.y) - 0.5 && p.y <= Math.max(a.y, b.y) + 0.5) return true;
    }
    return false;
  };
  for (const group of byName.values()) {
    if (group.length > 400) continue;
    for (const one of group) {
      for (const end of [one.wire.points[0], one.wire.points[one.wire.points.length - 1]]) {
        for (const other of group) {
          if (other.node !== one.node && touches(end, other.wire)) join(`n:${one.node}`, `n:${other.node}`);
        }
      }
    }
  }

  // Pins: connectors carry a net by name, and a pin lands on wires of its own node name.
  const keyOfPin = new Map<string, string>();
  for (const { item, node, symbol, drawing } of parts) {
    if (!node) continue;
    const portNodes = new Map<string, string | undefined>();
    const portNames: string[] = [];
    for (const portRef of kids(child(node, "Ports"))) {
      const portNode = sheet.elements.get(portRef.attrs.CiID ?? "")?.children[0];
      if (!portNode) continue;
      const name = textValue(portNode.attrs.LocalName);
      portNames.push(name);
      portNodes.set(name, kids(child(portNode, "Nodes"))[0]?.attrs.CiID);
    }
    for (const pin of drawing.pins) {
      const stored = portNodes.has(pin.name) ? pin.name : portNames.length === 1 ? portNames[0] : pin.name;
      const nodeId = portNodes.get(stored);
      if (nodeId) {
        for (const other of byName.get(nodeName(nodeId)) ?? []) {
          if (other.node !== nodeId && touches(pin.at, other.wire)) join(`n:${nodeId}`, `n:${other.node}`);
        }
      }
      const stated = symbol ? pinModifier(symbol, pin.name) : undefined;
      let key: string | undefined;
      if (stated?.value) {
        if (stated.kind === "NI_EWB_NET_VIRTUAL") key = `v:${stated.value}`;
        else if (stated.kind === "NI_EWB_NET_GLOBAL") key = `g:${stated.value.toLowerCase()}`;
        else if (stated.kind === "NI_EWB_NET_GLOBAL_GROUND") key = "g:0";
        else if (stated.kind === "NI_EWB_NET_HIERARCHY") key = `h:${stated.value}`;
      }
      if (!key) continue;
      if (key.startsWith("g:") && key !== "g:0") nameOfGroup.set(key, stated!.value);
      allKeys.add(key);
      keyOfPin.set(`${item.attrs.CiID}/${stored}`, key);
      if (nodeId) join(`n:${nodeId}`, key);
      else for (const other of pointNodes.get(atPoint(pin.at)) ?? []) join(`n:${other}`, key);
      if (key.startsWith("h:") && parentNets.has(stated!.value)) forcedByNode.push([key, parentNets.get(stated!.value)!]);
    }
  }

  // Buses: entries with one name on buses of one name are one net.
  const busOfEntry = new Map<string, string>();
  for (const item of sheet.objects) {
    if (classOf(item) !== "CIITBusCompV8" || !item.children[0]) continue;
    const name = modifiersOf(item.children[0]).find((m) => m.kind === "NI_EWB_NET_VIRTUAL")?.value ?? item.attrs.ID ?? "";
    for (const entry of kids(child(item.children[0], "BusEntries"))) busOfEntry.set(entry.attrs.ID ?? "", name);
  }
  for (const item of sheet.objects) {
    const entry = item.children[0];
    if (classOf(item) !== "CIITBusEntry" || !entry) continue;
    const line = modifiersOf(entry).find((m) => m.kind === "NI_EWB_NET_BUS_ENTRY")?.value;
    if (!line) continue;
    const key = `b:${busOfEntry.get(item.attrs.ID ?? "") ?? ""}/${line}`;
    for (const inner of kids(child(entry, "Objects"))) {
      if (classOf(inner) !== "CIITPinConnectorComp" || !inner.children[0]) continue;
      const m = multiply(matrixOf(inner.children[0]), matrixOf(entry));
      const at = apply(m, parseFloat(inner.children[0].attrs.ptCenterX ?? "0") || 0, parseFloat(inner.children[0].attrs.ptCenterY ?? "0") || 0);
      for (const other of pointNodes.get(atPoint(at)) ?? []) join(`n:${other}`, key);
    }
  }

  // Name each group: a stated name first, then the most meaningful stored one.
  const members = new Map<string, string[]>();
  for (const key of allKeys) {
    const root = joins.find(key);
    const list = members.get(root);
    if (list) list.push(key);
    else members.set(root, [key]);
  }
  const forcedNets = new Map<string, string>();
  for (const [id, net] of forcedByNode) {
    const key = id.includes(":") ? id : `n:${id}`;
    forcedNets.set(joins.find(key), net);
  }
  const groupNets = new Map<string, string>();
  netOfKey = (key: string): string => {
    const root = joins.find(key);
    const cached = groupNets.get(root);
    if (cached !== undefined) return cached;
    const keys = members.get(root) ?? [key];
    let net = forcedNets.get(root);
    if (net === undefined) {
      const nodeNames = keys.filter((k) => k.startsWith("n:")).map((k) => nodeName(k.slice(2))).filter((n) => !PLACEHOLDER_NET.test(n));
      const inherited = nodeNames.find((n) => parentNets.has(n));
      const global = keys.find((k) => k.startsWith("g:"));
      if (keys.includes("g:0")) net = "0";
      else if (inherited) net = parentNets.get(inherited)!;
      else if (global) {
        const shown = nameOfGroup.get(global) ?? nodeNames.find((n) => n.toLowerCase() === global.slice(2)) ?? global.slice(2);
        net = uniqueNet(ctx, `global:${global.slice(2)}`, shown);
      } else {
        const stated = keys.filter((k) => k.startsWith("v:") || k.startsWith("h:")).map((k) => k.slice(2)).sort()[0];
        const label = keys.filter((k) => k.startsWith("n:")).map((k) => wireLabels.get(k.slice(2))).find((l) => l);
        const best = stated ?? nodeNames.find((n) => !/^\d+$/.test(n)) ?? nodeNames[0] ?? label ?? "unnamed";
        net = uniqueNet(ctx, `${owner}:${root}`, suffix ? `${best}_${suffix}` : best);
      }
    }
    groupNets.set(root, net);
    return net;
  };
  for (const { wire, node } of storedWires) bucket.wireNets.set(wire.id, netOf(node)!);

  // A net's name shows only when its text holds one; the label sits on the wire so it also joins it.
  for (const text of netTexts) {
    if (!textValue(text.attrs.Output)) continue;
    const wire = kids(child(text, "Links")).map((link) => wireByStoredId.get(link.attrs.ID ?? "")).find((w) => w);
    const net = wire ? bucket.wireNets.get(wire.id) : undefined;
    if (!wire || net === undefined) continue;
    bucket.shownNets.push(wire);
  }

  // Second pass: everything else.
  const instances: { sheetTitle: string; ref: string; nets: Map<string, string> }[] = [];
  let unplaced = 0;
  for (const { item, node, symbol, drawing } of parts) {
    if (!node) continue;
    if (ctx.componentCount++ > MAX_COMPONENTS) throw new Error("Circuit is too large: too many components after flattening.");
    const localName = textValue(node.attrs.LocalName);
    const attributes = kids(child(node, "Attributes"));
    const paramList = attributeOf(node, "CiaParamList");
    const parameters = kids(child(paramList, "parameters")).map((p) => normalizeStoredValue(singleLine(textValue(p.attrs.Value))));
    // Some parts store a value only in "doubles"; there it is a plain number with no scaling lost.
    kids(child(paramList, "doubles")).forEach((d, index) => {
      if (index >= parameters.length) parameters[index] = String(parseFloat(d.attrs.Value ?? "0") || 0);
    });
    const strings = stringList(paramList);
    const identity = stringList(attributes[5]?.children[0]);
    const part = stringList(attributes[4]?.children[0]);
    const template = textValue(attributeOf(node, "CiaSpiceTmpltExprt")?.attrs.String);
    const isInstance = classOf(item) === "CiInstComponent";

    const symbolNode = symbol?.children[0];
    const isGroundSymbol = localName === "0" || part[1] === "GROUND";
    const { id: componentId, refDes: shownRef, label: partLabel } = identities.get(item)!;

    // Pins: stored ports matched to drawn pins by name, then by order when names cannot help.
    const ports: { stored: string; net?: string }[] = [];
    for (const portRef of kids(child(node, "Ports"))) {
      const portNode = sheet.elements.get(portRef.attrs.CiID ?? "")?.children[0];
      if (!portNode) {
        ctx.issues.push({ severity: "warning", refDes: partLabel, message: `Connectivity: port ${portRef.attrs.CiID} is missing from the file.` });
        continue;
      }
      const portNodeId = kids(child(portNode, "Nodes"))[0]?.attrs.CiID;
      const storedName = textValue(portNode.attrs.LocalName);
      const statedKey = keyOfPin.get(`${item.attrs.CiID}/${storedName}`);
      ports.push({
        stored: singleLine(storedName).replace(/[{}]/g, "_"),
        // Some connectors have no stored node and are on their net by name alone.
        net: portNodeId ? netOf(portNodeId) : statedKey ? netOfKey(statedKey) : undefined,
      });
    }
    const plan = planInstrument(localName, identity, ports.length);
    const alias = (name: string) => plan?.pins?.[name] ?? name;
    const interactive = template.includes("!!!END-INTERACT")
      ? applyInteractiveState({
          template,
          parameters,
          strings,
          label: textValue(kids(child(symbolNode, "Objects")).find((o) => classOf(o) === "CIITSymTextCompValue")?.children[0]?.attrs.Output),
          display: textValue(kids(child(symbolNode, "Objects")).find((o) => classOf(o) === "CIITVariableSymText")?.children[0]?.attrs.Output),
          state: parseInt(symbolNode?.attrs.CurIndex ?? "0", 10) || 0,
        })
      : undefined;
    const expanded = template.trim()
      ? expandTemplate({
          template: interactive?.template ?? template,
          parameters,
          strings,
          modelName: modelOf(sheet, node.attrs.Model)?.name,
          pinNames: ports.map((p) => p.stored),
          pinAlias: plan?.pins ? alias : undefined,
          mapString: /\.subckt/i.test(template) ? undefined : mapExpression(partLabel),
        })
      : undefined;

    const drawn = new Map<string, PinGeometry[]>();
    for (const pin of drawing.pins) {
      const list = drawn.get(pin.name);
      if (list) list.push(pin);
      else drawn.set(pin.name, [pin]);
    }
    const located = ports.map((port) => drawn.get(port.stored)?.shift());
    const leftover = [...drawn.values()].flat();
    const unmatched = located.filter((p) => !p).length;
    if (unmatched && leftover.length === unmatched) {
      let next = 0;
      located.forEach((p, i) => {
        if (!p) located[i] = leftover[next++];
      });
    }

    // Placement: geometry is stored already rotated, so the orientation is taken out to get local shapes.
    const bounds = boundsOf(drawing.prims, drawing.pins);
    const { rotation, mirrored } = orientationOf(parseInt(symbolNode?.attrs.OrientationFlip ?? "0", 10) || 0);
    let center: Point;
    const realPins = located.filter((p): p is PinGeometry => !!p);
    if (realPins.length) {
      const b = boundsOf([], realPins)!;
      center = { x: Math.round((b.minX + b.maxX) / 2), y: Math.round((b.minY + b.maxY) / 2) };
    } else if (bounds) {
      center = { x: Math.round((bounds.minX + bounds.maxX) / 2), y: Math.round((bounds.minY + bounds.maxY) / 2) };
    } else {
      // Nothing to place by: queue the part in a row above the sheet.
      center = { x: (bucket.bounds?.minX ?? 0) + unplaced++ * 40, y: (bucket.bounds?.minY ?? 0) - 60 };
    }
    const place: Placement = { x: center.x, y: center.y, rotation, mirrored };

    const pins: Pin[] = [];
    const seenPins = new Set<string>();
    let hiddenCount = 0;
    const hiddenPosition = (): Point => {
      for (let i = 1; ; i++) {
        const candidate = { x: center.x + i, y: center.y + (hiddenCount % 2 === 0 ? 1 : -1) };
        if (!occupied.has(`${candidate.x},${candidate.y}`)) {
          occupied.add(`${candidate.x},${candidate.y}`);
          hiddenCount++;
          return candidate;
        }
      }
    };
    ports.forEach((port, index) => {
      let name = alias(port.stored || "1");
      for (let n = 2; seenPins.has(name); n++) name = `${alias(port.stored || "1")}_${n}`;
      seenPins.add(name);
      if (!located[index]) ctx.heldPins.add(`${componentId}/${name}`);
      const at = toLocal(located[index]?.at ?? hiddenPosition(), place);
      const pin: Pin = { name, x: at.x, y: at.y };
      if (port.net !== undefined) pin.net = port.net;
      pins.push(pin);
    });

    // A block's stored line calls a subcircuit that is really a sheet, which gets flattened instead.
    let spice = isInstance ? "" : expanded?.spice ?? "";
    const params: Record<string, string> = { ...expanded?.params, ...interactive?.params };
    let instrument: InstrumentKind | undefined;

    const refDes = partLabel;
    if (expanded && !isInstance) {
      for (const name of expanded.unknownPins) {
        ctx.issues.push({ severity: "warning", refDes, message: `Template: refers to pin ${name}, which the part does not have; it will be left unconnected.` });
        if (!seenPins.has(alias(name))) {
          const at = toLocal(hiddenPosition(), place);
          seenPins.add(alias(name));
          pins.push({ name: alias(name), x: at.x, y: at.y });
        }
      }
      for (const problem of expanded.problems) ctx.issues.push({ severity: "warning", refDes, message: `Template: ${problem}` });
      for (const stored of expanded.ignoredInitialConditions) {
        ctx.issues.push({ severity: "info", refDes, message: `Template: stored initial condition ${stored} is switched off in the file, so it was left out.` });
      }
      if (/\.mergenodes/i.test(template)) spice = rewriteMergeNodes(spice);
    }

    // Instruments.
    if (plan) {
      // Settings are keyed by the stored name, not the shown reference.
      const props = sheet.instruments.get(localName) ?? {};
      const number = (key: string, value: string | undefined) => {
        const parsed = value === undefined ? NaN : parseFloat(value);
        if (Number.isFinite(parsed)) params[key] = String(parsed);
      };
      if (plan.kind === "function-generator") {
        const negative = pins.find((p) => p.name === "neg");
        if (negative?.net !== undefined) {
          ctx.issues.push({ severity: "info", refDes, message: "Instrument: function generator uses its negative terminal, so it is imported as its stored SPICE model rather than as an Ohmlet instrument." });
        } else {
          instrument = plan.kind;
          params.shape = { "0": "sine", "1": "triangle", "2": "square" }[props.WAVE_MODE ?? "0"] ?? "sine";
          params.freq = String(parseFloat(props.FREQUENCY_VALUE ?? "1000"));
          params.amp = String(parseFloat(props.AMPLITUDE_VALUE ?? "1"));
          params.offset = String(parseFloat(props.OFFSET_VALUE ?? "0"));
          params.duty = String(parseFloat(props.DEPUTY_CYCLE_VALUE ?? "50"));
        }
      } else if (plan.kind === "multimeter") {
        instrument = plan.kind;
        params.mode = { "0": "amps", "1": "volts", "2": "ohms" }[props.MEASUREMENT_MODE ?? "1"] ?? "volts";
      } else if (plan.kind === "oscilloscope") {
        instrument = plan.kind;
        number("timePerDiv", props.TIMEBASE_SCALE_VALUE);
        number("voltsPerDivA", props.A_CHANNEL_SCALE_VALUE);
        number("voltsPerDivB", props.B_CHANNEL_SCALE_VALUE);
        number("positionA", props.A_CHANNEL_POSITION_VALUE);
        number("positionB", props.B_CHANNEL_POSITION_VALUE);
        number("triggerLevel", props.TRIGGERBASE_TRIGGERLEVEL);
      } else if (plan.kind === "bode-plotter") {
        instrument = plan.kind;
        number("fstart", props.HORZ_INITIAL_VALUE);
        number("fstop", props.HORZ_FINAL_VALUE);
      } else if (plan.kind) {
        instrument = plan.kind;
      } else if (spice) {
        ctx.issues.push({ severity: "info", refDes, message: `Instrument: ${identity[3] || localName} has no Ohmlet equivalent; it is imported as its stored SPICE model, which keeps the circuit intact.` });
      } else {
        instrument = "unsupported";
        ctx.issues.push({ severity: "warning", refDes, message: `Instrument: ${identity[3] || localName} has no Ohmlet equivalent and does not take part in the simulation.` });
      }
    }

    const model = modelOf(sheet, node.attrs.Model);
    if (model && MERGE_TO_GROUND.test(model.text)) {
      // This part only ties its pin to ground, which the net name already does.
      spice = "";
    } else if (spice) {
      useModels(ctx, spice);
    } else if (template.trim() && !plan && !isInstance) {
      count(ctx, "script-only part");
    }

    if (template.indexOf("!!!BEGIN-INTERACT") >= 0) {
      ctx.issues.push({ severity: "info", refDes, message: "Interactive: the part's on-screen behaviour script was dropped." });
    }

    const graphics = drawing.prims.map((prim: Prim) => primToGraphic(prim, place));
    const displayValue = (() => {
      for (const child2 of kids(child(symbolNode, "Objects"))) {
        if (child2.attrs.Class === "CIITSymTextCompValue") {
          const text = displayText(textValue(child2.children[0]?.attrs.Output)).trim();
          if (text) return text;
        }
      }
      return undefined;
    })();

    if (isGroundSymbol || (model && MERGE_TO_GROUND.test(model.text))) ctx.groundParts.add(componentId);

    const component: SchComponent = {
      id: componentId,
      refDes: shownRef,
      kind: "imported",
      x: place.x,
      y: place.y,
      rotation,
      mirrored,
      params,
      pins,
      spice,
    };
    if (graphics.length) component.graphics = graphics;
    if (displayValue) component.displayValue = displayValue;
    if (instrument) component.instrument = instrument;
    const family = familyOf(spice);
    if (family) {
      component.family = family.family;
      component.valueKey = family.valueKey;
    }
    if (interactive?.spec && spice) {
      component.interactive = interactive.spec;
      // Draw every state, so the app can show the one a switch moves to.
      if (interactive.spec.kind === "switch" && symbol && classOf(symbol) === "CIITAnimationSymbolComp") {
        const states: typeof graphics[] = [];
        for (let state = 0; state < interactive.spec.positions; state++) {
          const each = newDrawing(state);
          drawObject(each, symbol, IDENTITY);
          states.push(each.prims.map((prim: Prim) => primToGraphic(prim, place)));
        }
        interactive.spec.stateGraphics = states;
        component.graphics = states[interactive.spec.position];
      }
    }
    if (template.includes("!!!END-INTERACT") && spice) {
      const indicator = indicatorOf({ template: interactive?.template ?? template, parameters, strings, state: 0 }, pins.map((p) => p.name));
      if (indicator) component.indicator = indicator;
    }
    if (classOf(symbol ?? item) === "CIITIMeterSymbolComp" && spice) {
      const clamp = drawing.prims.find((prim) => prim.kind === "ellipse");
      if (clamp?.kind === "ellipse") bucket.probes.push({ component, at: { x: clamp.cx, y: clamp.cy }, direction: symbolNode?.attrs.Direction ?? "" });
    }
    const labels = labelsFor(template, params, spice);
    if (Object.keys(labels).length) component.paramLabels = labels;
    bucket.components.push(component);
    const worldBounds = addBounds(bounds, { minX: center.x, minY: center.y, maxX: center.x, maxY: center.y });
    bucket.bounds = addBounds(bucket.bounds, worldBounds);

    if (isInstance) {
      const block = child(symbolNode, "HierBlock")?.children[0];
      const nets = new Map<string, string>();
      for (const port of ports) if (port.net !== undefined) nets.set(port.stored, port.net);
      const title = textValue(block?.attrs.FileName);
      instances.push({ sheetTitle: title, ref: sanitize(shownRef || localName) + (suffix ? `_${suffix}` : ""), nets });
    }
  }

  // Sheet-level drawing goes on one pin-less part, kept apart from the wires so buses cannot short nets.
  if (art.prims.length) {
    const bounds = boundsOf(art.prims, [])!;
    const place: Placement = { x: Math.round(bounds.minX), y: Math.round(bounds.minY), rotation: 0, mirrored: false };
    bucket.components.push({
      id: `c${ctx.nextId++}`,
      refDes: "",
      kind: "imported",
      x: place.x,
      y: place.y,
      rotation: 0,
      mirrored: false,
      params: {},
      pins: [],
      spice: "",
      graphics: art.prims.map((prim) => primToGraphic(prim, place)),
    });
    bucket.bounds = addBounds(bucket.bounds, bounds);
  }

  for (const instance of instances) {
    const inner = ctx.sheetsByTitle.get(instance.sheetTitle);
    if (!inner) {
      ctx.issues.push({ severity: "error", refDes: instance.ref, message: `Hierarchy: block ${instance.sheetTitle || "(unnamed)"} refers to a sheet that is not in this file, so its contents are missing.` });
      continue;
    }
    if (depth >= MAX_DEPTH) {
      ctx.issues.push({ severity: "error", refDes: instance.ref, message: `Hierarchy: nesting is deeper than ${MAX_DEPTH} levels; block ${instance.sheetTitle} was not expanded.` });
      continue;
    }
    ctx.instanced.add(inner);
    ctx.issues.push({ severity: "info", refDes: instance.ref, message: `Hierarchy: block ${instance.sheetTitle} was flattened and placed below the main sheet.` });
    const parts2 = flattenSheet(ctx, inner, instance.ref, instance.nets, depth + 1);
    if (parts2[0]) {
      const at = parts2[0].bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      parts2[0].texts.push({ id: `t${ctx.nextId++}`, x: at.minX, y: at.minY - 20, text: `${instance.ref}: ${instance.sheetTitle}` });
      parts2[0].bounds = addBounds(at, { minX: at.minX, minY: at.minY - 30, maxX: at.minX, maxY: at.minY - 30 });
    }
    buckets.push(...parts2);
  }
  return buckets;
}

/**
 * A wire may pass over a pin it does not connect to. The file keeps them apart by net, but the
 * netlister joins by geometry, so such a wire steps around the pin by one unit.
 */
function stepAroundPins(bucket: Bucket): number {
  const rows = new Map<number, { x: number; net?: string }[]>();
  const columns = new Map<number, { y: number; net?: string }[]>();
  for (const comp of bucket.components) {
    for (const pin of comp.pins) {
      const at = pinWorld(comp, pin);
      const row = rows.get(at.y);
      if (row) row.push({ x: at.x, net: pin.net });
      else rows.set(at.y, [{ x: at.x, net: pin.net }]);
      const column = columns.get(at.x);
      if (column) column.push({ y: at.y, net: pin.net });
      else columns.set(at.x, [{ y: at.y, net: pin.net }]);
    }
  }
  let moved = 0;
  for (const wire of bucket.wires) {
    const net = bucket.wireNets.get(wire.id);
    if (net === undefined) continue;
    const out: Point[] = [wire.points[0]];
    for (let i = 1; i < wire.points.length; i++) {
      const a = wire.points[i - 1];
      const b = wire.points[i];
      if (a.y === b.y) {
        const dir = Math.sign(b.x - a.x);
        const hits = (rows.get(a.y) ?? [])
          .filter((p) => p.net !== net && p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x))
          .map((p) => p.x)
          .sort((p, q) => (p - q) * dir);
        for (const x of hits) {
          out.push({ x: x - dir, y: a.y }, { x: x - dir, y: a.y + 1 }, { x: x + dir, y: a.y + 1 }, { x: x + dir, y: a.y });
          moved++;
        }
      } else if (a.x === b.x) {
        const dir = Math.sign(b.y - a.y);
        const hits = (columns.get(a.x) ?? [])
          .filter((p) => p.net !== net && p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y))
          .map((p) => p.y)
          .sort((p, q) => (p - q) * dir);
        for (const y of hits) {
          out.push({ x: a.x, y: y - dir }, { x: a.x + 1, y: y - dir }, { x: a.x + 1, y: y + dir }, { x: a.x, y: y + dir });
          moved++;
        }
      }
      out.push(b);
    }
    if (out.length !== wire.points.length) wire.points = out;
  }
  return moved;
}

/**
 * Places the labels for net names the file shows. A label joins whatever passes through its point,
 * so it goes where nothing of another net does: mid-wire when possible, at the wire's end otherwise.
 */
function placeShownNets(ctx: Context, bucket: Bucket): void {
  const others: { net?: string; a: Point; b: Point }[] = [];
  for (const wire of bucket.wires) {
    for (let i = 1; i < wire.points.length; i++) others.push({ net: bucket.wireNets.get(wire.id), a: wire.points[i - 1], b: wire.points[i] });
  }
  for (const comp of bucket.components) {
    for (const pin of comp.pins) {
      const at = pinWorld(comp, pin);
      others.push({ net: pin.net, a: at, b: at });
    }
  }
  const near = (p: Point, a: Point, b: Point) => {
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    return Math.abs(cross) <= 0.5 && p.x >= Math.min(a.x, b.x) - 1 && p.x <= Math.max(a.x, b.x) + 1 && p.y >= Math.min(a.y, b.y) - 1 && p.y <= Math.max(a.y, b.y) + 1;
  };
  for (const wire of bucket.shownNets) {
    const net = bucket.wireNets.get(wire.id)!;
    const candidates: Point[] = [];
    const segments = wire.points.slice(1).map((b, i) => ({ a: wire.points[i], b }));
    segments.sort((p, q) => Math.abs(q.a.x - q.b.x) + Math.abs(q.a.y - q.b.y) - Math.abs(p.a.x - p.b.x) - Math.abs(p.a.y - p.b.y));
    for (const { a, b } of segments) {
      for (const f of [0.5, 0.25, 0.75, 0.125, 0.875]) {
        candidates.push({ x: Math.round(a.x + (b.x - a.x) * f), y: Math.round(a.y + (b.y - a.y) * f) });
      }
    }
    const clear = candidates.find((p) => segments.some(({ a, b }) => near(p, a, b)) && !others.some((o) => o.net !== net && near(p, o.a, o.b)));
    const at = clear ?? wire.points[0];
    bucket.labels.push({ id: `l${ctx.nextId++}`, x: at.x, y: at.y, net });
  }
}

/**
 * Puts a current probe in series with the wire it is clamped on. The file leaves the probe's sense
 * pins open and splits the wire at the clamp, so the two wires are parted there and the probe's pins
 * land on the new ends. One side then becomes a net of its own.
 */
function insertProbe(ctx: Context, bucket: Bucket, probe: Probe): boolean {
  const { component, at } = probe;
  const name = component.refDes || component.id;
  const fail = (why: string) => {
    ctx.issues.push({ severity: "warning", refDes: name, message: `Instrument: this current probe reads 0, because ${why}.` });
    return false;
  };
  const ends: { wire: Wire; index: number; dx: number; dy: number }[] = [];
  for (const wire of bucket.wires) {
    const last = wire.points.length - 1;
    for (const [index, inward] of [[0, 1], [last, last - 1]] as const) {
      const p = wire.points[index];
      if (Math.abs(p.x - at.x) > 0.5 || Math.abs(p.y - at.y) > 0.5) continue;
      const q = wire.points[inward];
      ends.push({ wire, index, dx: Math.sign(q.x - p.x), dy: Math.sign(q.y - p.y) });
    }
  }
  if (ends.length !== 2) return fail(`${ends.length} wires end at its clamp where two were expected`);
  const netName = bucket.wireNets.get(ends[0].wire.id);
  if (netName === undefined || netName !== bucket.wireNets.get(ends[1].wire.id)) return fail("the wires at its clamp are on different nets");

  // Current runs with the stored arrow, so the upstream wire leaves the clamp against it.
  const arrow = { "1": [0, -1], "3": [1, 0], "5": [0, 1], "7": [-1, 0] }[probe.direction];
  if (!arrow) return fail(`its direction (${probe.direction}) is not understood`);
  // At a corner only one wire runs along the arrow, which settles the other.
  const along = ends.find((e) => e.dx === arrow[0] && e.dy === arrow[1]);
  const against = ends.find((e) => e !== along && e.dx === -arrow[0] && e.dy === -arrow[1]);
  const upstream = against ?? ends.find((e) => e !== along);
  const downstream = along ?? ends.find((e) => e !== against);
  if (!upstream || !downstream || upstream === downstream || (!along && !against)) return fail("the clamped wire does not run along its arrow");

  // Pull the ends apart under the probe's ring.
  const GAP = 3;
  const move = (e: typeof ends[number]) => {
    const original = e.wire.points[e.index];
    const moved = { x: original.x + e.dx * GAP, y: original.y + e.dy * GAP };
    e.wire.points[e.index] = moved;
    return { original, moved };
  };
  const a = move(upstream);
  const b = move(downstream);
  const restore = () => {
    upstream.wire.points[upstream.index] = a.original;
    downstream.wire.points[downstream.index] = b.original;
  };
  const geometry = geometryOf(bucket);
  const rootA = geometry.find(`wire:${upstream.wire.id}`);
  const rootB = geometry.find(`wire:${downstream.wire.id}`);
  if (rootA === rootB) {
    restore();
    return fail("its wire is part of a loop, so the two sides are one net");
  }
  // A side with a connector or ground on it must keep the net's name, which reaches elsewhere.
  const side = (root: string) => {
    const pins: { pin: Pin; comp: SchComponent }[] = [];
    for (const comp of bucket.components) {
      for (const pin of comp.pins) {
        if (pin.net === netName && comp !== component && geometry.find(`${comp.id}/${pin.name}`) === root) pins.push({ pin, comp });
      }
    }
    return pins;
  };
  const pinsA = side(rootA);
  const pinsB = side(rootB);
  const anchored = (pins: typeof pinsA) => pins.some(({ comp }) => !comp.spice);
  if (anchored(pinsA) && anchored(pinsB)) {
    restore();
    return fail("both sides of its wire reach the same net another way");
  }
  const renameA = anchored(pinsB);
  const renamed = renameA ? pinsA : pinsB;
  const renamedRoot = renameA ? rootA : rootB;
  const newNet = uniqueNet(ctx, `probe:${component.id}`, `${netName}_${name}`);
  for (const { pin } of renamed) pin.net = newNet;
  for (const wire of bucket.wires) {
    if (bucket.wireNets.get(wire.id) === netName && geometry.find(`wire:${wire.id}`) === renamedRoot) bucket.wireNets.set(wire.id, newNet);
  }
  // Current entering pin 1 and leaving pin 2 reads positive in the probe's stored model.
  const place: Placement = { x: component.x, y: component.y, rotation: component.rotation, mirrored: component.mirrored };
  const senseIn = component.pins.find((p) => p.name === "1");
  const senseOut = component.pins.find((p) => p.name === "2");
  if (!senseIn || !senseOut) {
    restore();
    return fail("its sense pins are missing");
  }
  Object.assign(senseIn, toLocal(a.moved, place), { net: renameA ? newNet : netName });
  Object.assign(senseOut, toLocal(b.moved, place), { net: renameA ? netName : newNet });
  return true;
}

/** Marks parts other parts refer to by name, and points coupling lines at the parts' final names. */
function lockReferencedParts(components: SchComponent[], ctx: Context, analyses: AnalysisRequest[]): void {
  const deviceOf = new Map<string, SchComponent>();
  const nameOf = (comp: SchComponent) => {
    const first = comp.spice.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("*")) ?? "";
    return first.trim().split(/\s+/)[0].replace(/\{ref\}/g, comp.refDes || `P_${comp.id}`).toLowerCase();
  };
  for (const comp of components) {
    if (comp.spice.includes("{ref}")) deviceOf.set(nameOf(comp), comp);
  }
  const refer = (word: string, from?: SchComponent): string | undefined => {
    const key = word.toLowerCase();
    let target = deviceOf.get(key);
    const device = ctx.devices.get(key);
    if (!target && device) target = deviceOf.get(device.toLowerCase());
    if (target && target !== from) target.lockedName = true;
    return target && device && !deviceOf.has(key) ? device : undefined;
  };
  for (const comp of components) {
    if (!comp.spice) continue;
    let depth = 0;
    const lines = comp.spice.split("\n").map((line) => {
      const text = line.trim();
      if (/^\.subckt\b/i.test(text)) depth++;
      else if (/^\.ends\b/i.test(text)) depth--;
      for (const m of line.matchAll(/\bi\(\s*([^(),\s]+)\s*\)/gi)) {
        if (depth === 0) refer(m[1], comp);
      }
      if (depth !== 0) return line;
      const tokens = text.split(/\s+/);
      const positions = /^k/i.test(text) ? [1, 2] : /^[fh]/i.test(text) ? [3] : [];
      let out = line;
      for (const position of positions) {
        const word = tokens[position];
        if (!word) continue;
        const renamed = refer(word, comp);
        if (renamed) out = out.replace(word, renamed);
      }
      return out;
    });
    comp.spice = lines.join("\n");
  }
  for (const analysis of analyses) {
    if (analysis.type === "dc") refer(analysis.source);
  }
}

function shift(bucket: Bucket, dy: number): void {
  for (const c of bucket.components) c.y += dy;
  for (const w of bucket.wires) for (const p of w.points) p.y += dy;
  for (const l of bucket.labels) l.y += dy;
  for (const t of bucket.texts) t.y += dy;
}

/** Keeps one copy of a supply source that repeats on the same net with the same value. */
function dedupeSupplies(components: SchComponent[], issues: ImportIssue[]): void {
  const seen = new Map<string, SchComponent>();
  for (const comp of components) {
    if (!/^V\S*\{ref\}\s+\{pin:[^}]+\}\s+0\s+dc\s+\{param:p0\}\s*$/i.test(comp.spice)) continue;
    const net = comp.pins[0]?.net;
    if (net === undefined) continue;
    const previous = seen.get(net);
    if (!previous) {
      seen.set(net, comp);
    } else if (previous.params.p0 === comp.params.p0) {
      comp.spice = "";
      comp.params = {};
      issues.push({ severity: "info", refDes: comp.refDes, message: `Power: repeats supply ${previous.refDes || previous.id} on net ${net}; only one source is simulated.` });
    } else {
      issues.push({ severity: "warning", refDes: comp.refDes, message: `Power: supply on net ${net} has value ${comp.params.p0}, but ${previous.refDes} has ${previous.params.p0}. Both are kept, which SPICE treats as a short.` });
    }
  }
}

/** Co-simulation drivers read live data that does not exist here, so they contribute nothing. */
function stripDynamicSources(text: string, issues: ImportIssue[]): string {
  if (!/pwldynamic\s*\(/i.test(text)) return text;
  issues.push({ severity: "warning", message: "Model: a live data source (pwldynamic) was removed from a stored model; its output stays at its DC value." });
  return text.replace(/pwldynamic\s*\([^)]*\)/gi, "");
}

/**
 * Adds a model's text, emitting each top-level .subckt or .model once. Several stored models can
 * carry copies of the same helper definition.
 */
function addDefinitionBlocks(text: string, seen: Map<string, string>, out: string[], issues: ImportIssue[]): void {
  const lines = text.trim().split("\n");
  let i = 0;
  const flush = (key: string, block: string[]) => {
    const body = block.join("\n");
    const normal = body.replace(/\s+/g, " ").trim().toLowerCase();
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, normal);
      out.push(body);
    } else if (previous !== normal) {
      issues.push({ severity: "warning", message: `Model: ${key.split(" ")[1]} has two different definitions in the file; the first is used.` });
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const subckt = /^\s*\.subckt\s+(\S+)/i.exec(line);
    const model = /^\s*\.model\s+(\S+)/i.exec(line);
    if (subckt) {
      const start = i;
      let depth = 0;
      for (; i < lines.length; i++) {
        if (/^\s*\.subckt\b/i.test(lines[i])) depth++;
        else if (/^\s*\.ends\b/i.test(lines[i]) && --depth === 0) {
          i++;
          break;
        }
      }
      flush(`subckt ${subckt[1].toLowerCase()}`, lines.slice(start, i));
    } else if (model) {
      const start = i++;
      while (i < lines.length && /^\s*\+/.test(lines[i])) i++;
      flush(`model ${model[1].toLowerCase()}`, lines.slice(start, i));
    } else {
      if (line.trim()) out.push(line);
      i++;
    }
  }
}

function circuitParameters(project: XmlNode, issues: ImportIssue[]): string[] {
  const lines: string[] = [];
  const known = new Map<string, string>();
  walk(project, (node) => {
    if (node.attrs.Class !== "CCircuitParamSheetGroupExtension") return;
    const names: string[] = [];
    const values: string[] = [];
    let lists = 0;
    walk(node, (inner) => {
      if (inner.tag === "CircuitParamName") names.push(singleLine(textValue(inner.attrs.NameItem)));
      else if (inner.tag === "CircuitParamValueList") lists++;
      else if (inner.tag === "CircuitParamValue" && lists === 1) values.push(textValue(inner.attrs.ValueItem));
    });
    names.forEach((name, i) => {
      const value = singleLine(values[i] ?? "");
      if (!name || !value) return;
      const key = name.toLowerCase();
      const previous = known.get(key);
      if (previous === undefined) {
        known.set(key, value);
        lines.push(`.param ${name}=${/^[-+]?[\d.]/.test(value) && !/[*/()]/.test(value) ? value : `{${value}}`}`);
      } else if (previous !== value) {
        issues.push({ severity: "warning", message: `Parameters: ${name} is defined differently on several sheets; the first value (${previous}) is used everywhere.` });
      }
    });
  });
  return lines;
}

const OBJECT_NOTES: Record<string, string> = {
  CIITTitleBlock: "title blocks",
  CIITProbeExtComponent: "measurement probes",
  CIITIMeterSymbolComp: "current meters drawn on wires",
  CCPLegendComp: "legends",
  CODBitmapComp: "bitmaps",
  CODGraphicBoxComp: "picture boxes",
};

/** Imports a circuit file. Throws an Error on corrupt input; everything else becomes an issue. */
export function importMs14(bytes: Uint8Array): ImportResult {
  return importDetailed(bytes).result;
}

const OWN_ERROR = /^(Corrupt circuit file|Not a Multisim circuit file|Circuit is too large)/;

/** Any failure comes back as a clear message, whatever a damaged file manages to break. */
export function importDetailed(bytes: Uint8Array): { result: ImportResult; fileNets: FileNets } {
  try {
    return importUnchecked(bytes);
  } catch (error) {
    if (error instanceof Error && OWN_ERROR.test(error.message)) throw error;
    throw new Error(`Corrupt circuit file: its contents could not be read (${error instanceof Error ? error.message : String(error)}).`);
  }
}

/** The import along with the nets the file states, which the result no longer spells out on most pins. */
function importUnchecked(bytes: Uint8Array): { result: ImportResult; fileNets: FileNets } {
  const xmlBytes = decodeContainer(bytes);
  const root = parseXml(bytesToText(xmlBytes));
  if (root.tag !== "MSMElectronicsWorkbench") throw new Error(`Not a Multisim circuit file: root element is <${root.tag}>.`);
  const project = child(root, "Project");
  if (!project) throw new Error("Corrupt circuit file: no project element.");

  const issues: ImportIssue[] = [];
  const ctx: Context = {
    sheetsByTitle: new Map(),
    shownRefs: loadReferenceNames(project),
    heldPins: new Set(),
    groundParts: new Set(),
    issues,
    refs: new Set(),
    nets: new Map(),
    devices: new Map(),
    models: new Map(),
    usedModels: new Map(),
    counts: new Map(),
    nextId: 1,
    componentCount: 0,
    instanced: new Set(),
  };

  const sheets: Sheet[] = [];
  for (const container of kids(path(project, "UniqueSheets", "SheetInfos"))) {
    const sheet = loadSheet(container);
    if (sheet) {
      sheets.push(sheet);
      if (!ctx.sheetsByTitle.has(sheet.title)) ctx.sheetsByTitle.set(sheet.title, sheet);
      continue;
    }
    const docType = textValue(path(container, "Sheet", "Variable", "DesignSheet")?.attrs.DocType);
    if (docType === "DESCRIPTIONBOX") count(ctx, "description sheet");
    else if (docType) issues.push({ severity: "warning", message: `Sheet: ${docType} sheet was not imported.` });
  }

  const variants = new Set<string>();
  let faults = 0;
  walk(project, (node) => {
    if (node.tag === "VariantNames" && node.attrs.VariantName) variants.add(textValue(node.attrs.VariantName));
    else if (node.attrs.Class === "CiaFault" && node.attrs.FaultType !== "3") faults++;
  });
  if (variants.size > 1) issues.push({ severity: "warning", message: `Sheet: the file defines ${variants.size} assembly variants; parts from all of them are imported.` });
  if (faults) issues.push({ severity: "warning", message: `Model: ${faults} part(s) have an injected fault, which was not imported.` });

  const name = singleLine(textValue(project.attrs.Name)) || "Imported circuit";
  const format = {
    schema: root.attrs.Schema ?? "",
    application: textValue(project.attrs.AppName),
    version: textValue(project.attrs.AppVersion) || textValue(project.attrs.ProgramVersion),
  };

  const buckets: Bucket[] = [];
  const referenced = new Set<string>();
  for (const sheet of sheets) {
    for (const item of sheet.objects) {
      const block = child(item.children[0], "HierBlock")?.children[0];
      if (block) referenced.add(textValue(block.attrs.FileName));
    }
  }
  const tops = sheets.filter((sheet) => !referenced.has(sheet.title));
  if (sheets.length && !tops.length) tops.push(sheets[0]);
  tops.forEach((sheet, index) => {
    if (index > 0) {
      issues.push({ severity: "warning", message: `Sheet: ${sheet.title} is not used by any block; it was imported separately, and its nets are not joined to the main sheet.` });
    }
    buckets.push(...flattenSheet(ctx, sheet, index === 0 ? "" : sanitize(sheet.title), new Map(), 0));
  });

  let probesPlaced = 0;
  for (const bucket of buckets) {
    for (const probe of bucket.probes) if (insertProbe(ctx, bucket, probe)) probesPlaced++;
  }
  if (probesPlaced) issues.push({ severity: "info", message: `Instrument: ${probesPlaced} current probe(s) were put in series with the wire they clamp.` });

  const moved = buckets.reduce((sum, bucket) => sum + stepAroundPins(bucket), 0);
  if (moved) issues.push({ severity: "info", message: `Drawing: ${moved} wire(s) pass over a pin they do not join in the file; each now steps around that pin.` });

  for (const bucket of buckets) placeShownNets(ctx, bucket);

  // Separate sheets vertically: pins that merely coincide would otherwise be joined by the netlister.
  let cursor = buckets[0]?.bounds?.maxY ?? 0;
  for (let i = 1; i < buckets.length; i++) {
    const bounds = buckets[i].bounds;
    const dy = cursor + SHEET_GAP - (bounds?.minY ?? 0);
    shift(buckets[i], dy);
    cursor = (bounds?.maxY ?? 0) + dy;
  }

  const components = buckets.flatMap((b) => b.components);
  const wires = buckets.flatMap((b) => b.wires);
  const labels = buckets.flatMap((b) => b.labels);
  const texts = buckets.flatMap((b) => b.texts);

  dedupeSupplies(components, issues);
  const fileNets = bindConnectivity({ components, wires, labels }, ctx.heldPins, ctx.groundParts, () => `l${ctx.nextId++}`, issues);

  // Definitions: circuit parameters first, then each referenced model once.
  const definitionLines = circuitParameters(project, issues);
  if (definitionLines.length) issues.push({ severity: "info", message: `Parameters: ${definitionLines.length} circuit parameter(s) were imported as .param lines.` });
  let merged = false;
  const blocks = new Map<string, string>();
  for (const model of ctx.usedModels.values()) {
    const rewritten = rewriteMergeNodes(model.text);
    if (rewritten !== model.text) merged = true;
    addDefinitionBlocks(stripDynamicSources(rewritten, issues), blocks, definitionLines, issues);
  }
  if (merged) issues.push({ severity: "info", message: "Model: .mergenodes in stored models became 1 microhm resistors." });
  const usedMerge = components.some((c) => c.spice.includes("Rmerge_"));
  if (usedMerge && !merged) issues.push({ severity: "info", message: "Model: .mergenodes in part templates became 1 microhm resistors." });

  if (!components.some((c) => c.pins.length > 0)) {
    issues.push({ severity: "warning", message: "Sheet: the file holds no components." });
  }
  const digital = components.filter((c) => /^a/im.test(c.spice)).length;
  if (digital) issues.push({ severity: "warning", message: `Digital: ${digital} part(s) use XSPICE code models, emitted as stored.` });
  const unconnected = components.reduce((sum, c) => sum + (c.spice ? c.pins.filter((p) => p.net === undefined).length : 0), 0);
  if (unconnected) issues.push({ severity: "info", message: `Connectivity: ${unconnected} pin(s) of simulated parts are unconnected in the file.` });

  for (const [key, n] of ctx.counts) {
    const label = OBJECT_NOTES[key];
    if (label) issues.push({ severity: "info", message: `Drawing: ${n} ${label} not imported.` });
    else if (key === "script-only part") issues.push({ severity: "info", message: `Interactive: ${n} part(s) have only a behaviour script and do not simulate.` });
    else if (key === "description sheet") issues.push({ severity: "info", message: "Sheet: the description sheet was not imported." });
    else if (key === "hidden wire") issues.push({ severity: "info", message: `Drawing: ${n} hidden wire(s) not drawn.` });
    else issues.push({ severity: "info", message: `Drawing: ${n} object(s) of type ${key} not imported.` });
  }

  // Analyses come from the top sheet.
  const simState = tops[0] ? textValue(tops[0].diagram.attrs.SimState) : "";
  let active = "";
  for (const extension of kids(child(project, "Extensions"))) {
    if (extension.attrs.Class === "CMultisimExtension") active = textValue(extension.attrs.ActiveAnalysis);
  }
  let analyses: AnalysisRequest[] = [];
  try {
    analyses = mapAnalyses(simState, active, issues, (source) => ctx.devices.get(source.toLowerCase()));
  } catch (error) {
    issues.push({ severity: "warning", message: `Analyses: could not be read (${String(error)}).` });
  }

  if (format.version && !format.version.startsWith("14.")) {
    issues.push({ severity: "warning", message: `Format: this file was saved by version ${format.version}; only version 14 files have been tested.` });
  }

  lockReferencedParts(components, ctx, analyses);
  const fixedText = components.filter((c) => c.spice && !c.spice.includes("{ref}")).length;
  if (fixedText) issues.push({ severity: "info", message: `Template: ${fixedText} part(s) hold SPICE text with fixed device and net names, so a second copy on the sheet would clash with the first.` });

  return {
    result: {
      schematic: { name, components, wires, labels, texts, definitions: definitionLines.join("\n") },
      analyses,
      issues,
      format,
    },
    fileNets,
  };
}

