// Makes the drawing carry the connections. A file states every pin's net outright, but in Microsim
// wires must decide connectivity, or deleting a wire would change nothing. Nets the drawing fully
// connects lose their stored name from the pins; only what the drawing cannot express stays hidden.
import { pinWorld } from "../core/netlist";
import type { ImportIssue, NetLabel, Point, Schematic } from "../core/schematic";

/** The nets a file states, by component id and pin name. */
export type FileNets = Map<string, Map<string, string>>;

/** Same joining rules as buildNetlist in core/netlist.ts, without any names. */
export class Geometry {
  private parent = new Map<string, string>();

  find(a: string): string {
    let root = a;
    for (;;) {
      const next = this.parent.get(root);
      if (next === undefined) break;
      root = next;
    }
    let cur = a;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const pointKey = (p: Point) => `pt:${Math.round(p.x)},${Math.round(p.y)}`;

function onSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 0.5) return false;
  return p.x >= Math.min(a.x, b.x) - 0.5 && p.x <= Math.max(a.x, b.x) + 0.5
    && p.y >= Math.min(a.y, b.y) - 0.5 && p.y <= Math.max(a.y, b.y) + 0.5;
}

interface PinRef {
  componentId: string;
  name: string;
  at: Point;
}

/** Joins pins and wires as the drawing does. Pins are "component id/pin name", wires "wire:id". */
export function geometryOf(schematic: Pick<Schematic, "components" | "wires">): Geometry {
  const geometry = new Geometry();
  const CELL = 200;
  const cells = new Map<string, { a: Point; b: Point; id: string }[]>();
  for (const wire of schematic.wires) {
    wire.points.forEach((point, i) => {
      geometry.join(`wire:${wire.id}`, pointKey(point));
      if (i === 0) return;
      const a = wire.points[i - 1];
      const seg = { a, b: point, id: wire.id };
      for (let cx = Math.floor(Math.min(a.x, point.x) / CELL); cx <= Math.floor(Math.max(a.x, point.x) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(a.y, point.y) / CELL); cy <= Math.floor(Math.max(a.y, point.y) / CELL); cy++) {
          const k = `${cx},${cy}`;
          const list = cells.get(k);
          if (list) list.push(seg);
          else cells.set(k, [seg]);
        }
      }
    });
  }
  const touching = (p: Point) => cells.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`) ?? [];
  for (const wire of schematic.wires) {
    for (const end of [wire.points[0], wire.points[wire.points.length - 1]]) {
      for (const seg of touching(end)) {
        if (seg.id !== wire.id && onSegment(end, seg.a, seg.b)) geometry.join(`wire:${wire.id}`, `wire:${seg.id}`);
      }
    }
  }
  for (const comp of schematic.components) {
    for (const pin of comp.pins) {
      const at = pinWorld(comp, pin);
      const id = `${comp.id}/${pin.name}`;
      geometry.join(id, pointKey(at));
      for (const seg of touching(at)) {
        if (onSegment(at, seg.a, seg.b)) geometry.join(id, `wire:${seg.id}`);
      }
    }
  }
  return geometry;
}

/**
 * Removes Pin.net wherever geometry can carry the connection, adding hidden labels for what it
 * cannot. held names pins with no drawing, and ground parts' pins, which keep Pin.net.
 * Returns the file's nets as they were.
 */
export function bindConnectivity(
  schematic: Pick<Schematic, "components" | "wires" | "labels">,
  held: Set<string>,
  groundParts: Set<string>,
  nextId: () => string,
  issues: ImportIssue[],
): FileNets {
  const geometry = geometryOf(schematic);

  const fileNets: FileNets = new Map();
  /** Per net: drawn pins by geometry group, and whether a held pin needs the name to survive. */
  const nets = new Map<string, { groups: Map<string, PinRef[]>; heldPins: number; groundGroups: Set<string> }>();
  for (const comp of schematic.components) {
    for (const pin of comp.pins) {
      if (pin.net === undefined) continue;
      let stated = fileNets.get(comp.id);
      if (!stated) fileNets.set(comp.id, (stated = new Map()));
      stated.set(pin.name, pin.net);
    }
  }
  for (const comp of schematic.components) {
    for (const pin of comp.pins) {
      if (pin.net === undefined) continue;
      let net = nets.get(pin.net);
      if (!net) nets.set(pin.net, (net = { groups: new Map(), heldPins: 0, groundGroups: new Set() }));
      const id = `${comp.id}/${pin.name}`;
      if (held.has(id)) {
        net.heldPins++;
        continue;
      }
      const root = geometry.find(id);
      const list = net.groups.get(root);
      const ref: PinRef = { componentId: comp.id, name: pin.name, at: pinWorld(comp, pin) };
      if (list) list.push(ref);
      else net.groups.set(root, [ref]);
      if (groundParts.has(comp.id)) net.groundGroups.add(root);
    }
  }

  const labels: NetLabel[] = [];
  let linked = 0;
  for (const [name, net] of nets) {
    let needsName = 0;
    for (const [root, pins] of net.groups) {
      if (net.groundGroups.has(root)) continue;
      labels.push({ id: nextId(), x: pins[0].at.x, y: pins[0].at.y, net: name, hidden: true });
      needsName++;
    }
    if (name === "0" ? needsName > 0 : net.groups.size > 1 || net.heldPins > 0) linked++;
  }
  for (const comp of schematic.components) {
    for (const pin of comp.pins) {
      if (pin.net === undefined) continue;
      if (held.has(`${comp.id}/${pin.name}`) || groundParts.has(comp.id)) continue;
      delete pin.net;
    }
  }
  schematic.labels.push(...labels);
  if (linked) issues.push({ severity: "info", message: `Connectivity: ${linked} net(s) span parts the drawing does not join, such as connectors, buses, blocks and hidden pins; hidden links hold them.` });
  return fileNets;
}
