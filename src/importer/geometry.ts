// Drawing primitives in sheet coordinates, and their conversion to component-local coordinates.
import type { Graphic, Point } from "../core/schematic";
import { child, kids, textValue, type XmlNode } from "./xml";

export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Reads Transformer-M attributes: (x, y) -> (x*M00 + y*M10 + M20, x*M01 + y*M11 + M21). */
export function matrixOf(node: XmlNode): Matrix {
  const a = node.attrs;
  if (a["Transformer-M00"] === undefined) return IDENTITY;
  return [
    parseFloat(a["Transformer-M00"]), parseFloat(a["Transformer-M01"]),
    parseFloat(a["Transformer-M10"]), parseFloat(a["Transformer-M11"]),
    parseFloat(a["Transformer-M20"]), parseFloat(a["Transformer-M21"]),
  ];
}

/** Applies a first, then b. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const clean = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

/** Sheets are thousands of units across. Beyond this a coordinate can only be corruption. */
const MAX_COORDINATE = 1e7;

export function apply(m: Matrix, x: number, y: number): Point {
  const px = clean(x * m[0] + y * m[2] + m[4]);
  const py = clean(x * m[1] + y * m[3] + m[5]);
  if (!(Math.abs(px) <= MAX_COORDINATE) || !(Math.abs(py) <= MAX_COORDINATE)) {
    throw new Error("Corrupt circuit file: a drawing coordinate is out of range.");
  }
  return { x: px, y: py };
}

export type Prim =
  | { kind: "line"; points: Point[] }
  | { kind: "polygon"; points: Point[]; filled: boolean; rect?: boolean }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; filled: boolean }
  | { kind: "text"; x: number; y: number; text: string; size: number };

export interface PinGeometry {
  name: string;
  at: Point;
}

export interface Drawing {
  prims: Prim[];
  pins: PinGeometry[];
  /** Counts of objects that could not be drawn, by class. */
  lost: Map<string, number>;
  /** Which animation layer to draw, counted as they are met. */
  layerWanted: number;
  layerIndex: number;
}

export function newDrawing(layerWanted = 0): Drawing {
  return { prims: [], pins: [], lost: new Map(), layerWanted, layerIndex: 0 };
}

const num = (v: string | undefined) => parseFloat(v ?? "0") || 0;
/**
 * Graphics carry no colour, so only dark fills are kept. A light fill, such as an instrument's
 * panel, would otherwise turn into a solid block hiding what is drawn on it.
 */
const filled = (node: XmlNode) => {
  if (node.attrs["Brush-Style"] !== "0") return false;
  const color = parseInt(node.attrs.FgColor ?? "0", 10) || 0;
  return 0.3 * (color & 255) + 0.59 * ((color >> 8) & 255) + 0.11 * ((color >> 16) & 255) < 96;
};

function pointsOf(node: XmlNode, m: Matrix): Point[] {
  return kids(child(node, "Points")).map((p) => apply(m, num(p.attrs.X), num(p.attrs.Y)));
}

/** Samples an arc that runs from start through middle to end on an axis-aligned ellipse. */
function arcPoints(node: XmlNode): { x: number; y: number }[] {
  const a = node.attrs;
  const cx = num(a.CenterX);
  const cy = num(a.CenterY);
  const rx = num(a.Radius1) || 1;
  const ry = num(a.Radius2) || 1;
  const angle = (x: string, y: string) => Math.atan2((num(y) - cy) / ry, (num(x) - cx) / rx);
  const start = angle(a.StartX, a.StartY);
  const middle = angle(a.MiddleX, a.MiddleY);
  const stop = angle(a.EndX, a.EndY);
  const TAU = Math.PI * 2;
  const wrap = (v: number) => ((v % TAU) + TAU) % TAU;
  // Go in whichever direction passes through the middle point.
  const forward = wrap(middle - start) <= wrap(stop - start);
  const raw = forward ? wrap(stop - start) : -wrap(start - stop);
  const sweep = raw === 0 ? TAU : raw;
  const steps = Math.max(4, Math.min(48, Math.ceil(Math.abs(sweep) / (Math.PI / 12))));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return out;
}

function addEllipse(d: Drawing, node: XmlNode, m: Matrix): void {
  const a = node.attrs;
  const cx = num(a.CenterX);
  const cy = num(a.CenterY);
  const r1 = num(a.Radius1);
  const r2 = num(a.Radius2);
  const c = apply(m, cx, cy);
  const eps = 1e-3;
  if (Math.abs(m[1]) < eps && Math.abs(m[2]) < eps) {
    // Files can store negative radii.
    d.prims.push({ kind: "ellipse", cx: c.x, cy: c.y, rx: clean(Math.abs(r1 * m[0])), ry: clean(Math.abs(r2 * m[3])), filled: filled(node) });
  } else if (Math.abs(m[0]) < eps && Math.abs(m[3]) < eps) {
    d.prims.push({ kind: "ellipse", cx: c.x, cy: c.y, rx: clean(Math.abs(r2 * m[2])), ry: clean(Math.abs(r1 * m[1])), filled: filled(node) });
  } else {
    const points: Point[] = [];
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * Math.PI * 2;
      points.push(apply(m, cx + r1 * Math.cos(t), cy + r2 * Math.sin(t)));
    }
    d.prims.push({ kind: "polygon", points, filled: filled(node) });
  }
}

function addText(d: Drawing, node: XmlNode, m: Matrix, value: string): void {
  const text = value.trim();
  if (!text) return;
  // The stored position is the top-left of the text box; Microsim draws from the baseline.
  const size = Math.abs(num(node.attrs["Font-Height"])) || 10;
  const at = apply(m, 0, 0);
  d.prims.push({ kind: "text", x: at.x, y: clean(at.y + size * 0.8), text, size });
}

const lose = (d: Drawing, name: string) => d.lost.set(name, (d.lost.get(name) ?? 0) + 1);

/** Adds one drawing object, recursing into containers. parent maps its space to the sheet. */
export function drawObject(d: Drawing, item: XmlNode, parent: Matrix): void {
  const node = item.children[0];
  if (!node) return;
  const cls = item.attrs.Class ?? node.attrs.Class;
  if (node.attrs.Hidden === "1") return;
  const m = multiply(matrixOf(node), parent);
  const a = node.attrs;
  switch (cls) {
    case "CODLineComp":
      d.prims.push({ kind: "line", points: [apply(m, num(a.pt0X), num(a.pt0Y)), apply(m, num(a.pt1X), num(a.pt1Y))] });
      break;
    case "CODRectComp": {
      const x0 = num(a.pt0X);
      const y0 = num(a.pt0Y);
      const x1 = num(a.pt1X);
      const y1 = num(a.pt1Y);
      const points = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
      d.prims.push({ kind: "polygon", points, filled: filled(node), rect: true });
      break;
    }
    case "CODPolygonComp": {
      const points = pointsOf(node, m);
      if (points.length) d.prims.push({ kind: "polygon", points, filled: filled(node) });
      break;
    }
    case "CODMultiLineComp":
    case "CIITBusCompV8": {
      const points = pointsOf(node, m);
      if (points.length) d.prims.push({ kind: "line", points });
      break;
    }
    case "CIITBusEntry": {
      const points = pointsOf(node, m);
      if (points.length) d.prims.push({ kind: "line", points });
      else if (a.pt0X !== undefined) d.prims.push({ kind: "line", points: [apply(m, num(a.pt0X), num(a.pt0Y)), apply(m, num(a.pt1X), num(a.pt1Y))] });
      break;
    }
    case "CODEllipseComp":
      addEllipse(d, node, m);
      break;
    case "CIITArcComp":
      d.prims.push({ kind: "line", points: arcPoints(node).map((p) => apply(m, p.x, p.y)) });
      break;
    case "CODTextComp":
    case "CIITVariableSymText":
    case "CIITTextCompWithID":
    case "CIITBusName":
      addText(d, node, m, textValue(a.Output));
      break;
    case "CIITPinSymbolComp": {
      const name = textValue(a.PinName);
      for (const inner of kids(child(node, "Objects"))) {
        const innerNode = inner.children[0];
        if (!innerNode) continue;
        const innerClass = inner.attrs.Class ?? innerNode.attrs.Class;
        if (innerClass === "CIITPinConnectorComp") {
          const pm = multiply(matrixOf(innerNode), m);
          d.pins.push({ name, at: apply(pm, num(innerNode.attrs.ptCenterX), num(innerNode.attrs.ptCenterY)) });
        } else if (innerClass === "CIITPinSymTextCompName") {
          if (a.ShowName === "1") addText(d, innerNode, multiply(matrixOf(innerNode), m), name);
        } else if (innerClass === "CIITPinSymTextCompNumber") {
          const number = textValue(a.PinNumber);
          if (a.ShowNumber === "1" && number !== "##") addText(d, innerNode, multiply(matrixOf(innerNode), m), number);
        } else {
          drawObject(d, inner, m);
        }
      }
      break;
    }
    case "CIITAnimationLayerComp":
      // The layers are alternative states of the part; the saved state picks one.
      if (d.layerIndex++ === d.layerWanted) drawChildren(d, node, m);
      break;
    case "CIITSymTextCompName":
    case "CIITSymTextCompValue":
    case "CIITSymTextCompLocation":
    case "CIITTextCompAnimationLayerName":
    case "CIITSymbolBorderRect":
    case "CODPinComp":
      break;
    case "CODBitmapComp":
    case "CODGraphicBoxComp":
      lose(d, cls);
      break;
    default:
      if (child(node, "Objects")) drawChildren(d, node, m);
      else lose(d, cls ?? node.tag);
  }
}

export function drawChildren(d: Drawing, node: XmlNode, m: Matrix): void {
  for (const item of kids(child(node, "Objects"))) drawObject(d, item, m);
}

export interface Placement {
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
}

/** Decodes OrientationFlip: low bits are quarter turns, 4096 mirrors, 256 flips the other way. */
export function orientationOf(flip: number): { rotation: 0 | 90 | 180 | 270; mirrored: boolean } {
  let quarter = flip & 3;
  const horizontal = (flip & 4096) !== 0;
  const vertical = (flip & 256) !== 0;
  if (vertical) quarter += 2;
  return { rotation: ((quarter % 4) * 90) as 0 | 90 | 180 | 270, mirrored: horizontal !== vertical };
}

/** Inverse of the placement used by pinWorld in core/netlist.ts. */
export function toLocal(p: Point, place: Placement): Point {
  const dx = p.x - place.x;
  const dy = p.y - place.y;
  let x: number;
  let y: number;
  switch (place.rotation) {
    case 90: x = dy; y = -dx; break;
    case 180: x = -dx; y = -dy; break;
    case 270: x = -dy; y = dx; break;
    default: x = dx; y = dy;
  }
  if (place.mirrored) x = -x;
  return { x: clean(x), y: clean(y) };
}

export function primToGraphic(prim: Prim, place: Placement): Graphic {
  switch (prim.kind) {
    case "line":
      return { kind: "line", points: prim.points.map((p) => toLocal(p, place)) };
    case "polygon": {
      const points = prim.points.map((p) => toLocal(p, place));
      if (prim.rect && points.length === 4) {
        const [a, b, c] = points;
        const axisAligned = (a.x === b.x && b.y === c.y) || (a.y === b.y && b.x === c.x);
        if (axisAligned) {
          const x = Math.min(a.x, c.x);
          const y = Math.min(a.y, c.y);
          return { kind: "rect", x, y, w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y), filled: prim.filled };
        }
      }
      return { kind: "polygon", points, filled: prim.filled };
    }
    case "ellipse": {
      const c = toLocal({ x: prim.cx, y: prim.cy }, place);
      const swap = place.rotation === 90 || place.rotation === 270;
      return { kind: "ellipse", cx: c.x, cy: c.y, rx: swap ? prim.ry : prim.rx, ry: swap ? prim.rx : prim.ry, filled: prim.filled };
    }
    case "text": {
      const at = toLocal({ x: prim.x, y: prim.y }, place);
      return { kind: "text", x: at.x, y: at.y, text: prim.text, size: prim.size };
    }
  }
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of sheet-space primitives and pins, or null when there are none. */
export function boundsOf(prims: Prim[], pins: PinGeometry[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const pin of pins) add(pin.at.x, pin.at.y);
  for (const prim of prims) {
    if (prim.kind === "ellipse") {
      add(prim.cx - prim.rx, prim.cy - prim.ry);
      add(prim.cx + prim.rx, prim.cy + prim.ry);
    } else if (prim.kind === "text") {
      add(prim.x, prim.y);
    } else {
      for (const p of prim.points) add(p.x, p.y);
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}
