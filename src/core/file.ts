// The .microsim file format, which .ohmlet files from before the rename also use. Everything is checked before the open document is touched.
import type { Graphic, ImportIssue, Schematic, Wire } from "./schematic";
import type { AnalysisRequest } from "./sim";
import { validateWorkspace } from "./engineering";

export interface CircuitFile {
  schematic: Schematic;
  analyses: AnalysisRequest[];
  issues: ImportIssue[];
}

export function serializeCircuit(file: CircuitFile): string {
  return JSON.stringify({ format: "microsim", version: 1, schematic: file.schematic, analyses: file.analyses, issues: file.issues });
}

class Bad extends Error {}

const LIMIT = 1e5;

const fail = (where: string): never => {
  throw new Bad(`This is not a valid circuit file (${where}).`);
};
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function points(v: unknown, where: string): void {
  if (!Array.isArray(v)) fail(where);
  for (const p of v as unknown[]) if (!isObj(p) || !isNum(p.x) || !isNum(p.y)) fail(where);
}

function graphic(g: unknown): void {
  if (!isObj(g)) fail("symbol");
  const item = g as unknown as Graphic;
  switch (item.kind) {
    case "line":
    case "polygon":
      points(item.points, "symbol");
      break;
    case "rect":
      if (![item.x, item.y, item.w, item.h].every(isNum)) fail("symbol");
      break;
    case "ellipse":
      if (![item.cx, item.cy, item.rx, item.ry].every(isNum)) fail("symbol");
      break;
    case "text":
      if (!isNum(item.x) || !isNum(item.y) || !isStr(item.text) || !isNum(item.size)) fail("symbol");
      break;
    default:
      fail("symbol");
  }
}

function checkSchematic(s: unknown): Schematic {
  if (!isObj(s)) fail("no circuit");
  const doc = s as Record<string, unknown>;
  if (doc.nativeMs14 !== undefined && (!isObj(doc.nativeMs14) || !isStr(doc.nativeMs14.xml) || !isStr(doc.nativeMs14.baseline))) fail("native ms14 data");
  if (doc.workspace !== undefined) validateWorkspace(doc.workspace);
  if (!isStr(doc.name) || !isStr(doc.definitions)) fail("name");
  for (const list of ["components", "wires", "labels", "texts"]) if (!Array.isArray(doc[list])) fail(list);
  for (const c of doc.components as unknown[]) {
    if (!isObj(c) || !isStr(c.id) || !isStr(c.refDes) || !isStr(c.kind) || !isStr(c.spice)) fail("part");
    const comp = c as Record<string, unknown>;
    if (!isNum(comp.x) || !isNum(comp.y) || ![0, 90, 180, 270].includes(comp.rotation as number)) fail("part position");
    if (typeof comp.mirrored !== "boolean" || !isObj(comp.params) || !Array.isArray(comp.pins)) fail("part");
    if (!Object.values(comp.params as object).every(isStr)) fail("part settings");
    for (const raw of comp.pins as unknown[]) {
      if (!isObj(raw)) throw new Bad("This is not a valid circuit file (pin).");
      if (!isStr(raw.name) || !isNum(raw.x) || !isNum(raw.y)) fail("pin");
      if (raw.net !== undefined && !isStr(raw.net)) fail("pin");
    }
    if (comp.graphics !== undefined) {
      if (!Array.isArray(comp.graphics)) fail("symbol");
      (comp.graphics as unknown[]).forEach(graphic);
    }
  }
  for (const w of doc.wires as unknown[]) {
    if (!isObj(w) || !isStr(w.id)) fail("wire");
    const wirePoints = (w as Record<string, unknown>).points;
    points(wirePoints, "wire");
    for (const p of wirePoints as { x: number; y: number }[]) {
      // Far beyond any real sheet. Such coordinates only make wire indexing blow up.
      if (Math.abs(p.x) > LIMIT || Math.abs(p.y) > LIMIT) fail("wire position");
    }
  }
  // Older versions could store a wire with no length, which can't be seen or removed.
  doc.wires = (doc.wires as Wire[]).filter((w) => w.points.some((p) => p.x !== w.points[0].x || p.y !== w.points[0].y));
  for (const l of doc.labels as unknown[]) {
    if (!isObj(l) || !isStr(l.id) || !isNum(l.x) || !isNum(l.y) || !isStr(l.net)) fail("net label");
  }
  for (const t of doc.texts as unknown[]) {
    if (!isObj(t) || !isStr(t.id) || !isNum(t.x) || !isNum(t.y) || !isStr(t.text)) fail("note");
  }
  return s as Schematic;
}

/** Parses and validates a saved circuit, throwing a readable error for anything else. */
export function parseCircuit(text: string): CircuitFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This is not a valid circuit file (not JSON).");
  }
  if (!isObj(data)) fail("not an object");
  const root = data as Record<string, unknown>;
  if (root.format !== undefined && ((root.format !== "microsim" && root.format !== "ohmlet") || !isNum(root.version))) fail("not a Microsim circuit");
  if (isNum(root.version) && root.version > 1) throw new Error("This circuit was saved by a newer version of Microsim.");
  return {
    schematic: checkSchematic(root.format ? root.schematic : root),
    analyses: Array.isArray(root.analyses) ? (root.analyses as AnalysisRequest[]) : [],
    issues: Array.isArray(root.issues) ? (root.issues as ImportIssue[]) : [],
  };
}
