// Schematic workspace: drawing, selection, placement and wiring.
import { newId, route, simplify, type Clipboard, type Doc } from "../core/doc";
import { PART_BY_KIND } from "../core/library";
import { connectivitySignature, pinWorld } from "../core/netlist";
import type { PartDisplay } from "../core/indicators";
import type { Graphic, NetLabel, Point, SchComponent, Wire } from "../core/schematic";

const GRID = 10;
const snap = (v: number) => Math.round(v / GRID) * GRID;

interface Drag {
  kind: "move" | "pan" | "box";
  start: Point;
  last: Point;
  /** Wire endpoints that follow moved pins. */
  stretch?: { wire: Wire; end: "first" | "last"; comp: SchComponent }[];
  moved?: boolean;
  labels?: NetLabel[];
  /** Connections when the drag began, to warn if the move changes them. */
  signature?: string;
}

export class SchematicCanvas {
  readonly el: HTMLCanvasElement;
  selection = new Set<string>();
  onSelectionChange: () => void = () => {};
  onStatus: (text: string) => void = () => {};
  /** Double-click on a part: toggle a switch or open an instrument. */
  onActivate: (comp: SchComponent) => void = () => {};
  /** Value shown beside each net after a simulation, keyed by a pin-world position. */
  probes = new Map<string, string>();
  /** What indicator parts currently show, keyed by component id. */
  displays = new Map<string, PartDisplay>();

  private ox = 400;
  private oy = 300;
  private zoom = 1;
  private placing: string | undefined;
  private annotating: { kind: "label" | "text"; value: string } | undefined;
  private clipboard: Clipboard | undefined;
  private pasteCount = 0;
  private draft: Point[] | undefined;
  private mouse: Point = { x: 0, y: 0 };
  private drag: Drag | undefined;
  private box: { a: Point; b: Point } | undefined;
  private queued = false;
  private bounds = new WeakMap<object, { x0: number; y0: number; x1: number; y1: number }>();

  constructor(parent: HTMLElement, private doc: Doc) {
    this.el = document.createElement("canvas");
    this.el.className = "workspace";
    this.el.tabIndex = 0;
    parent.append(this.el);
    new ResizeObserver(() => this.invalidate()).observe(this.el);
    doc.subscribe(() => {
      for (const id of [...this.selection]) if (!this.exists(id)) this.selection.delete(id);
      this.invalidate();
    });
    this.el.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.el.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.el.addEventListener("pointerup", (e) => this.pointerUp(e));
    this.el.addEventListener("dblclick", (e) => this.doubleClick(e));
    this.el.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.el.setAttribute("role", "application");
    this.el.setAttribute("aria-label", "Schematic. Arrow keys move the selection, R rotates, M mirrors, Delete removes.");
    // WebKit reports trackpad pinches as gesture events rather than wheel events.
    let pinch = 1;
    this.el.addEventListener("gesturestart", (e) => { e.preventDefault(); pinch = 1; });
    this.el.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      const gesture = e as unknown as { scale: number; clientX: number; clientY: number };
      const rect = this.el.getBoundingClientRect();
      this.applyZoom(gesture.scale / pinch, gesture.clientX - rect.left, gesture.clientY - rect.top);
      pinch = gesture.scale;
    });
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    this.el.addEventListener("dragover", (e) => e.preventDefault());
    this.el.addEventListener("drop", (e) => {
      const kind = e.dataTransfer?.getData("text/part");
      if (!kind) return;
      e.preventDefault();
      const at = this.toWorld(e);
      this.doc.checkpoint();
      const comp = this.doc.addPart(kind, snap(at.x), snap(at.y));
      this.select([comp.id]);
      this.doc.notify();
    });
  }

  private exists(id: string): boolean {
    const s = this.doc.schematic;
    return s.components.some((c) => c.id === id) || s.wires.some((w) => w.id === id);
  }

  invalidate(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw();
    });
  }

  select(ids: string[]): void {
    this.selection = new Set(ids);
    this.onSelectionChange();
    this.invalidate();
  }

  beginPlace(kind: string): void {
    this.placing = kind;
    this.draft = undefined;
    this.onStatus(`Placing ${PART_BY_KIND.get(kind)?.name}. Click to drop, Esc to finish.`);
    this.el.focus();
    this.invalidate();
  }

  placeAtCenter(kind: string): void {
    const x = snap((this.el.clientWidth / 2 - this.ox) / this.zoom);
    const y = snap((this.el.clientHeight / 2 - this.oy) / this.zoom);
    this.doc.checkpoint();
    const comp = this.doc.addPart(kind, x, y);
    this.select([comp.id]);
    this.doc.notify();
    this.el.focus();
  }

  cancelTool(): void {
    this.placing = undefined;
    this.annotating = undefined;
    this.draft = undefined;
    this.onStatus("");
    this.invalidate();
  }

  fit(): void {
    const items = this.doc.schematic;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of items.components) {
      const b = this.worldBounds(c);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    for (const w of items.wires) {
      for (const p of w.points) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    for (const note of items.texts) {
      const rows = note.text.split("\n");
      x0 = Math.min(x0, note.x); y0 = Math.min(y0, note.y);
      x1 = Math.max(x1, note.x + Math.max(...rows.map((r) => r.length)) * 5.5);
      y1 = Math.max(y1, note.y + rows.length * 12);
    }
    const width = this.el.clientWidth || 800;
    const height = this.el.clientHeight || 600;
    if (!Number.isFinite(x0)) {
      this.zoom = 1; this.ox = width / 2; this.oy = height / 2;
    } else {
      this.zoom = Math.min(2, Math.max(0.05, Math.min((width - 80) / (x1 - x0 || 1), (height - 80) / (y1 - y0 || 1))));
      this.ox = width / 2 - ((x0 + x1) / 2) * this.zoom;
      this.oy = height / 2 - ((y0 + y1) / 2) * this.zoom;
    }
    this.invalidate();
  }

  zoomBy(factor: number): void {
    const cx = this.el.clientWidth / 2;
    const cy = this.el.clientHeight / 2;
    this.applyZoom(factor, cx, cy);
  }

  private applyZoom(factor: number, cx: number, cy: number): void {
    const next = Math.min(8, Math.max(0.05, this.zoom * factor));
    this.ox = cx - ((cx - this.ox) / this.zoom) * next;
    this.oy = cy - ((cy - this.oy) / this.zoom) * next;
    this.zoom = next;
    this.invalidate();
  }

  rotateSelected(): void {
    this.transformSelected((c) => { c.rotation = (((c.rotation + 90) % 360) as SchComponent["rotation"]); });
  }

  mirrorSelected(): void {
    this.transformSelected((c) => { c.mirrored = !c.mirrored; });
  }

  private transformSelected(apply: (c: SchComponent) => void): void {
    const comps = this.doc.schematic.components.filter((c) => this.selection.has(c.id));
    if (!comps.length) return;
    this.doc.checkpoint();
    if (this.doc.transformParts(comps, apply)) {
      this.doc.notify();
    } else {
      this.doc.revert();
      this.onStatus("That turn would change the part's connections, so it wasn't applied. Move the part somewhere clearer and try again.");
    }
  }

  /** Moves the selection, keeping wires attached. Used for keyboard nudging. */
  nudgeSelected(dx: number, dy: number): void {
    const comps = this.doc.schematic.components.filter((c) => this.selection.has(c.id));
    if (!comps.length) return;
    const start = { x: comps[0].x, y: comps[0].y };
    this.startMove(start);
    this.moveTo({ x: start.x + dx, y: start.y + dy });
    this.finishMove();
  }

  deleteSelected(): void {
    if (!this.selection.size) return;
    this.doc.checkpoint();
    for (const id of this.selection) {
      this.doc.removeComponentAndWires(id);
      this.doc.removeWire(id);
      this.doc.removeAnnotation(id);
    }
    this.selection.clear();
    this.onSelectionChange();
    this.doc.notify();
  }

  selectAll(): void {
    const s = this.doc.schematic;
    this.select([...s.components, ...s.wires, ...s.labels, ...s.texts].map((item) => item.id));
  }

  copySelected(): void {
    const s = this.doc.schematic;
    const picked = s.components.filter((c) => this.selection.has(c.id));
    // SPICE stored as fixed text names its own devices and nets, so a second copy would
    // clash with the first or silently join to it.
    const fixed = picked.filter((c) => c.spice.trim() && !c.spice.includes("{ref}"));
    if (fixed.length) {
      this.onStatus(`${fixed.map((c) => c.refDes || "That part").join(", ")} can't be copied, because its stored SPICE uses fixed names.`);
    }
    this.clipboard = structuredClone({
      components: picked.filter((c) => !fixed.includes(c)),
      wires: s.wires.filter((w) => this.selection.has(w.id)),
    });
    this.pasteCount = 0;
  }

  paste(): void {
    if (!this.clipboard) return;
    this.doc.checkpoint();
    const offset = 40 * ++this.pasteCount;
    this.select(this.doc.paste(this.clipboard, offset, offset));
    this.doc.notify();
  }

  /** Next click drops a net label or note carrying this text. */
  beginAnnotation(kind: "label" | "text", value: string): void {
    this.annotating = { kind, value };
    this.placing = undefined;
    this.draft = undefined;
    this.onStatus(kind === "label" ? `Click a wire to name its net "${value}".` : "Click to place the note.");
    this.el.focus();
  }

  private toWorld(e: { offsetX: number; offsetY: number } | MouseEvent): Point {
    const rect = this.el.getBoundingClientRect();
    const mouse = e as MouseEvent;
    const sx = mouse.clientX !== undefined ? mouse.clientX - rect.left : (e as { offsetX: number }).offsetX;
    const sy = mouse.clientY !== undefined ? mouse.clientY - rect.top : (e as { offsetY: number }).offsetY;
    return { x: (sx - this.ox) / this.zoom, y: (sy - this.oy) / this.zoom };
  }

  private localBounds(comp: SchComponent) {
    const key = comp.graphics ?? PART_BY_KIND.get(comp.kind)?.graphics ?? comp;
    const cached = this.bounds.get(key);
    if (cached) return cached;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };
    for (const g of this.graphicsOf(comp)) {
      if (g.kind === "line" || g.kind === "polygon") g.points.forEach((p) => add(p.x, p.y));
      else if (g.kind === "rect") { add(g.x, g.y); add(g.x + g.w, g.y + g.h); }
      else if (g.kind === "ellipse") { add(g.cx - g.rx, g.cy - g.ry); add(g.cx + g.rx, g.cy + g.ry); }
    }
    for (const p of comp.pins) add(p.x, p.y);
    if (!Number.isFinite(x0)) { x0 = y0 = -10; x1 = y1 = 10; }
    const result = { x0, y0, x1, y1 };
    this.bounds.set(key, result);
    return result;
  }

  private worldBounds(comp: SchComponent) {
    const b = this.localBounds(comp);
    const corners = [
      pinWorld(comp, { x: b.x0, y: b.y0 }), pinWorld(comp, { x: b.x1, y: b.y0 }),
      pinWorld(comp, { x: b.x0, y: b.y1 }), pinWorld(comp, { x: b.x1, y: b.y1 }),
    ];
    return {
      x0: Math.min(...corners.map((p) => p.x)), y0: Math.min(...corners.map((p) => p.y)),
      x1: Math.max(...corners.map((p) => p.x)), y1: Math.max(...corners.map((p) => p.y)),
    };
  }

  private graphicsOf(comp: SchComponent): Graphic[] {
    return comp.graphics ?? PART_BY_KIND.get(comp.kind)?.graphics ?? [];
  }

  private pinAt(p: Point): Point | undefined {
    const reach = 9 / this.zoom;
    let best: Point | undefined;
    let bestDistance = Infinity;
    for (const comp of this.doc.schematic.components) {
      for (const pin of comp.pins) {
        const at = pinWorld(comp, pin);
        const distance = Math.max(Math.abs(at.x - p.x), Math.abs(at.y - p.y));
        if (distance <= reach && distance < bestDistance) {
          best = at;
          bestDistance = distance;
        }
      }
    }
    return best;
  }

  /** Position in CSS pixels relative to the page. */
  screenOf(p: Point): Point {
    const rect = this.el.getBoundingClientRect();
    return { x: rect.left + this.ox + p.x * this.zoom, y: rect.top + this.oy + p.y * this.zoom };
  }

  private wireAt(p: Point): Wire | undefined {
    const reach = 5 / this.zoom;
    for (const wire of this.doc.schematic.wires) {
      for (let i = 1; i < wire.points.length; i++) {
        const a = wire.points[i - 1];
        const b = wire.points[i];
        const inX = p.x >= Math.min(a.x, b.x) - reach && p.x <= Math.max(a.x, b.x) + reach;
        const inY = p.y >= Math.min(a.y, b.y) - reach && p.y <= Math.max(a.y, b.y) + reach;
        if (!inX || !inY) continue;
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const dist = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
        if (dist <= reach) return wire;
      }
    }
    return undefined;
  }

  private nearestWirePoint(p: Point): Point | undefined {
    const wire = this.wireAt(p);
    if (!wire) return undefined;
    for (let i = 1; i < wire.points.length; i++) {
      const a = wire.points[i - 1];
      const b = wire.points[i];
      const reach = 5 / this.zoom;
      if (a.y === b.y && Math.abs(p.y - a.y) <= reach && p.x >= Math.min(a.x, b.x) - reach && p.x <= Math.max(a.x, b.x) + reach) {
        return { x: Math.min(Math.max(snap(p.x), Math.min(a.x, b.x)), Math.max(a.x, b.x)), y: a.y };
      }
      if (a.x === b.x && Math.abs(p.x - a.x) <= reach && p.y >= Math.min(a.y, b.y) - reach && p.y <= Math.max(a.y, b.y) + reach) {
        return { x: a.x, y: Math.min(Math.max(snap(p.y), Math.min(a.y, b.y)), Math.max(a.y, b.y)) };
      }
    }
    return wire.points[0];
  }

  private annotationAt(p: Point): string | undefined {
    const s = this.doc.schematic;
    const hit = (x: number, y: number, width: number) => p.x >= x - 4 && p.x <= x + width && p.y >= y - 14 && p.y <= y + 8;
    const label = s.labels.find((l) => hit(l.x, l.y, 8 + l.net.length * 6));
    if (label) return label.id;
    return s.texts.find((t) => hit(t.x, t.y, 8 + t.text.length * 6))?.id;
  }

  private componentAt(p: Point): SchComponent | undefined {
    const list = this.doc.schematic.components;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = this.worldBounds(list[i]);
      if (p.x >= b.x0 - 2 && p.x <= b.x1 + 2 && p.y >= b.y0 - 2 && p.y <= b.y1 + 2) return list[i];
    }
    return undefined;
  }

  private pointerDown(e: PointerEvent): void {
    this.el.focus();
    this.el.setPointerCapture(e.pointerId);
    const p = this.toWorld(e);
    this.mouse = p;
    if (e.button === 1 || e.button === 2 || e.altKey) {
      if (e.button === 2 && (this.draft || this.placing)) { this.cancelTool(); return; }
      this.drag = { kind: "pan", start: { x: e.clientX, y: e.clientY }, last: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (this.annotating) {
      const { kind, value } = this.annotating;
      this.annotating = undefined;
      this.onStatus("");
      this.doc.checkpoint();
      if (kind === "label") {
        // Land exactly on the nearest pin or wire so the name reaches that net.
        const at = this.pinAt(p) ?? this.nearestWirePoint(p) ?? { x: snap(p.x), y: snap(p.y) };
        this.doc.schematic.labels.push({ id: newId("l"), x: at.x, y: at.y, net: value });
      } else {
        this.doc.schematic.texts.push({ id: newId("t"), x: snap(p.x), y: snap(p.y), text: value });
      }
      this.doc.notify();
      return;
    }
    if (this.placing) {
      this.doc.checkpoint();
      const comp = this.doc.addPart(this.placing, snap(p.x), snap(p.y));
      this.select([comp.id]);
      this.doc.notify();
      if (!e.shiftKey) this.placing = undefined;
      this.onStatus("");
      return;
    }
    const pin = this.pinAt(p);
    if (this.draft) {
      const target = pin ?? (this.wireAt(p) ? { x: snap(p.x), y: snap(p.y) } : undefined);
      const last = this.draft[this.draft.length - 1];
      if (target) {
        this.doc.checkpoint();
        this.doc.addWire([...this.draft.slice(0, -1), ...(this.doc.clearRoute(last, target) ?? route(last, target))]);
        this.draft = undefined;
        this.onStatus("");
        this.doc.notify();
      } else {
        const at = { x: snap(p.x), y: snap(p.y) };
        this.draft = [...this.draft.slice(0, -1), ...route(last, at)];
      }
      this.invalidate();
      return;
    }
    if (pin) {
      this.draft = [pin];
      this.onStatus("Wiring. Click to add a corner, click a pin or wire to finish, Esc to cancel.");
      return;
    }
    const comp = this.componentAt(p);
    if (comp) {
      if (e.shiftKey) {
        const next = new Set(this.selection);
        if (next.has(comp.id)) next.delete(comp.id); else next.add(comp.id);
        this.select([...next]);
      } else if (!this.selection.has(comp.id)) {
        this.select([comp.id]);
      }
      this.startMove(p);
      return;
    }
    const wire = this.wireAt(p);
    if (wire) {
      if (e.shiftKey) this.select([...this.selection, wire.id]);
      else if (!this.selection.has(wire.id)) this.select([wire.id]);
      return;
    }
    const note = this.annotationAt(p);
    if (note) {
      this.select(e.shiftKey ? [...this.selection, note] : [note]);
      return;
    }
    if (!e.shiftKey) this.select([]);
    this.drag = { kind: "box", start: p, last: p };
    this.box = { a: p, b: p };
  }

  private startMove(p: Point): void {
    const stretch: NonNullable<Drag["stretch"]> = [];
    const labels: NetLabel[] = [];
    for (const comp of this.doc.schematic.components) {
      if (!this.selection.has(comp.id)) continue;
      for (const pin of comp.pins) {
        const at = pinWorld(comp, pin);
        // A label on a pin holds that pin's connection, so it has to travel with it.
        labels.push(...this.doc.schematic.labels.filter((l) => l.x === at.x && l.y === at.y));
        for (const wire of this.doc.schematic.wires) {
          // Selected wires travel with the selection instead of bending.
          if (this.selection.has(wire.id)) continue;
          const n = wire.points.length - 1;
          if (wire.points[0].x === at.x && wire.points[0].y === at.y) stretch.push({ wire, end: "first", comp });
          else if (wire.points[n].x === at.x && wire.points[n].y === at.y) stretch.push({ wire, end: "last", comp });
        }
      }
    }
    this.drag = {
      kind: "move", start: p, last: { x: snap(p.x), y: snap(p.y) }, stretch, labels,
      signature: connectivitySignature(this.doc.schematic),
    };
  }

  private moveTo(p: Point): void {
    const drag = this.drag;
    if (drag?.kind !== "move") return;
    const at = { x: snap(p.x), y: snap(p.y) };
    const dx = at.x - drag.last.x;
    const dy = at.y - drag.last.y;
    if (!dx && !dy) return;
    if (!drag.moved) { this.doc.checkpoint(); drag.moved = true; }
    for (const comp of this.doc.schematic.components) {
      if (this.selection.has(comp.id)) { comp.x += dx; comp.y += dy; }
    }
    for (const label of drag.labels ?? []) {
      label.x += dx;
      label.y += dy;
    }
    for (const wire of this.doc.schematic.wires) {
      if (this.selection.has(wire.id)) wire.points = wire.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
    }
    for (const s of drag.stretch ?? []) {
      // Other wires bend to keep right angles.
      const pts = s.wire.points;
      const idx = s.end === "first" ? 0 : pts.length - 1;
      const nextIdx = s.end === "first" ? 1 : pts.length - 2;
      const horizontal = pts[nextIdx] && pts[idx].y === pts[nextIdx].y;
      const moved = { x: pts[idx].x + dx, y: pts[idx].y + dy };
      if (pts.length === 2 && pts[nextIdx]) {
        const elbow = horizontal ? { x: pts[nextIdx].x, y: moved.y } : { x: moved.x, y: pts[nextIdx].y };
        s.wire.points = s.end === "first" ? [moved, elbow, pts[nextIdx]] : [pts[nextIdx], elbow, moved];
      } else if (pts[nextIdx]) {
        pts[idx] = moved;
        if (horizontal) pts[nextIdx] = { x: pts[nextIdx].x, y: moved.y };
        else pts[nextIdx] = { x: moved.x, y: pts[nextIdx].y };
      }
    }
    drag.last = at;
  }

  private finishMove(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (drag?.kind !== "move" || !drag.moved) return;
    for (const s of drag.stretch ?? []) s.wire.points = simplify(s.wire.points);
    if (connectivitySignature(this.doc.schematic) !== drag.signature) {
      // Bending can land on another wire or pin. Reroute cleanly, and refuse if that fails too.
      const comps = this.doc.schematic.components.filter((c) => this.selection.has(c.id));
      if (!this.rerouteAfterMove(comps, drag.signature!)) {
        this.doc.revert();
        this.onStatus("That move would change the circuit's connections, so it wasn't applied. Delete a wire first to change what connects.");
        return;
      }
    }
    this.onStatus("");
    this.doc.notify();
  }

  private rerouteAfterMove(comps: SchComponent[], signature: string): boolean {
    const schematic = this.doc.schematic;
    const pinKeys = new Set(comps.flatMap((c) => c.pins.map((p) => {
      const at = pinWorld(c, p);
      return `${at.x},${at.y}`;
    })));
    const touches = (p: Point | undefined) => p !== undefined && pinKeys.has(`${p.x},${p.y}`);
    const affected = schematic.wires.filter((w) => !this.selection.has(w.id) && (touches(w.points[0]) || touches(w.points[w.points.length - 1])));
    schematic.wires = schematic.wires.filter((w) => !affected.includes(w));
    for (const wire of affected) {
      const a = wire.points[0];
      const b = wire.points[wire.points.length - 1];
      wire.points = this.doc.clearRoute(a, b) ?? route(a, b);
      schematic.wires.push(wire);
    }
    return connectivitySignature(schematic) === signature;
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.toWorld(e);
    this.mouse = p;
    const drag = this.drag;
    if (drag?.kind === "pan") {
      this.ox += e.clientX - drag.last.x;
      this.oy += e.clientY - drag.last.y;
      drag.last = { x: e.clientX, y: e.clientY };
    } else if (drag?.kind === "box") {
      this.box = { a: drag.start, b: p };
    } else if (drag?.kind === "move") {
      this.moveTo(p);
    }
    this.invalidate();
  }

  private pointerUp(e: PointerEvent): void {
    this.el.releasePointerCapture(e.pointerId);
    const drag = this.drag;
    if (drag?.kind === "move") {
      this.finishMove();
      this.invalidate();
      return;
    }
    this.drag = undefined;
    if (drag?.kind === "box" && this.box) {
      const { a, b } = this.box;
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (x1 - x0 > 2 || y1 - y0 > 2) {
        const ids = this.doc.schematic.components.filter((c) => {
          const box = this.worldBounds(c);
          return box.x0 >= x0 && box.x1 <= x1 && box.y0 >= y0 && box.y1 <= y1;
        }).map((c) => c.id);
        const wires = this.doc.schematic.wires.filter((w) => w.points.every((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1));
        this.select([...ids, ...wires.map((w) => w.id)]);
      }
      this.box = undefined;
    }
    this.invalidate();
  }

  private doubleClick(e: MouseEvent): void {
    const p = this.toWorld(e);
    if (!this.draft) {
      const comp = this.componentAt(p);
      if (comp) this.onActivate(comp);
      return;
    }
    const last = this.draft[this.draft.length - 1];
    if (this.draft.length > 1 && Math.hypot(last.x - p.x, last.y - p.y) < 20) {
      this.doc.checkpoint();
      this.doc.addWire(this.draft);
      this.draft = undefined;
      this.doc.notify();
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.el.getBoundingClientRect();
    // A mouse wheel moves in whole notches, while a trackpad scrolls in small mixed steps.
    const notched = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 100);
    if (e.ctrlKey || e.metaKey || notched) {
      this.applyZoom(Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * (notched ? 0.002 : 0.01)), e.clientX - rect.left, e.clientY - rect.top);
    } else {
      this.ox -= e.deltaX;
      this.oy -= e.deltaY;
      this.invalidate();
    }
  }

  private draw(): void {
    try {
      this.paint();
    } catch (error) {
      // One bad shape from a file must not blank the rest of the sheet on later frames.
      console.error(error);
      this.el.getContext("2d")?.resetTransform();
    }
  }

  private paint(): void {
    const { el } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    if (el.width !== w * dpr || el.height !== h * dpr) {
      el.width = w * dpr;
      el.height = h * dpr;
    }
    const ctx = el.getContext("2d")!;
    const css = getComputedStyle(el);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const sheet = color("--sheet");
    const dot = color("--sheet-dot");
    const symbol = color("--symbol");
    const wireColor = color("--wire");
    const accent = color("--accent");
    const textColor = color("--text");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = sheet;
    ctx.fillRect(0, 0, w, h);

    const step = GRID * this.zoom * (this.zoom < 0.6 ? 5 : 1);
    if (step >= 6) {
      ctx.fillStyle = dot;
      for (let x = ((this.ox % step) + step) % step; x < w; x += step) {
        for (let y = ((this.oy % step) + step) % step; y < h; y += step) ctx.fillRect(x, y, 1, 1);
      }
    }

    ctx.setTransform(dpr * this.zoom, 0, 0, dpr * this.zoom, dpr * this.ox, dpr * this.oy);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const view = {
      x0: -this.ox / this.zoom, y0: -this.oy / this.zoom,
      x1: (w - this.ox) / this.zoom, y1: (h - this.oy) / this.zoom,
    };

    ctx.lineWidth = 1.3;
    const ends = new Map<string, number>();
    for (const wire of this.doc.schematic.wires) {
      ctx.strokeStyle = this.selection.has(wire.id) ? accent : wireColor;
      ctx.beginPath();
      wire.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      for (const end of [wire.points[0], wire.points[wire.points.length - 1]]) {
        if (!end) continue;
        const key = `${end.x},${end.y}`;
        ends.set(key, (ends.get(key) ?? 0) + 1);
      }
    }
    ctx.fillStyle = wireColor;
    const wires = this.doc.schematic.wires;
    for (const [key, count] of ends) {
      const [x, y] = key.split(",").map(Number);
      // A dot marks a real join: three wire ends, or one wire ending on another's run.
      const tee = count < 3 && wires.length <= 2000 && wires.some((w) => w.points.some((p, i) => {
        if (i === 0) return false;
        const a = w.points[i - 1];
        const onRun = (a.x === p.x && x === a.x && y > Math.min(a.y, p.y) && y < Math.max(a.y, p.y))
          || (a.y === p.y && y === a.y && x > Math.min(a.x, p.x) && x < Math.max(a.x, p.x));
        return onRun;
      }));
      if (count < 3 && !tee) continue;
      ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill();
    }

    for (const comp of this.doc.schematic.components) {
      const b = this.worldBounds(comp);
      if (b.x1 < view.x0 - 40 || b.x0 > view.x1 + 40 || b.y1 < view.y0 - 40 || b.y0 > view.y1 + 40) continue;
      const selected = this.selection.has(comp.id);
      try {
        this.drawComponent(ctx, comp, selected ? accent : symbol);
      } catch (error) {
        console.error(`Could not draw ${comp.refDes}`, error);
      }
      const display = this.displays.get(comp.id);
      if (display) this.drawDisplay(ctx, b, display);
      if (this.zoom > 0.25) this.drawLabels(ctx, comp, b, textColor);
      if (selected) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(b.x0 - 4, b.y0 - 4, b.x1 - b.x0 + 8, b.y1 - b.y0 + 8);
        ctx.setLineDash([]);
      }
    }

    ctx.font = "10px -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const label of this.doc.schematic.labels) {
      if (label.hidden) continue;
      ctx.fillStyle = accent;
      ctx.fillText(label.net, label.x + 4, label.y - 7);
      ctx.beginPath(); ctx.arc(label.x, label.y, 2, 0, 7); ctx.fill();
      if (this.selection.has(label.id)) ctx.strokeRect(label.x - 3, label.y - 14, label.net.length * 6 + 10, 17);
    }
    for (const note of this.doc.schematic.texts) {
      ctx.fillStyle = this.selection.has(note.id) ? accent : textColor;
      note.text.split("\n").forEach((row, i) => ctx.fillText(row, note.x, note.y + i * 12));
    }

    for (const [key, value] of this.probes) {
      const [x, y] = key.split(",").map(Number);
      const width = ctx.measureText(value).width + 8;
      ctx.fillStyle = color("--probe");
      ctx.fillRect(x + 3, y - 17, width, 13);
      ctx.fillStyle = "#fff";
      ctx.fillText(value, x + 7, y - 10);
    }

    const hoverPin = this.pinAt(this.mouse);
    if (hoverPin && !this.placing && !this.drag) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(hoverPin.x, hoverPin.y, 4.5, 0, 7); ctx.stroke();
    }
    if (this.draft) {
      const last = this.draft[this.draft.length - 1];
      const end = hoverPin ?? { x: snap(this.mouse.x), y: snap(this.mouse.y) };
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      [...this.draft.slice(0, -1), ...route(last, end)].forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    if (this.placing) {
      const part = PART_BY_KIND.get(this.placing);
      if (part) {
        ctx.globalAlpha = 0.55;
        this.drawComponent(ctx, {
          id: "", refDes: "", kind: part.kind, x: snap(this.mouse.x), y: snap(this.mouse.y), rotation: 0,
          mirrored: false, params: {}, pins: part.pins, spice: "",
        }, accent);
        ctx.globalAlpha = 1;
      }
    }
    if (this.box) {
      const { a, b } = this.box;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 0.8 / this.zoom;
      ctx.setLineDash([4 / this.zoom, 3 / this.zoom]);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.setLineDash([]);
    }
  }

  private drawDisplay(ctx: CanvasRenderingContext2D, b: { x0: number; y0: number; x1: number; y1: number }, display: PartDisplay): void {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    if (display.glow) {
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.55 * display.glow;
      ctx.fillStyle = "#ffb000";
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(8, Math.min(b.x1 - b.x0, b.y1 - b.y0) / 3), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (display.text) {
      ctx.save();
      ctx.fillStyle = "#e03131";
      ctx.font = "bold 16px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(display.text, cx, cy);
      ctx.restore();
    }
  }

  private drawComponent(ctx: CanvasRenderingContext2D, comp: SchComponent, stroke: string): void {
    ctx.save();
    ctx.translate(comp.x, comp.y);
    ctx.rotate((comp.rotation * Math.PI) / 180);
    if (comp.mirrored) ctx.scale(-1, 1);
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.lineWidth = 1.3;
    for (const g of this.graphicsOf(comp)) {
      ctx.beginPath();
      switch (g.kind) {
        case "line":
        case "polygon":
          g.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          if (g.kind === "polygon") {
            ctx.closePath();
            if (g.filled) ctx.fill();
          }
          ctx.stroke();
          break;
        case "rect":
          ctx.rect(g.x, g.y, g.w, g.h);
          if (g.filled) ctx.fill();
          ctx.stroke();
          break;
        case "ellipse":
          ctx.ellipse(g.cx, g.cy, Math.abs(g.rx), Math.abs(g.ry), 0, 0, Math.PI * 2);
          if (g.filled) ctx.fill();
          ctx.stroke();
          break;
        case "text":
          ctx.font = `${g.size}px -apple-system, 'Segoe UI', sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(g.text, g.x, g.y);
          break;
      }
    }
    ctx.restore();
  }

  private drawLabels(ctx: CanvasRenderingContext2D, comp: SchComponent, b: { x0: number; y0: number; x1: number; y1: number }, color: string): void {
    if (!comp.refDes || comp.kind === "ground") return;
    const part = PART_BY_KIND.get(comp.kind);
    const value = comp.displayValue ?? (part?.valueParam ? comp.params[part.valueParam] : undefined);
    ctx.fillStyle = color;
    ctx.font = "10px -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(comp.refDes, (b.x0 + b.x1) / 2, b.y0 - 2);
    if (value) {
      ctx.textBaseline = "top";
      ctx.fillText(value, (b.x0 + b.x1) / 2, b.y1 + 2);
    }
  }
}

