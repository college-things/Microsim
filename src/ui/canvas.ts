// Schematic workspace: drawing, selection, placement and wiring.
import { newId, PartMove, route, simplify, type Clipboard, type Doc } from "../core/doc";
import { PART_BY_KIND } from "../core/library";
import { junctions, pinWorld, placedBounds, pointKey, shownValue, symbolBounds, symbolGraphics } from "../core/netlist";
import type { PartDisplay } from "../core/indicators";
import type { Point, SchComponent, Wire } from "../core/schematic";
import { isMac } from "./platform";

const GRID = 10;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** A Mac's Ctrl+click means right-click, though it arrives as the main button. */
export const isSecondaryClick = (e: Pick<MouseEvent, "button" | "ctrlKey">, mac: boolean) =>
  e.button === 2 || (mac && e.button === 0 && e.ctrlKey);

/** What a scroll does to the view: a zoom factor, or a distance to pan in pixels. */
export function wheelAction(
  e: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "ctrlKey" | "metaKey">,
  mac: boolean,
): { zoom: number } | { panX: number; panY: number } {
  const unit = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 400 : 1;
  // A mouse wheel moves in whole notches, while a trackpad scrolls in small mixed steps. On a
  // Mac a hard swipe looks just like a notch, so there only Ctrl, Cmd or a pinch zooms.
  const notched = !mac && (e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 100));
  if (e.ctrlKey || e.metaKey || notched) {
    // A pinch sends small steps, which this leaves alone. A notch or a hard swipe gets one gentle step.
    return { zoom: Math.exp(-Math.max(-20, Math.min(20, e.deltaY * unit)) * 0.01) };
  }
  return { panX: e.deltaX * unit, panY: e.deltaY * unit };
}

/** The point on the nearest wire within reach, exactly on it so that a wire or label ending there joins it. */
export function pointOnWires(wires: Wire[], p: Point, reach: number): Point | undefined {
  let best: Point | undefined;
  let bestDistance = reach;
  for (const wire of wires) {
    for (let i = 1; i < wire.points.length; i++) {
      const a = wire.points[i - 1];
      const b = wire.points[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const along = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const near = { x: a.x + along * dx, y: a.y + along * dy };
      const distance = Math.hypot(near.x - p.x, near.y - p.y);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      best = settleOnRun(near, a, b);
    }
  }
  return best;
}

/** Moves a point on a run to the grid where that keeps it on the run. */
function settleOnRun(near: Point, a: Point, b: Point): Point {
  const within = (v: number, p: number, q: number) => Math.min(Math.max(v, Math.min(p, q)), Math.max(p, q));
  if (a.y === b.y) return { x: within(snap(near.x), a.x, b.x), y: a.y };
  if (a.x === b.x) return { x: a.x, y: within(snap(near.y), a.y, b.y) };
  // Few grid points lie on a slanted wire. Rounding to another would step off it and connect nothing.
  const grid = { x: snap(near.x), y: snap(near.y) };
  const onRun = (b.x - a.x) * (grid.y - a.y) === (b.y - a.y) * (grid.x - a.x)
    && within(grid.x, a.x, b.x) === grid.x && within(grid.y, a.y, b.y) === grid.y;
  return onRun ? grid : near;
}

interface Drag {
  kind: "move" | "pan" | "box";
  /** The pointer doing this, as a second finger can come down during it. */
  pointer: number;
  start: Point;
  last: Point;
  /** The selection on the move, with its wires following. Made at the first step, from how things are by then. */
  move?: PartMove;
  /** Where a pointer pressed to start a move, unsnapped. Arrow keys have none. */
  press?: Point;
  /** A button has been seen held down during this. Some trackpad gestures may never report one. */
  pressed?: boolean;
  /** Shift held, so a marquee adds to the selection. */
  adding?: boolean;
}

const WIRING = "Wiring. Click to add a corner, click a pin or wire to finish, Esc to cancel.";
/** How far in pixels a press can wander and still be a click, as a hand wobbles over a grid line. */
const CLICK_WOBBLE = 4;

export class SchematicCanvas {
  readonly el: HTMLCanvasElement;
  selection = new Set<string>();
  onSelectionChange: () => void = () => {};
  onStatus: (text: string) => void = () => {};
  /** Double-click on a part: toggle a switch or open an instrument. */
  onActivate: (comp: SchComponent) => void = () => {};
  /** Value shown beside each net after a simulation, keyed by a pin as "part id/pin name". */
  probes = new Map<string, string>();
  /** What indicator parts currently show, keyed by component id. */
  displays = new Map<string, PartDisplay>();

  private ox = 400;
  private oy = 300;
  private zoom = 1;
  private placing: string | undefined;
  /** How the part being placed is turned. */
  private placingTurn: Pick<SchComponent, "rotation" | "mirrored"> = { rotation: 0, mirrored: false };
  private annotating: { kind: "label" | "text"; value: string } | undefined;
  private clipboard: Clipboard | undefined;
  private pasteCount = 0;
  private draft: Point[] | undefined;
  private mouse: Point = { x: 0, y: 0 };
  private drag: Drag | undefined;
  private box: { a: Point; b: Point } | undefined;
  private queued = false;
  /** The status bar is saying what became of an edit, which the next click clears. */
  private refused = false;
  private bounds = new WeakMap<object, { x0: number; y0: number; x1: number; y1: number }>();

  constructor(parent: HTMLElement, private doc: Doc) {
    this.el = document.createElement("canvas");
    this.el.className = "workspace";
    this.el.tabIndex = 0;
    parent.append(this.el);
    new ResizeObserver(() => this.invalidate()).observe(this.el);
    doc.subscribe(() => {
      if (this.selection.size) {
        const s = this.doc.schematic;
        const ids = new Set([...s.components, ...s.wires, ...s.labels, ...s.texts].map((item) => item.id));
        for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
      }
      // An undo can take away the pin a wire started from, leaving it drawn from nothing.
      if (this.draft && !this.pinIsAt(this.draft[0])) this.cancelTool();
      this.invalidate();
    });
    // A second finger coming down elsewhere settles a drag, before it acts on anything.
    window.addEventListener("pointerdown", (e) => { if (e.target !== this.el) this.doc.settle(); }, true);
    this.el.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.el.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.el.addEventListener("pointerup", (e) => this.pointerUp(e));
    // The system can end a touch, or a release can go missing, and neither may skip a drag's check.
    this.el.addEventListener("pointercancel", (e) => this.pointerUp(e));
    this.el.addEventListener("lostpointercapture", (e) => this.pointerUp(e));
    this.el.addEventListener("dblclick", (e) => this.doubleClick(e));
    this.el.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.el.setAttribute("role", "application");
    this.el.setAttribute("aria-label", "Schematic. Arrow keys move the selection, R rotates, M mirrors, Delete removes.");
    // WebKit reports trackpad pinches as gesture events rather than wheel events. The scale runs
    // from the start of the pinch, so reversing after hitting a zoom limit returns to that zoom.
    let pinchFrom = 1;
    this.el.addEventListener("gesturestart", (e) => { e.preventDefault(); pinchFrom = this.zoom; });
    this.el.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      const gesture = e as unknown as { scale: number; clientX: number; clientY: number };
      const rect = this.el.getBoundingClientRect();
      this.applyZoom((pinchFrom * gesture.scale) / this.zoom, gesture.clientX - rect.left, gesture.clientY - rect.top);
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
    this.placingTurn = { rotation: 0, mirrored: false };
    this.annotating = undefined;
    this.draft = undefined;
    this.refused = false;
    this.onStatus(this.toolHint());
    this.el.focus();
    // Keys now mean the part being placed, not whatever was selected before.
    this.select([]);
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

  private refuse(text: string): void {
    this.refused = true;
    this.onStatus(text);
  }

  /** What the status bar says when there's nothing to report: the tool in hand, if any. */
  private toolHint(): string {
    if (this.draft) return WIRING;
    if (this.placing) return `Placing ${PART_BY_KIND.get(this.placing)?.name}. Click to drop, R to turn, Esc to finish.`;
    if (this.annotating) return this.annotating.kind === "label" ? `Click a wire to name its net "${this.annotating.value}".` : "Click to place the note.";
    return "";
  }

  cancelTool(): void {
    this.placing = undefined;
    this.annotating = undefined;
    this.draft = undefined;
    this.refused = false;
    this.onStatus("");
    this.invalidate();
  }

  private contentBounds(): { x0: number; y0: number; x1: number; y1: number } | undefined {
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
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : undefined;
  }

  /** Fits the circuit to the sheet, or to this much of it from the top left if the rest is covered. */
  fit(clear?: { width: number; height: number }): void {
    const bounds = this.contentBounds();
    const width = clear?.width || this.el.clientWidth || 800;
    const height = clear?.height || this.el.clientHeight || 600;
    if (!bounds) {
      this.zoom = 1; this.ox = width / 2; this.oy = height / 2;
    } else {
      const { x0, y0, x1, y1 } = bounds;
      this.zoom = Math.min(2, Math.max(0.05, Math.min(Math.max(40, width - 80) / (x1 - x0 || 1), Math.max(40, height - 80) / (y1 - y0 || 1))));
      this.ox = width / 2 - ((x0 + x1) / 2) * this.zoom;
      this.oy = height / 2 - ((y0 + y1) / 2) * this.zoom;
    }
    this.invalidate();
  }

  /** Fits only if the circuit runs out of this area, so a view that's already clear stays as it was. */
  fitInto(clear: { width: number; height: number }): void {
    const bounds = this.contentBounds();
    if (bounds && (bounds.x1 * this.zoom + this.ox > clear.width || bounds.y1 * this.zoom + this.oy > clear.height)) this.fit(clear);
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
    const turn = (c: Pick<SchComponent, "rotation">) => { c.rotation = (((c.rotation + 90) % 360) as SchComponent["rotation"]); };
    if (this.placing) {
      turn(this.placingTurn);
      this.invalidate();
      return;
    }
    this.transformSelected("That turn", turn);
  }

  mirrorSelected(): void {
    const mirror = (c: Pick<SchComponent, "mirrored">) => { c.mirrored = !c.mirrored; };
    if (this.placing) {
      mirror(this.placingTurn);
      this.invalidate();
      return;
    }
    this.transformSelected("Mirroring it", mirror);
  }

  private transformSelected(what: string, apply: (c: SchComponent) => void): void {
    if (!this.doc.settle()) return;
    const comps = this.doc.schematic.components.filter((c) => this.selection.has(c.id));
    if (!comps.length) return;
    this.doc.checkpoint();
    if (this.doc.transformParts(comps, apply)) {
      this.onStatus(this.toolHint());
      this.doc.notify();
    } else {
      this.doc.forgetIfUnchanged();
      this.refuse(`${what} would change the part's connections, so it wasn't applied. Move the part somewhere clearer and try again.`);
    }
  }

  /** Moves the selection, keeping wires attached. Used for keyboard nudging. */
  nudgeSelected(dx: number, dy: number): void {
    if (!this.doc.settle() || !this.selection.size) return;
    // A pan or marquee under way carries on afterward.
    const under = this.drag;
    this.startMove({ x: 0, y: 0 });
    this.moveTo({ x: dx, y: dy });
    this.doc.settle();
    this.drag = under;
  }

  private onlyWiresSelected(): boolean {
    return this.doc.schematic.wires.filter((w) => this.selection.has(w.id)).length === this.selection.size;
  }

  deleteSelected(): void {
    if (!this.doc.settle() || !this.selection.size) return;
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
    if (!this.doc.settle()) return;
    const s = this.doc.schematic;
    this.select([...s.components, ...s.wires, ...s.labels, ...s.texts].map((item) => item.id));
  }

  copySelected(): void {
    if (!this.doc.settle()) return;
    const s = this.doc.schematic;
    const picked = s.components.filter((c) => this.selection.has(c.id));
    // SPICE stored as fixed text names its own devices and nets, so a second copy would
    // clash with the first or silently join to it.
    const fixed = picked.filter((c) => c.spice.trim() && !c.spice.includes("{ref}"));
    if (fixed.length) {
      this.onStatus(`${fixed.map((c) => c.refDes || "That part").join(", ")} can't be copied, because its stored SPICE uses fixed names.`);
    }
    // A net's name stays behind, as on a copy it would join the two circuits.
    const copy = {
      components: picked.filter((c) => !fixed.includes(c)),
      wires: s.wires.filter((w) => this.selection.has(w.id)),
      texts: s.texts.filter((t) => this.selection.has(t.id)),
    };
    // Copying nothing keeps what was copied before.
    if (!copy.components.length && !copy.wires.length && !copy.texts.length) return;
    this.clipboard = structuredClone(copy);
    this.pasteCount = 0;
  }

  paste(): void {
    if (!this.clipboard || !this.doc.settle()) return;
    this.doc.checkpoint();
    const ids = this.doc.pasteClear(this.clipboard, 40 * ++this.pasteCount);
    if (!ids) {
      this.doc.revert();
      this.refuse("There's no clear spot nearby for the copy, so it wasn't pasted.");
      return;
    }
    this.select(ids);
    this.doc.notify();
  }

  /** Next click drops a net label or note carrying this text. */
  beginAnnotation(kind: "label" | "text", value: string): void {
    this.annotating = { kind, value };
    this.placing = undefined;
    this.draft = undefined;
    this.refused = false;
    this.onStatus(this.toolHint());
    this.el.focus();
    this.select([]);
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
    const result = symbolBounds(comp);
    this.bounds.set(key, result);
    return result;
  }

  private worldBounds(comp: SchComponent) {
    return placedBounds(comp, this.localBounds(comp));
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

  private pinIsAt(p: Point): boolean {
    return this.doc.schematic.components.some((c) => c.pins.some((pin) => pointKey(pinWorld(c, pin)) === pointKey(p)));
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
    return pointOnWires(this.doc.schematic.wires, p, 5 / this.zoom);
  }

  /** What a click would land on when ending a wire or label. Zoomed far out a pin reaches well past a wire, so the nearer wins. */
  private landingAt(p: Point): Point | undefined {
    const pin = this.pinAt(p);
    const onWire = this.nearestWirePoint(p);
    if (!pin || !onWire) return pin ?? onWire;
    return Math.hypot(onWire.x - p.x, onWire.y - p.y) < Math.hypot(pin.x - p.x, pin.y - p.y) ? onWire : pin;
  }

  private annotationAt(p: Point): string | undefined {
    const s = this.doc.schematic;
    const hit = (x: number, y: number, width: number) => p.x >= x - 4 && p.x <= x + width && p.y >= y - 14 && p.y <= y + 8;
    const label = s.labels.find((l) => !l.hidden && hit(l.x, l.y, 8 + l.net.length * 6));
    if (label) return label.id;
    return s.texts.find((t) => hit(t.x, t.y, 8 + t.text.length * 6))?.id;
  }

  /** A net's name whose dot is here. The dot sits on the name's wire, so this comes before the wire. */
  private nameDotAt(p: Point): string | undefined {
    const reach = 5 / this.zoom;
    return this.doc.schematic.labels.find((l) => !l.hidden && Math.hypot(l.x - p.x, l.y - p.y) <= reach)?.id;
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
    if (this.refused) {
      this.refused = false;
      this.onStatus(this.toolHint());
    }
    // A second finger ends whatever the first was doing, through its check if that was a drag.
    this.doc.settle();
    this.drag = undefined;
    this.box = undefined;
    const p = this.toWorld(e);
    this.mouse = p;
    const secondary = isSecondaryClick(e, isMac());
    if (e.button === 1 || secondary || e.altKey) {
      if (secondary && (this.draft || this.placing)) { this.cancelTool(); return; }
      this.drag = { kind: "pan", pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, last: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (this.annotating) {
      const { kind, value } = this.annotating;
      // Land exactly on the nearest pin or wire so the name reaches that net. On empty sheet
      // it would name nothing, then silently connect whatever is placed there later.
      const at = kind === "label" ? this.landingAt(p) : undefined;
      if (kind === "label" && !at) {
        this.onStatus(`That's empty sheet. Click a wire or pin to name its net "${value}", or press Esc.`);
        return;
      }
      if (at && this.doc.crossingAt(at)) {
        this.onStatus("Two wires cross there, so a name on that spot would connect them both. Click a little way along the one you mean, or press Esc.");
        return;
      }
      this.annotating = undefined;
      this.onStatus("");
      this.doc.checkpoint();
      if (at) {
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
      Object.assign(comp, this.placingTurn);
      this.select([comp.id]);
      this.doc.notify();
      if (!e.shiftKey) {
        this.placing = undefined;
        this.onStatus("");
      }
      return;
    }
    if (this.draft) {
      const target = this.landingAt(p);
      const last = this.draft[this.draft.length - 1];
      // Back on the start with nothing drawn yet, so there is no wire to make.
      if (target && simplify([...this.draft, target]).length < 2) {
        this.cancelTool();
      } else if (target) {
        this.finishWire(target);
      } else {
        const at = { x: snap(p.x), y: snap(p.y) };
        const next = [...this.draft.slice(0, -1), ...route(last, at)];
        const problem = this.doc.wireProblem(next);
        if (problem) this.refuse(problem);
        else this.draft = next;
      }
      this.invalidate();
      return;
    }
    const pin = this.pinAt(p);
    if (pin) {
      this.draft = [pin];
      this.onStatus(WIRING);
      // Keys now mean the wire being drawn, not whatever was selected before.
      this.select([]);
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
      this.startMove(p, e.pointerId);
      return;
    }
    const dot = this.nameDotAt(p);
    const wire = dot ? undefined : this.wireAt(p);
    if (wire) {
      if (e.shiftKey) this.select([...this.selection, wire.id]);
      else if (!this.selection.has(wire.id)) this.select([wire.id]);
      this.startMove(p, e.pointerId);
      return;
    }
    const note = dot ?? this.annotationAt(p);
    if (note) {
      if (e.shiftKey) this.select([...this.selection, note]);
      else if (!this.selection.has(note)) this.select([note]);
      this.startMove(p, e.pointerId);
      return;
    }
    if (!e.shiftKey) this.select([]);
    this.drag = { kind: "box", pointer: e.pointerId, start: p, last: p, adding: e.shiftKey };
    this.box = { a: p, b: p };
  }

  /** Ends the wire being drawn, on what was clicked or where it stopped. If that isn't safe, it stays open and says why. */
  private finishWire(target?: Point): void {
    const { refused, note } = this.doc.finishWire(this.draft!, target);
    if (refused) {
      this.refuse(refused);
      return;
    }
    this.draft = undefined;
    if (note) this.refuse(note);
    else this.onStatus("");
    this.doc.notify();
  }

  private startMove(p: Point, pointer?: number): void {
    const at = { x: snap(p.x), y: snap(p.y) };
    this.drag = { kind: "move", pointer: pointer ?? -1, start: at, last: at, press: pointer === undefined ? undefined : p };
  }

  private moveTo(p: Point): void {
    const drag = this.drag;
    if (drag?.kind !== "move") return;
    const at = { x: snap(p.x), y: snap(p.y) };
    if (at.x === drag.last.x && at.y === drag.last.y) return;
    if (!drag.move) {
      if (this.onlyWiresSelected()) {
        if (drag.press && Math.hypot(p.x - drag.press.x, p.y - drag.press.y) * this.zoom < CLICK_WOBBLE) return;
        this.drag = undefined;
        // What was pressed can be gone by now, deleted by a key.
        if (this.selection.size) this.refuse("A wire moves with its parts. Move a part instead.");
        return;
      }
      this.doc.checkpoint();
      const comps = this.doc.schematic.components.filter((c) => this.selection.has(c.id));
      drag.move = new PartMove(this.doc, comps, this.selection);
      this.doc.hold(() => this.finishMove(drag));
    }
    drag.move.shift(at.x - drag.start.x, at.y - drag.start.y);
    drag.last = at;
  }

  private finishMove(drag: Drag): boolean {
    if (this.drag === drag) this.drag = undefined;
    // Dragged away and back again, so nothing has changed.
    if (drag.last.x === drag.start.x && drag.last.y === drag.start.y) {
      this.doc.revert();
      return true;
    }
    // A net's name dropped near its wire lands on the wire.
    const name = this.selection.size === 1 ? this.doc.schematic.labels.find((l) => this.selection.has(l.id)) : undefined;
    if (name) Object.assign(name, this.landingAt(name));
    if (!drag.move!.settle()) {
      this.doc.revert();
      this.refuse(name
        ? "A net's name has to stay on that net, so it wasn't moved. Drop it on one of the net's wires."
        : "That move would change the circuit's connections, so it wasn't applied. Try another spot.");
      return false;
    }
    this.onStatus(this.toolHint());
    this.doc.notify();
    return true;
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.toWorld(e);
    this.mouse = p;
    const drag = this.drag?.pointer === e.pointerId ? this.drag : undefined;
    // With nothing held down any more, the release went missing, such as when the window lost focus.
    if (drag?.pressed && !e.buttons) {
      this.pointerUp(e);
      return;
    }
    if (drag && e.buttons) drag.pressed = true;
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
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    const drag = this.drag;
    // Only the pointer doing the drag can end it. Another's lifting says nothing about it.
    if (drag?.pointer !== e.pointerId) return;
    this.drag = undefined;
    if (drag.kind === "move") {
      this.doc.settle();
      this.invalidate();
      return;
    }
    if (drag.kind === "box" && this.box) {
      const { a, b } = this.box;
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (x1 - x0 > 2 || y1 - y0 > 2) {
        const ids = this.doc.schematic.components.filter((c) => {
          const box = this.worldBounds(c);
          return box.x0 >= x0 && box.x1 <= x1 && box.y0 >= y0 && box.y1 <= y1;
        }).map((c) => c.id);
        const inside = (p: Point) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        const s = this.doc.schematic;
        const wires = s.wires.filter((w) => w.points.every(inside));
        const notes = [...s.labels.filter((l) => !l.hidden), ...s.texts].filter(inside);
        this.select([...(drag.adding ? this.selection : []), ...ids, ...wires.map((w) => w.id), ...notes.map((n) => n.id)]);
      }
      this.box = undefined;
    }
    this.invalidate();
  }

  private doubleClick(e: MouseEvent): void {
    if (isSecondaryClick(e, isMac())) return;
    const p = this.toWorld(e);
    if (!this.draft) {
      const comp = this.componentAt(p);
      if (comp) this.onActivate(comp);
      return;
    }
    const last = this.draft[this.draft.length - 1];
    if (simplify(this.draft).length > 1 && Math.hypot(last.x - p.x, last.y - p.y) < 20) this.finishWire();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const action = wheelAction(e, isMac());
    if ("zoom" in action) {
      this.applyZoom(action.zoom, e.clientX - rect.left, e.clientY - rect.top);
    } else {
      this.ox -= action.panX;
      this.oy -= action.panY;
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
    for (const wire of this.doc.schematic.wires) {
      ctx.strokeStyle = this.selection.has(wire.id) ? accent : wireColor;
      ctx.beginPath();
      wire.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.fillStyle = wireColor;
    for (const { x, y } of junctions(this.doc.schematic)) {
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
      if (display) this.drawDisplay(ctx, b, display,comp);
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

    if (this.probes.size) {
      for (const comp of this.doc.schematic.components) {
        for (const pin of comp.pins) {
          const value = this.probes.get(`${comp.id}/${pin.name}`);
          if (value === undefined) continue;
          const { x, y } = pinWorld(comp, pin);
          const width = ctx.measureText(value).width + 8;
          ctx.fillStyle = color("--probe");
          ctx.fillRect(x + 3, y - 17, width, 13);
          ctx.fillStyle = "#fff";
          ctx.fillText(value, x + 7, y - 10);
        }
      }
    }

    // While wiring, a ring also shows where a click would join a wire.
    const hover = this.draft ? this.landingAt(this.mouse) : this.pinAt(this.mouse);
    if (hover && !this.placing && !this.drag) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(hover.x, hover.y, 4.5, 0, 7); ctx.stroke();
    }
    if (this.draft) {
      const last = this.draft[this.draft.length - 1];
      const end = hover ?? { x: snap(this.mouse.x), y: snap(this.mouse.y) };
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
          id: "", refDes: "", kind: part.kind, x: snap(this.mouse.x), y: snap(this.mouse.y), ...this.placingTurn,
          params: {}, pins: part.pins, spice: "",
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

  private drawDisplay(ctx: CanvasRenderingContext2D, b: { x0: number; y0: number; x1: number; y1: number }, display: PartDisplay,comp:SchComponent): void {
    if(display.machine){
      ctx.save();ctx.translate(comp.x,comp.y);ctx.rotate(comp.rotation*Math.PI/180);if(comp.mirrored)ctx.scale(-1,1);
      const fraction=display.machine.fraction;
      if(display.machine.kind==='tank'){ctx.fillStyle='#69b7e9';ctx.globalAlpha=0.8;ctx.fillRect(-32,32-59*fraction,64,59*fraction);}
      else{ctx.fillStyle='#c49b6a';ctx.strokeStyle='#755635';ctx.lineWidth=1;ctx.fillRect(-35+60*fraction,-23,10,12);ctx.strokeRect(-35+60*fraction,-23,10,12);}
      ctx.globalAlpha=1;ctx.fillStyle='#163f6a';ctx.font='bold 11px ui-monospace, monospace';ctx.textAlign='center';ctx.textBaseline='middle';if(display.text)ctx.fillText(display.text,0,display.machine.kind==='tank'?0:22);ctx.restore();return;
    }
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
    for (const g of symbolGraphics(comp)) {
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
    const value = shownValue(comp);
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

