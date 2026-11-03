// Editable document with undo. The canvas and the assistant both change circuits through this.
import { PART_BY_KIND } from "./library";
import { buildNetlist, connectivitySignature, pinWorld } from "./netlist";
import { emptySchematic, type Point, type SchComponent, type Schematic, type Wire } from "./schematic";

export { emptySchematic };

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}_${++counter}`;

export interface Clipboard {
  components: SchComponent[];
  wires: Wire[];
}

export class Doc {
  schematic: Schematic = emptySchematic();
  dirty = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private redoBeforeEdit: string[] = [];
  private dirtyBeforeEdit = false;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Call before a change so that undo returns here. */
  checkpoint(): void {
    this.undoStack.push(JSON.stringify(this.schematic));
    if (this.undoStack.length > 200) this.undoStack.shift();
    // Kept in case this edit is abandoned, so that doesn't cost the person their redo history.
    this.redoBeforeEdit = this.redoStack;
    this.dirtyBeforeEdit = this.dirty;
    this.redoStack = [];
    this.dirty = true;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.schematic));
    this.schematic = JSON.parse(prev);
    // Undoing past a save differs from the saved file too, so it still needs saving.
    this.dirty = true;
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.schematic));
    this.schematic = JSON.parse(next);
    this.dirty = true;
    this.notify();
  }

  /** Abandons an edit since the last checkpoint, leaving no way to redo it. */
  revert(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.schematic = JSON.parse(prev);
    this.redoStack = this.redoBeforeEdit;
    this.dirty = this.dirtyBeforeEdit;
    this.notify();
  }

  replace(schematic: Schematic): void {
    this.schematic = schematic;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.dirty = false;
    this.notify();
  }

  nextRef(prefix: string): string {
    const used = new Set(this.schematic.components.map((c) => c.refDes.toUpperCase()));
    let n = 1;
    while (used.has(`${prefix}${n}`.toUpperCase())) n++;
    return `${prefix}${n}`;
  }

  addPart(kind: string, x: number, y: number, params?: Record<string, string>): SchComponent {
    const part = PART_BY_KIND.get(kind);
    if (!part) throw new Error(`Unknown part "${kind}".`);
    const defaults = Object.fromEntries(part.params.map((p) => [p.key, p.default]));
    const comp: SchComponent = {
      id: newId("c"),
      refDes: this.nextRef(part.prefix),
      kind,
      x, y,
      rotation: 0,
      mirrored: false,
      params: { ...defaults, ...params },
      pins: part.pins.map((pin) => ({ ...pin })),
      spice: part.spice,
      instrument: part.instrument,
    };
    this.schematic.components.push(comp);
    return comp;
  }

  addWire(points: Point[]): Wire {
    const wire: Wire = { id: newId("w"), points: simplify(points) };
    this.schematic.wires.push(wire);
    return wire;
  }

  removeComponent(id: string): void {
    this.schematic.components = this.schematic.components.filter((c) => c.id !== id);
  }

  removeWire(id: string): void {
    this.schematic.wires = this.schematic.wires.filter((w) => w.id !== id);
  }

  removeAnnotation(id: string): void {
    this.schematic.labels = this.schematic.labels.filter((l) => l.id !== id);
    this.schematic.texts = this.schematic.texts.filter((t) => t.id !== id);
  }

  /** Adds copies offset from the originals, and returns their new ids. */
  paste(clip: Clipboard, dx: number, dy: number): string[] {
    const ids: string[] = [];
    for (const source of clip.components) {
      const comp: SchComponent = structuredClone(source);
      comp.id = newId("c");
      comp.refDes = this.nextRef(source.refDes.replace(/[\d_]+$/, "") || "U");
      comp.x += dx;
      comp.y += dy;
      // Named nets from a file would silently join the copy to the original.
      for (const pin of comp.pins) if (pin.net && pin.net !== "0") delete pin.net;
      this.schematic.components.push(comp);
      ids.push(comp.id);
    }
    for (const source of clip.wires) {
      const wire: Wire = { id: newId("w"), points: source.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      this.schematic.wires.push(wire);
      ids.push(wire.id);
    }
    return ids;
  }

  findByRef(refDes: string): SchComponent | undefined {
    const wanted = refDes.toUpperCase();
    return this.schematic.components.find((c) => c.refDes.toUpperCase() === wanted);
  }

  /** Draws an orthogonal wire between two pins. */
  connectPins(a: SchComponent, pinA: string, b: SchComponent, pinB: string): Wire {
    const pa = a.pins.find((p) => p.name === pinA);
    const pb = b.pins.find((p) => p.name === pinB);
    if (!pa) throw new Error(`${a.refDes} has no pin "${pinA}". Pins: ${a.pins.map((p) => p.name).join(", ")}.`);
    if (!pb) throw new Error(`${b.refDes} has no pin "${pinB}". Pins: ${b.pins.map((p) => p.name).join(", ")}.`);
    const from = pinWorld(a, pa);
    const to = pinWorld(b, pb);
    const path = this.clearRoute(from, to);
    if (path) return this.addWire(path);
    // A crowded sheet may have no clean path. Visible labels make the same connection, and
    // can be seen and deleted, unlike a connection with nothing drawn.
    const isGround = (net?: string) => net === "0" || net?.toLowerCase() === "gnd";
    const taken = new Set(this.schematic.labels.map((l) => l.net.toUpperCase()));
    let name = 1;
    while (taken.has(`LINK${name}`)) name++;
    const net = isGround(pa.net) ? "0" : isGround(pb.net) ? "0" : pa.net ?? pb.net ?? `LINK${name}`;
    this.schematic.labels.push(
      { id: newId("l"), x: from.x, y: from.y, net },
      { id: newId("l"), x: to.x, y: to.y, net },
    );
    return { id: "", points: [] };
  }

  /** Removes the wires ending on a pin, and any label on it, cutting that pin's connection. */
  disconnectPin(comp: SchComponent, pinName: string): void {
    const pin = comp.pins.find((p) => p.name === pinName);
    if (!pin) throw new Error(`${comp.refDes} has no pin "${pinName}". Pins: ${comp.pins.map((p) => p.name).join(", ")}.`);
    const at = pinWorld(comp, pin);
    const here = (p: Point | undefined) => p?.x === at.x && p?.y === at.y;
    const ending = (w: Wire) => here(w.points[0]) || here(w.points[w.points.length - 1]);
    const passing = this.schematic.wires.find((w) => !ending(w) && w.points.some((q, i) => i > 0 && onSeg(at, w.points[i - 1], q)));
    if (passing) throw new Error(`A wire runs straight through ${comp.refDes} pin ${pinName}. Move the part off that wire first.`);
    const before = buildNetlist(this.schematic).pinNets;
    const net = before.get(comp.id)?.get(pinName);
    if (!net) return;
    const snapshot = JSON.stringify(this.schematic);
    // Everything else on this net has to stay together once this pin has left it.
    const peers: { comp: SchComponent; pin: string }[] = [];
    for (const other of this.schematic.components) {
      for (const [name, value] of before.get(other.id) ?? []) {
        if (value === net && !(other === comp && name === pinName)) peers.push({ comp: other, pin: name });
      }
    }
    this.schematic.wires = this.schematic.wires.filter((w) => !ending(w));
    this.schematic.labels = this.schematic.labels.filter((l) => !here(l));
    if (pin.net && pin.net !== "0") delete pin.net;
    for (let i = 1; i < peers.length; i++) {
      const nets = buildNetlist(this.schematic).pinNets;
      const first = nets.get(peers[0].comp.id)?.get(peers[0].pin);
      if (first === undefined || first !== nets.get(peers[i].comp.id)?.get(peers[i].pin)) {
        this.connectPins(peers[0].comp, peers[0].pin, peers[i].comp, peers[i].pin);
      }
    }
    // Some pins can't leave a net, such as a ground part's own pin or one touching another pin.
    const after = buildNetlist(this.schematic).pinNets;
    const remaining = after.get(comp.id)?.get(pinName);
    const stillJoined = remaining !== undefined && peers.some((peer) => after.get(peer.comp.id)?.get(peer.pin) === remaining);
    if (stillJoined) {
      this.schematic = JSON.parse(snapshot);
      throw new Error(`${comp.refDes} pin ${pinName} can't be separated from its net, because it's a fixed connection or it touches another pin. Move the part first.`);
    }
  }

  /**
   * Turns or moves parts, rerouting attached wires. Connections must survive, so if routing
   * can't keep them this restores the circuit and returns false.
   */
  transformParts(comps: SchComponent[], apply: (c: SchComponent) => void): boolean {
    const snapshot = JSON.stringify(this.schematic);
    const before = connectivitySignature(this.schematic);
    const schematic = this.schematic;
    // Pins can swap places, so gather every move first and apply them together.
    const moves = new Map<string, Point>();
    for (const comp of comps) {
      const from = comp.pins.map((p) => pinWorld(comp, p));
      apply(comp);
      comp.pins.forEach((pin, i) => moves.set(`${from[i].x},${from[i].y}`, pinWorld(comp, pin)));
    }
    const moved = (p: Point) => moves.get(`${p.x},${p.y}`);
    // A label sitting on a pin belongs to that pin's connection, so it travels with the pin.
    for (const label of schematic.labels) {
      const to = moved(label);
      if (to) {
        label.x = to.x;
        label.y = to.y;
      }
    }
    const affected = schematic.wires.filter((w) => moved(w.points[0]) || moved(w.points[w.points.length - 1]));
    schematic.wires = schematic.wires.filter((w) => !affected.includes(w));
    for (const wire of affected) {
      const a = wire.points[0];
      const b = wire.points[wire.points.length - 1];
      const from = moved(a) ?? a;
      const to = moved(b) ?? b;
      wire.points = this.clearRoute(from, to) ?? route(from, to);
      schematic.wires.push(wire);
    }
    if (connectivitySignature(schematic) === before) return true;
    this.schematic = JSON.parse(snapshot);
    return false;
  }

  /**
   * Arranges the circuit left to right in connection order, then reroutes every wire.
   * Keeps all connections, or leaves the circuit as it was and returns false.
   */
  tidyLayout(): boolean {
    const schematic = this.schematic;
    const snapshot = JSON.stringify(schematic);
    const before = connectivitySignature(schematic);
    const nets = buildNetlist(schematic).pinNets;
    const parts = schematic.components.filter((c) => c.kind !== "ground");
    const onNet = new Map<string, SchComponent[]>();
    for (const comp of parts) {
      for (const net of nets.get(comp.id)?.values() ?? []) {
        if (net === "0") continue;
        if (!onNet.has(net)) onNet.set(net, []);
        onNet.get(net)!.push(comp);
      }
    }
    const source = (c: SchComponent) => /^(v|i|function-generator|clock)/.test(c.kind);
    const instrument = (c: SchComponent) => Boolean(c.instrument) && c.instrument !== "function-generator" && c.instrument !== "clock";
    // Breadth-first from the sources gives each part a column.
    const column = new Map<SchComponent, number>();
    const queue = parts.filter((c) => source(c));
    if (!queue.length && parts[0]) queue.push(parts[0]);
    for (const comp of queue) column.set(comp, 0);
    for (let i = 0; i < queue.length; i++) {
      const comp = queue[i];
      for (const net of nets.get(comp.id)?.values() ?? []) {
        for (const next of onNet.get(net) ?? []) {
          if (column.has(next) || instrument(next)) continue;
          column.set(next, column.get(comp)! + 1);
          queue.push(next);
        }
      }
    }
    const rows = new Map<number, number>();
    const last = Math.max(0, ...column.values());
    for (const comp of parts) {
      const col = instrument(comp) ? last + 1 : column.get(comp) ?? last;
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      comp.x = col * 180;
      comp.y = row * 140;
    }
    let groundColumn = 0;
    const bottom = Math.max(0, ...rows.values()) * 140 + 40;
    for (const comp of schematic.components) {
      if (comp.kind !== "ground") continue;
      comp.x = groundColumn++ * 120;
      comp.y = bottom;
    }
    // Pin-to-pin wires can be rebuilt; anything else stays as a list of points to reconnect.
    const pinsAt = new Map<string, Point>();
    for (const comp of schematic.components) {
      for (const pin of comp.pins) pinsAt.set(`${comp.id}/${pin.name}`, pinWorld(comp, pin));
    }
    const groups = new Map<string, Point[]>();
    for (const comp of schematic.components) {
      for (const [pin, net] of nets.get(comp.id) ?? []) {
        if (!groups.has(net)) groups.set(net, []);
        groups.get(net)!.push(pinsAt.get(`${comp.id}/${pin}`)!);
      }
    }
    schematic.wires = [];
    schematic.labels = schematic.labels.filter((l) => !l.hidden);
    for (const label of schematic.labels) {
      // Named nets stay named, on their first pin.
      const group = groups.get(label.net);
      if (group?.[0]) {
        label.x = group[0].x;
        label.y = group[0].y;
      }
    }
    for (const [net, points] of groups) {
      for (let i = 1; i < points.length; i++) {
        const path = this.clearRoute(points[0], points[i]);
        if (path) {
          this.addWire(path);
        } else {
          this.schematic.labels.push({ id: newId("l"), x: points[0].x, y: points[0].y, net }, { id: newId("l"), x: points[i].x, y: points[i].y, net });
        }
      }
    }
    if (connectivitySignature(schematic) === before) return true;
    this.schematic = JSON.parse(snapshot);
    return false;
  }

  /** Removes a part and the wires that end on its pins, as those wires go nowhere afterward. */
  removeComponentAndWires(id: string): void {
    const comp = this.schematic.components.find((c) => c.id === id);
    if (!comp) return;
    const ends = new Set(comp.pins.map((pin) => {
      const at = pinWorld(comp, pin);
      return `${at.x},${at.y}`;
    }));
    const onPin = (p: Point | undefined) => p !== undefined && ends.has(`${p.x},${p.y}`);
    // A wire also joining two other things still carries a connection after the part is gone.
    const others = this.schematic.components.filter((c) => c !== comp).flatMap((c) => c.pins.map((p) => pinWorld(c, p)));
    const wires = this.schematic.wires;
    const carriesOthers = (wire: Wire) => {
      const segment = (p: Point) => wire.points.some((q, i) => i > 0 && onSeg(p, wire.points[i - 1], q));
      let attached = others.filter(segment).length;
      for (const other of wires) {
        if (other === wire) continue;
        const a = other.points[0];
        const b = other.points[other.points.length - 1];
        const theyLandHere = (a && segment(a)) || (b && segment(b));
        const weLandThere = other.points.some((q, i) => i > 0 && (onSeg(wire.points[0], other.points[i - 1], q) || onSeg(wire.points[wire.points.length - 1], other.points[i - 1], q)));
        if (theyLandHere || weLandThere) attached++;
      }
      return attached >= 2;
    };
    this.schematic.wires = wires.filter((w) => (!onPin(w.points[0]) && !onPin(w.points[w.points.length - 1])) || carriesOthers(w));
    // A label left on an empty spot would silently connect whatever is placed there next.
    this.schematic.labels = this.schematic.labels.filter((l) => !onPin(l));
    this.removeComponent(id);
  }

  /**
   * Finds an orthogonal path that touches no other pin or wire on the way, because
   * anything a wire passes over could join its net. Returns undefined if none is found.
   */
  clearRoute(from: Point, to: Point): Point[] | undefined {
    // A label joins anything touching it, so wires must avoid labels just as they avoid pins.
    const pins: Point[] = this.schematic.labels.map((l) => ({ x: l.x, y: l.y }));
    for (const comp of this.schematic.components) {
      for (const pin of comp.pins) pins.push(pinWorld(comp, pin));
    }
    const wires = this.schematic.wires.map((w) => w.points);
    const offsets = [0];
    for (let d = 20; d <= 400; d += 20) offsets.push(d, -d);
    const candidates: Point[][] = [route(from, to), [from, { x: from.x, y: to.y }, to]];
    const midX = Math.round((from.x + to.x) / 20) * 10;
    const midY = Math.round((from.y + to.y) / 20) * 10;
    for (const d of offsets) {
      candidates.push([from, { x: midX + d, y: from.y }, { x: midX + d, y: to.y }, to]);
      candidates.push([from, { x: from.x, y: midY + d }, { x: to.x, y: midY + d }, to]);
    }
    const clear = candidates.map(simplify).filter((path) => isClear(path, from, to, pins, wires));
    // Running through a symbol is legal but hard to read, so use that only as a last resort.
    const bodies = this.schematic.components.map(bodyBox);
    return clear.find((path) => !crossesBody(path, bodies)) ?? clear[0];
  }
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Symbol extent in world coordinates, excluding the leads that end at pins. */
function bodyBox(comp: SchComponent): Box {
  const graphics = comp.graphics ?? PART_BY_KIND.get(comp.kind)?.graphics ?? [];
  const points: Point[] = [];
  for (const g of graphics) {
    if (g.kind === "line" || g.kind === "polygon") points.push(...g.points);
    else if (g.kind === "rect") points.push({ x: g.x, y: g.y }, { x: g.x + g.w, y: g.y + g.h });
    else if (g.kind === "ellipse") points.push({ x: g.cx - g.rx, y: g.cy - g.ry }, { x: g.cx + g.rx, y: g.cy + g.ry });
  }
  const world = points.map((p) => pinWorld(comp, p));
  if (!world.length) return { x0: comp.x, y0: comp.y, x1: comp.x, y1: comp.y };
  const inset = 4;
  return {
    x0: Math.min(...world.map((p) => p.x)) + inset, y0: Math.min(...world.map((p) => p.y)) + inset,
    x1: Math.max(...world.map((p) => p.x)) - inset, y1: Math.max(...world.map((p) => p.y)) - inset,
  };
}

function crossesBody(path: Point[], bodies: Box[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const x0 = Math.min(path[i - 1].x, path[i].x);
    const x1 = Math.max(path[i - 1].x, path[i].x);
    const y0 = Math.min(path[i - 1].y, path[i].y);
    const y1 = Math.max(path[i - 1].y, path[i].y);
    for (const b of bodies) {
      if (x0 <= b.x1 && x1 >= b.x0 && y0 <= b.y1 && y1 >= b.y0) return true;
    }
  }
  return false;
}

export function route(from: Point, to: Point): Point[] {
  if (from.x === to.x || from.y === to.y) return [from, to];
  return [from, { x: to.x, y: from.y }, to];
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

function onSeg(p: Point, a: Point, b: Point): boolean {
  if (a.x === b.x) return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  if (a.y === b.y) return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return Math.abs(cross) < 0.5 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
}

function isClear(path: Point[], from: Point, to: Point, pins: Point[], wires: Point[][]): boolean {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    for (const pin of pins) {
      if (!same(pin, from) && !same(pin, to) && onSeg(pin, a, b)) return false;
    }
    for (const wire of wires) {
      // Plain perpendicular crossings are fine; shared points and overlaps are not.
      const ownEnd = (p: Point) => same(p, from) || same(p, to);
      for (const end of [wire[0], wire[wire.length - 1]]) {
        if (end && !ownEnd(end) && onSeg(end, a, b)) return false;
      }
      for (let j = 1; j < wire.length; j++) {
        const c = wire[j - 1];
        const d = wire[j];
        const collinear = (a.x === b.x && c.x === d.x && a.x === c.x) || (a.y === b.y && c.y === d.y && a.y === c.y);
        if (collinear && (onSeg(c, a, b) || onSeg(d, a, b) || onSeg(a, c, d) || onSeg(b, c, d))) {
          const touchOnlyAtOwnEnd = [c, d, a, b].filter((p) => onSeg(p, a, b) && onSeg(p, c, d)).every(ownEnd);
          if (!touchOnlyAtOwnEnd) return false;
        }
      }
    }
  }
  // Interior corners must not land on an existing wire, or they would read as a junction.
  for (const corner of path.slice(1, -1)) {
    for (const wire of wires) {
      for (let j = 1; j < wire.length; j++) if (onSeg(corner, wire[j - 1], wire[j])) return false;
    }
  }
  return true;
}

/** Drops repeated and collinear points. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) {
      out[out.length - 1] = p;
    } else {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}
