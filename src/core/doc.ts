// Editable document with undo. The canvas and the assistant both change circuits through this.
import { PART_BY_KIND } from "./library";
import { buildNetlist, connectivitySignature, looseNames, onSegment, pinWorld, pointKey } from "./netlist";
import { circuitPages, emptySchematic, type BlockDefinition, type FreeText, type NetLabel, type Point, type SchComponent, type Schematic, type Wire } from "./schematic";

import { blockSymbol } from "./hierarchy";

// Editing checks concern only the visible sheet; block symbols are ordinary terminals here.
function localNetlist(s: Schematic) {
  return buildNetlist({ ...s, pages: undefined, blocks: undefined, components: s.components.map((c) => c.blockId ? { ...c, blockId: undefined } : c) });
}

export { emptySchematic };

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}_${++counter}`;

export interface Clipboard {
  components: SchComponent[];
  wires: Wire[];
  texts?: FreeText[];
}

export class Doc {
  schematic: Schematic = emptySchematic();
  activePage = 0;
  blockPath: string[] = [];

  get sheet(): Schematic {
    const block = this.blockPath.length ? this.schematic.blocks?.find((b) => b.id === this.blockPath[this.blockPath.length - 1]) : undefined;
    return block ?? circuitPages(this.schematic)[this.activePage] ?? this.schematic;
  }
  dirty = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private redoBeforeEdit: string[] = [];
  private dirtyBeforeEdit = false;
  private listeners = new Set<() => void>();
  private unsettled: (() => boolean) | undefined;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    this.activePage = Math.max(0, Math.min(this.activePage, this.schematic.pages?.length ?? 0));
    this.blockPath = this.blockPath.filter((id) => this.schematic.blocks?.some((b) => b.id === id));
    for (const fn of this.listeners) fn();
  }

  /**
   * A drag leaves the circuit mid-move, with its connections unchecked until it ends. This marks
   * that and how to end it, because whatever acts on the circuit next has to settle it first.
   */
  hold(settle: () => boolean): void {
    this.unsettled = settle;
  }

  get held(): boolean {
    return this.unsettled !== undefined;
  }

  /**
   * Ends a drag under way through its own connection check. Returns false if the check turned it
   * down, when a person's next action can stop there, as the sheet just changed under them.
   */
  settle(): boolean {
    const settle = this.unsettled;
    this.unsettled = undefined;
    return settle ? settle() : true;
  }

  /** Call before a change so that undo returns here. */
  checkpoint(): void {
    this.settle();
    this.undoStack.push(JSON.stringify(this.schematic));
    if (this.undoStack.length > 200) this.undoStack.shift();
    // Kept in case this edit is abandoned, so that doesn't cost the person their redo history.
    this.redoBeforeEdit = this.redoStack;
    this.dirtyBeforeEdit = this.dirty;
    this.redoStack = [];
    this.dirty = true;
  }

  undo(): void {
    this.settle();
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.schematic));
    this.schematic = JSON.parse(prev);
    // Undoing past a save differs from the saved file too, so it still needs saving.
    this.dirty = true;
    this.notify();
  }

  redo(): void {
    this.settle();
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

  /** Takes back the last checkpoint if nothing has changed since it, as after an edit that was refused. */
  forgetIfUnchanged(): boolean {
    if (this.undoStack[this.undoStack.length - 1] !== JSON.stringify(this.schematic)) return false;
    this.undoStack.pop();
    this.redoStack = this.redoBeforeEdit;
    this.dirty = this.dirtyBeforeEdit;
    return true;
  }

  replace(schematic: Schematic): void {
    this.settle();
    this.schematic = schematic;
    this.activePage = 0;
    this.blockPath = [];
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.dirty = false;
    this.notify();
  }

  nextRef(prefix: string): string {
    const used = new Set((this.blockPath.length ? [this.sheet] : circuitPages(this.schematic)).flatMap((s) => s.components.map((c) => c.refDes.toUpperCase())));
    let n = 1;
    while (used.has(`${prefix}${n}`.toUpperCase())) n++;
    return `${prefix}${n}`;
  }

  openPage(index: number): void {
    if (!circuitPages(this.schematic)[index]) throw new Error("That page does not exist.");
    this.settle();
    this.activePage = index;
    this.blockPath = [];
    this.notify();
  }

  openBlock(id: string): void {
    if (!this.schematic.blocks?.some((b) => b.id === id)) throw new Error("That block does not exist.");
    this.settle();
    this.blockPath.push(id);
    this.notify();
  }

  addPage(name: string): void {
    if (!name.trim()) throw new Error("Give the page a name.");
    this.checkpoint();
    (this.schematic.pages ??= []).push(emptySchematic(name.trim()));
    this.openPage(this.schematic.pages.length);
  }

  renamePage(index: number, name: string): void {
    if (!name.trim()) throw new Error("Give the page a name.");
    const page = circuitPages(this.schematic)[index];
    if (!page) throw new Error("That page does not exist.");
    this.checkpoint();
    page.name = name.trim();
    this.notify();
  }

  deletePage(index: number): void {
    const pages = circuitPages(this.schematic);
    if (pages.length === 1) throw new Error("Keep at least one page in the circuit.");
    if (!pages[index]) throw new Error("That page does not exist.");
    this.checkpoint();
    pages.splice(index, 1);
    this.storePages(pages);
    this.openPage(Math.min(index, pages.length - 1));
  }

  movePage(index: number, to: number): void {
    const pages = circuitPages(this.schematic);
    if (!pages[index] || !pages[to]) throw new Error("That page does not exist.");
    if (index === to) return;
    this.checkpoint();
    pages.splice(to, 0, pages.splice(index, 1)[0]);
    this.storePages(pages);
    this.openPage(to);
  }

  private storePages(pages: Schematic[]): void {
    const definitions = [...new Set(pages.map((p) => p.definitions).concat(this.schematic.definitions))].filter(Boolean).join("\n");
    const copies = pages.map((p) => ({ name: p.name, components: p.components, wires: p.wires, labels: p.labels, texts: p.texts, definitions: "" }));
    Object.assign(this.schematic, copies[0], { definitions, pages: copies.slice(1) });
  }

  placeBlock(id: string, x: number, y: number): SchComponent {
    const block = this.schematic.blocks?.find((b) => b.id === id);
    if (!block) throw new Error("That block does not exist.");
    const comp = blockSymbol(block, newId("c"), this.nextRef("X"), x, y);
    // Check cycles before changing the document, including indirect self-instances.
    const trial = structuredClone(this.schematic);
    const target = this.blockPath.length ? trial.blocks!.find((b) => b.id === this.blockPath[this.blockPath.length - 1])! : circuitPages(trial)[this.activePage];
    target.components.push(comp);
    // Unused definitions need checking too, so walk references from the current definition.
    const walk = (blockId: string, stack: string[]) => {
      if (stack.includes(blockId)) throw new Error("A block cannot contain itself, even through another block.");
      for (const c of trial.blocks?.find((b) => b.id === blockId)?.components ?? []) if (c.blockId) walk(c.blockId, [...stack, blockId]);
    };
    if (this.blockPath.length) walk(this.blockPath[this.blockPath.length - 1], []);
    this.checkpoint();
    this.sheet.components.push(comp);
    this.notify();
    return comp;
  }

  addBlockPort(name: string, x: number, y: number): SchComponent {
    if (!this.blockPath.length) throw new Error("Open a block to add a port.");
    name = name.trim();
    if (!name || this.sheet.components.some((c) => c.kind === "hierarchy-port" && c.params.name === name)) throw new Error("Give every port a different, nonempty name.");
    this.checkpoint();
    const port: SchComponent = { id: newId("port"), refDes: this.nextRef("P"), kind: "hierarchy-port", x, y, rotation: 0, mirrored: false, params: { name }, displayValue: name, spice: "", pins: [{ name: "port", x: 0, y: 0 }], graphics: [{ kind: "ellipse", cx: 0, cy: 0, rx: 4, ry: 4, filled: false }] };
    this.sheet.components.push(port);
    this.syncBlockPins();
    this.notify();
    return port;
  }

  renameBlockPort(id: string, name: string): void {
    const port = this.sheet.components.find((c) => c.id === id && c.kind === "hierarchy-port");
    if (!port || !this.blockPath.length) throw new Error("Open a block to rename its port.");
    name = name.trim();
    if (!name || this.sheet.components.some((c) => c !== port && c.kind === "hierarchy-port" && c.params.name === name)) throw new Error("Give every port a different, nonempty name.");
    this.checkpoint();
    const old = port.params.name;
    port.params.name = name; port.displayValue = name;
    const blockId = this.blockPath[this.blockPath.length - 1];
    for (const sheet of [...circuitPages(this.schematic), ...(this.schematic.blocks ?? [])]) for (const c of sheet.components) {
      if (c.blockId === blockId) for (const pin of c.pins) if (pin.name === old) pin.name = name;
    }
    this.syncBlockPins();
    this.notify();
  }

  private syncBlockPins(): void {
    const block = this.schematic.blocks?.find((b) => b.id === this.blockPath[this.blockPath.length - 1]);
    if (!block) return;
    for (const sheet of [...circuitPages(this.schematic), ...(this.schematic.blocks ?? [])]) for (const c of sheet.components) {
      if (c.blockId !== block.id) continue;
      const symbol = blockSymbol(block, c.id, c.refDes, c.x, c.y);
      // Existing pins retain their location and named-net binding so port edits never
      // detach the wires on other instances. New ports extend below the old pins.
      const old = new Map(c.pins.map((p) => [p.name, p]));
      let bottom = Math.max(-30, ...c.pins.map((p) => p.y));
      c.pins = symbol.pins.map((p) => old.get(p.name) ?? { ...p, y: (bottom += 20) });
      const ys = c.pins.map((p) => p.y);
      const top = Math.min(-20, ...ys) - 10, end = Math.max(20, ...ys) + 10;
      c.graphics = [{ kind: "rect", x: -40, y: top, w: 80, h: end - top, filled: false }, ...c.pins.flatMap((p) => [
        { kind: "line" as const, points: [{ x: p.x, y: p.y }, { x: -40, y: p.y }] },
        { kind: "text" as const, x: 0, y: p.y, text: p.name, size: 9 },
      ])];
    }
  }

  /** Boundary nets include selected wires touching outside pins, named/off-page nets,
   * and connections crossing unselected wires. Ports retain the original connectivity. */
  createBlock(selection: Set<string>, name: string, pinNames: Record<string, string> = {}): SchComponent {
    const s = this.sheet;
    const parts = s.components.filter((c) => selection.has(c.id));
    const wires = s.wires.filter((w) => selection.has(w.id));
    if (!parts.length) throw new Error("Select the parts and wires to put in the block.");
    if (!name.trim()) throw new Error("Give the block a name.");
    if (parts.some((c) => c.instrument || c.indicator || c.kind === "lcd16x2" || c.kind === "hierarchy-port")) throw new Error("Keep instruments, result displays and existing ports outside the new block.");
    if (parts.some((c) => c.lockedName)) throw new Error("Parts referenced by stored SPICE names cannot be moved into a block. Keep those parts on the page.");
    if (parts.some((c) => c.spice.trim() && !c.pins.length)) throw new Error("A raw SPICE deck cannot be moved into an editable block. Keep it on the page.");
    const markers: SchComponent[] = s.wires.map((w) => ({ id: `wire:${w.id}`, refDes: "", kind: "imported", x: w.points[0].x, y: w.points[0].y, rotation: 0, mirrored: false, params: {}, spice: "", pins: [{ name: "wire", x: 0, y: 0 }] }));
    const netlist = localNetlist({ ...s, pages: undefined, blocks: undefined, components: [...s.components.map((c) => ({ ...c, blockId: undefined })), ...markers] });
    const inside = new Map<string, Point>();
    const outside = new Map<string, Point[]>();
    const add = (net: string | undefined, at: Point, selected: boolean) => {
      if (!net) return;
      if (selected) inside.set(net, at);
      else outside.set(net, [...(outside.get(net) ?? []), at]);
    };
    for (const c of s.components) for (const p of c.pins) add(netlist.pinNets.get(c.id)?.get(p.name), pinWorld(c, p), selection.has(c.id));
    for (const w of s.wires) add(netlist.pinNets.get(`wire:${w.id}`)?.get("wire"), w.points[0], selection.has(w.id));
    for (const l of s.labels) add(netlist.namedNets.get(l.net), l, false);
    // Named pins may connect to another page or to global ground without a local outside part.
    for (const c of parts) for (const p of c.pins) if (p.net) add(netlist.pinNets.get(c.id)?.get(p.name), pinWorld(c, p), false);
    // Ground is global, inside a block as everywhere else, so it never needs a pin.
    const boundary = [...inside].filter(([net]) => outside.has(net) && net !== "0");
    const defaults = (net: string) => [...netlist.namedNets].find(([, n]) => n === net)?.[0] ?? net;
    const names = boundary.map(([net]) => (pinNames[net] ?? defaults(net)).trim());
    if (names.some((n) => !n) || new Set(names).size !== names.length) throw new Error("Give every port a different, nonempty name.");
    const block: BlockDefinition = { ...emptySchematic(name.trim()), id: newId("block"), components: structuredClone(parts), wires: structuredClone(wires) };
    // Preserve connections carried by labels or by geometry that stays on the parent sheet.
    for (const c of block.components) for (const p of c.pins) p.net = netlist.pinNets.get(c.id)?.get(p.name) ?? p.net;
    boundary.forEach(([net, at], i) => block.components.push({ id: newId("port"), refDes: `P${i + 1}`, kind: "hierarchy-port", x: at.x, y: at.y, rotation: 0, mirrored: false, params: { name: names[i] }, displayValue: names[i], pins: [{ name: "port", x: 0, y: 0, net }], spice: "", graphics: [{ kind: "ellipse", cx: 0, cy: 0, rx: 4, ry: 4, filled: false }] }));
    // Put the new symbol beyond existing geometry so its pins cannot accidentally
    // touch an unrelated wire. The named boundary links retain all parent connections.
    const xs = [...s.components.flatMap((c) => c.pins.map((p) => pinWorld(c, p).x)), ...s.wires.flatMap((w) => w.points.map((p) => p.x)), ...s.labels.map((l) => l.x)];
    const x = Math.ceil(xs.reduce((a, b) => Math.max(a, b), 0) / 10) * 10 + 150;
    const y = Math.round(parts.reduce((n, c) => n + c.y, 0) / parts.length / 10) * 10;
    const instance = blockSymbol(block, newId("c"), this.nextRef("X"), x, y);
    this.checkpoint();
    (this.schematic.blocks ??= []).push(block);
    s.components = s.components.filter((c) => !selection.has(c.id));
    s.wires = s.wires.filter((w) => !selection.has(w.id));
    s.components.push(instance);
    const taken = new Set(circuitPages(this.schematic).flatMap((page) => page.labels.map((l) => l.net.toUpperCase())));
    boundary.forEach(([net], i) => {
      // Keep a name the net already has; otherwise name it after the instance and port, such as X1_IN.
      const named = [...netlist.namedNets].find(([, n]) => n === net)?.[0];
      let link = named ?? `${instance.refDes}_${names[i]}`.replace(/[^\w]/g, "_");
      for (let n = 2; !named && taken.has(link.toUpperCase()); n++) link = `${instance.refDes}_${names[i]}_${n}`.replace(/[^\w]/g, "_");
      taken.add(link.toUpperCase());
      for (const at of [...(outside.get(net) ?? []), pinWorld(instance, instance.pins[i])]) s.labels.push({ id: newId("l"), x: at.x, y: at.y, net: link });
    });
    this.notify();
    return instance;
  }

  addPart(kind: string, x: number, y: number, params?: Record<string, string>): SchComponent {
    const part = PART_BY_KIND.get(kind);
    if (!part) throw new Error(`Unknown part "${kind}".`);
    if (this.blockPath.length && (part.instrument || part.indicator || kind === "lcd16x2")) throw new Error("Place instruments and result displays on a circuit page, outside blocks.");
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
      indicator: part.indicator ? structuredClone(part.indicator) : undefined,
      graphics: part.kind.startsWith("user:") ? structuredClone(part.graphics) : undefined,
    };
    if (kind === "push-button" || kind === "spdt") {
      comp.interactive = { kind: "switch", positions: 2, position: Number(comp.params.level) >= 0.5 ? 1 : 0, momentary: kind === "push-button", apply: { low: 0, high: 1 } };
    }
    this.sheet.components.push(comp);
    if (kind.startsWith("user:") && part.definitions && !this.sheet.definitions.includes(part.definitions)) this.sheet.definitions += `\n${part.definitions}`;
    return comp;
  }

  addWire(points: Point[]): Wire {
    const wire: Wire = { id: newId("w"), points: simplify(points) };
    // A single point draws nothing and can't be selected, so it could never be removed.
    if (wire.points.length > 1) this.sheet.wires.push(wire);
    return wire;
  }

  removeComponent(id: string): void {
    this.sheet.components = this.sheet.components.filter((c) => c.id !== id);
    this.syncBlockPins();
  }

  removeWire(id: string): void {
    this.sheet.wires = this.sheet.wires.filter((w) => w.id !== id);
  }

  removeAnnotation(id: string): void {
    this.sheet.labels = this.sheet.labels.filter((l) => l.id !== id);
    this.sheet.texts = this.sheet.texts.filter((t) => t.id !== id);
  }

  /** Adds copies offset from the originals, and returns their new ids. */
  paste(clip: Clipboard, dx: number, dy: number): string[] {
    if (this.blockPath.length && clip.components.some((c) => c.instrument || c.indicator || c.kind === "lcd16x2" || c.kind === "hierarchy-port" || c.blockId)) throw new Error("Inside blocks, paste ordinary parts and wires. Use Place hierarchical block for a nested instance, and Add block port for ports.");
    const ids: string[] = [];
    for (const source of clip.components) {
      const comp: SchComponent = structuredClone(source);
      comp.id = newId("c");
      comp.refDes = this.nextRef(source.refDes.replace(/[\d_]+$/, "") || "U");
      comp.x += dx;
      comp.y += dy;
      // Named nets from a file would silently join the copy to the original.
      for (const pin of comp.pins) if (pin.net && pin.net !== "0") delete pin.net;
      this.sheet.components.push(comp);
      ids.push(comp.id);
    }
    for (const source of clip.wires) {
      const wire: Wire = { id: newId("w"), points: source.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      this.sheet.wires.push(wire);
      ids.push(wire.id);
    }
    for (const source of clip.texts ?? []) {
      const note: FreeText = { ...source, id: newId("t"), x: source.x + dx, y: source.y + dy };
      this.sheet.texts.push(note);
      ids.push(note.id);
    }
    return ids;
  }

  /**
   * Pastes at this offset, or further along if that would join the copies to the circuit, and
   * returns their ids. Returns undefined, adding nothing, if no nearby spot is clear.
   */
  pasteClear(clip: Clipboard, offset: number): string[] | undefined {
    const far = 1e7;
    const ids = new Set(this.paste(clip, far, far));
    const alone = connectivitySignature(this.sheet, true);
    const s = this.sheet;
    const shift = (dx: number, dy: number) => {
      for (const c of s.components) if (ids.has(c.id)) { c.x += dx; c.y += dy; }
      for (const n of s.texts) if (ids.has(n.id)) { n.x += dx; n.y += dy; }
      for (const w of s.wires) if (ids.has(w.id)) w.points = w.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    };
    shift(offset - far, offset - far);
    for (let tries = 0; tries < 25; tries++) {
      if (connectivitySignature(s, true) === alone) return [...ids];
      shift(40, 40);
    }
    s.components = s.components.filter((c) => !ids.has(c.id));
    s.texts = s.texts.filter((n) => !ids.has(n.id));
    s.wires = s.wires.filter((w) => !ids.has(w.id));
    return undefined;
  }

  findByRef(refDes: string): SchComponent | undefined {
    const wanted = refDes.toUpperCase();
    return this.sheet.components.find((c) => c.refDes.toUpperCase() === wanted);
  }

  /** Draws an orthogonal wire between two pins. Returns undefined, changing nothing, if they're already connected. */
  connectPins(a: SchComponent, pinA: string, b: SchComponent, pinB: string): Wire | undefined {
    const pa = a.pins.find((p) => p.name === pinA);
    const pb = b.pins.find((p) => p.name === pinB);
    if (!pa) throw new Error(`${a.refDes} has no pin "${pinA}". Pins: ${a.pins.map((p) => p.name).join(", ")}.`);
    if (!pb) throw new Error(`${b.refDes} has no pin "${pinB}". Pins: ${b.pins.map((p) => p.name).join(", ")}.`);
    const from = pinWorld(a, pa);
    const to = pinWorld(b, pb);
    const { name, joined } = this.linkName(from, to);
    if (joined) return undefined;
    const path = this.clearRoute(from, to);
    if (path && !this.wireProblem(path)) return this.addWire(path);
    // A crowded sheet may have no clean path, so labels make the same connection.
    this.linkSpots(from, to, name);
    return { id: "", points: [] };
  }

  /**
   * Joins two spots with visible labels, which can be seen and deleted, unlike a connection with
   * nothing drawn. A spot already showing that name keeps its one label, or deleting it would seem to do nothing.
   */
  private linkSpots(from: Point, to: Point, net: string): void {
    for (const { x, y } of [from, to]) {
      if (this.sheet.labels.some((l) => l.net === net && l.x === x && l.y === y && !l.hidden)) continue;
      this.sheet.labels.push({ id: newId("l"), x, y, net });
    }
  }

  /** What labels joining two spots should say: what their nets already go by, ground first, or else a new name. */
  private linkName(a: Point, b: Point): { name: string; joined: boolean } {
    const s = this.sheet;
    const { namedNets } = localNetlist({ ...s, labels: [...s.labels, probeAt(a), probeAt(b, OTHER_PROBE)] });
    const nets = [namedNets.get(PROBE), namedNets.get(OTHER_PROBE)];
    namedNets.delete(PROBE);
    namedNets.delete(OTHER_PROBE);
    const joined = nets[0] === nets[1];
    if (nets.includes("0")) return { name: "0", joined };
    for (const wanted of nets) {
      for (const [name, net] of namedNets) if (net === wanted) return { name, joined };
    }
    const sheets = this.blockPath.length ? [this.sheet] : circuitPages(this.schematic);
    const otherNames = sheets.flatMap((s) => [...s.labels.map((l) => l.net), ...s.components.flatMap((c) => c.pins.flatMap((p) => p.net ? [p.net] : []))]);
    const taken = new Set([...namedNets.keys(), ...otherNames].map((name) => name.toUpperCase()));
    let n = 1;
    while (taken.has(`LINK${n}`)) n++;
    return { name: `LINK${n}`, joined };
  }

  /**
   * Says what a wire along these points would join besides the nets at its two ends, as buildNetlist
   * reads it. The answer is undefined if it would do no more than two labels at its ends.
   */
  wireProblem(points: Point[]): string | undefined {
    const path = simplify(points);
    if (path.length < 2) return undefined;
    const s = this.sheet;
    const labels = [...s.labels, probeAt(path[0]), probeAt(path[path.length - 1])];
    const meant = netMembers({ ...s, labels });
    const drawn = netMembers({ ...s, labels, wires: [...s.wires, { id: "", points: path }] });
    const meantNet = meant.get(`=${PROBE}`)!.net;
    const wireNet = drawn.get(`=${PROBE}`)!.net;
    for (const [key, { net, words }] of drawn) {
      if (net === wireNet && meant.get(key)?.net !== meantNet) {
        return `That would also connect the wire to ${words}, so it wasn't drawn. Click another spot, or press Esc to cancel.`;
      }
    }
    return undefined;
  }

  /** Whether something ending on this spot would join nets that are apart now, as where two wires cross. */
  crossingAt(at: Point): boolean {
    const s = this.sheet;
    const before = netMembers(s);
    const after = netMembers({ ...s, labels: [...s.labels, probeAt(at)] });
    const here = after.get(`=${PROBE}`)!.net;
    const nets = new Set<string>();
    for (const [key, { net }] of after) {
      const was = before.get(key)?.net;
      if (net === here && was !== undefined) nets.add(was);
    }
    return nets.size > 1;
  }

  /**
   * Ends a hand-drawn wire on the pin or wire clicked, or where it stopped if there's no target.
   * It connects those and nothing else. With no path for a wire, labels make the connection. If
   * the corners drawn so far already touch something else, it changes nothing and says why.
   */
  finishWire(draft: Point[], target?: Point): { refused?: string; note?: string } {
    const last = draft[draft.length - 1];
    if (this.crossingAt(target ?? last)) {
      return { refused: "Two wires cross there, so ending on that spot would connect them both. Click a little way along the one you mean, or press Esc to cancel." };
    }
    for (const tail of target ? [this.clearRoute(last, target), route(last, target)] : [[last]]) {
      const points = tail && simplify([...draft.slice(0, -1), ...tail]);
      if (!points || points.length < 2 || this.wireProblem(points)) continue;
      this.checkpoint();
      this.addWire(points);
      return {};
    }
    const problem = this.wireProblem(draft);
    if (problem || !target) return { refused: problem };
    const { name, joined } = this.linkName(draft[0], target);
    if (joined) return { note: "Those are already connected." };
    this.checkpoint();
    this.linkSpots(draft[0], target, name);
    return { note: `There's no clear path for a wire there, so both ends got the net name ${name} instead.` };
  }

  /**
   * Makes an edit on a copy of the circuit and keeps it only if it reports success, so a refusal
   * changes nothing at all. Kept parts stay the same objects, as panels hold on to them.
   */
  private attempt(edit: () => boolean): boolean {
    const document = this.schematic;
    const kept = this.sheet;
    this.schematic = structuredClone(document);
    let done = false;
    try {
      done = edit();
      if (done) {
        const parts = new Map(kept.components.map((c) => [c.id, c]));
        this.sheet.components = this.sheet.components.map((c) => Object.assign(parts.get(c.id) ?? c, c));
        Object.assign(kept, this.sheet);
      }
    } finally {
      this.schematic = document;
    }
    return done;
  }

  /** Removes the wires ending on a pin, and any label on it, cutting that pin's connection. */
  disconnectPin(comp: SchComponent, pinName: string): void {
    const pin = comp.pins.find((p) => p.name === pinName);
    if (!pin) throw new Error(`${comp.refDes} has no pin "${pinName}". Pins: ${comp.pins.map((p) => p.name).join(", ")}.`);
    const at = pinWorld(comp, pin);
    const here = (p: Point | undefined) => p?.x === at.x && p?.y === at.y;
    const ending = (w: Wire) => here(w.points[0]) || here(w.points[w.points.length - 1]);
    const passing = this.sheet.wires.find((w) => !ending(w) && w.points.some((q, i) => i > 0 && onSeg(at, w.points[i - 1], q)));
    if (passing) throw new Error(`A wire runs straight through ${comp.refDes} pin ${pinName}. Move the part off that wire first.`);
    const before = localNetlist(this.sheet).pinNets;
    const net = before.get(comp.id)?.get(pinName);
    if (!net) return;
    const separated = this.attempt(() => {
      // Everything else on this net has to stay together once this pin has left it.
      const peers: { comp: SchComponent; pin: string }[] = [];
      for (const other of this.sheet.components) {
        for (const [name, value] of before.get(other.id) ?? []) {
          if (value === net && !(other.id === comp.id && name === pinName)) peers.push({ comp: other, pin: name });
        }
      }
      this.sheet.wires = this.sheet.wires.filter((w) => !ending(w));
      this.sheet.labels = this.sheet.labels.filter((l) => !here(l));
      const leaving = this.sheet.components.find((c) => c.id === comp.id)!.pins.find((p) => p.name === pinName)!;
      if (leaving.net && leaving.net !== "0") delete leaving.net;
      for (let i = 1; i < peers.length; i++) {
        const nets = localNetlist(this.sheet).pinNets;
        const first = nets.get(peers[0].comp.id)?.get(peers[0].pin);
        if (first === undefined || first !== nets.get(peers[i].comp.id)?.get(peers[i].pin)) {
          this.connectPins(peers[0].comp, peers[0].pin, peers[i].comp, peers[i].pin);
        }
      }
      // Some pins can't leave a net, such as a ground part's own pin or one touching another pin.
      const after = localNetlist(this.sheet).pinNets;
      const remaining = after.get(comp.id)?.get(pinName);
      return remaining === undefined || !peers.some((peer) => after.get(peer.comp.id)?.get(peer.pin) === remaining);
    });
    if (!separated) throw new Error(`${comp.refDes} pin ${pinName} can't be separated from its net, because it's a fixed connection or it touches another pin. Move the part first.`);
  }

  /**
   * Turns or moves parts, rerouting attached wires. Connections must survive, so if routing
   * can't keep them this leaves the circuit as it was and returns false.
   */
  transformParts(comps: SchComponent[], apply: (c: SchComponent) => void): boolean {
    const ids = new Set(comps.map((c) => c.id));
    return this.attempt(() => {
      const parts = this.sheet.components.filter((c) => ids.has(c.id));
      const move = new PartMove(this, parts);
      parts.forEach(apply);
      move.follow(true);
      return move.connectionsKept();
    });
  }

  /**
   * Arranges the circuit left to right in connection order, then reroutes every wire. Keeps all
   * connections and net names, or leaves the circuit as it was and returns false.
   */
  tidyLayout(): boolean {
    return this.attempt(() => {
      const schematic = this.sheet;
      const before = connectivitySignature(schematic);
      const was = localNetlist(schematic);
      const nets = was.pinNets;
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
      // Named nets stay named, on their first pin, with one label however many it had spread around.
      // A hidden link with no pin to hold names nothing. A name someone can see, with no pin on its
      // net, goes below the circuit, as a part landing where it was would silently take that name.
      const below = Math.max(bottom, ...[...pinsAt.values()].map((p) => p.y), ...schematic.components.map((c) => bodyBox(c).y1)) + 40;
      const shown = new Set<string>();
      const loose = new Set<string>();
      let strays = 0;
      schematic.labels = schematic.labels.filter((label) => {
        const first = groups.get(was.namedNets.get(label.net)!)?.[0];
        if (first) {
          label.x = first.x;
          label.y = first.y;
          const key = `${label.net}\n${Boolean(label.hidden)}`;
          if (shown.has(key)) return false;
          shown.add(key);
          return true;
        }
        if (label.hidden) return false;
        loose.add(label.net);
        label.x = 0;
        label.y = Math.ceil(below / 10) * 10 + 30 * strays++;
        return true;
      });
      // Labels carry a net's name as it was given, not as SPICE spells it.
      const spelled = new Map([...was.namedNets].map(([name, net]) => [net, name]));
      for (const [net, points] of groups) {
        for (let i = 1; i < points.length; i++) {
          const path = this.clearRoute(points[0], points[i]);
          if (path) this.addWire(path);
          else this.linkSpots(points[0], points[i], spelled.get(net) ?? net);
        }
      }
      const now = localNetlist(schematic).pinNets;
      const namesKept = [...nets].every(([id, pins]) => [...pins].every(([pin, net]) => was.autoNets.has(net) || now.get(id)?.get(pin) === net));
      // A name that was on no pin must still be on none, as the connection check doesn't read names.
      const stillLoose = new Set(looseNames(schematic));
      return namesKept && [...loose].every((name) => stillLoose.has(name)) && connectivitySignature(schematic) === before;
    });
  }

  /** Removes a part and the wires that end on its pins, as those wires go nowhere afterward. */
  removeComponentAndWires(id: string): void {
    const comp = this.sheet.components.find((c) => c.id === id);
    if (!comp) return;
    const ends = new Set(comp.pins.map((pin) => {
      const at = pinWorld(comp, pin);
      return `${at.x},${at.y}`;
    }));
    const onPin = (p: Point | undefined) => p !== undefined && ends.has(`${p.x},${p.y}`);
    // A wire also joining two other things still carries a connection after the part is gone.
    const others = this.sheet.components.filter((c) => c !== comp).flatMap((c) => c.pins.map((p) => pinWorld(c, p)));
    const wires = this.sheet.wires;
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
    this.sheet.wires = wires.filter((w) => (!onPin(w.points[0]) && !onPin(w.points[w.points.length - 1])) || carriesOthers(w));
    // A label left on an empty spot would silently connect whatever is placed there next.
    this.sheet.labels = this.sheet.labels.filter((l) => !onPin(l));
    this.removeComponent(id);
  }

  /**
   * Finds an orthogonal path that touches no other pin or wire on the way, because
   * anything a wire passes over could join its net. Returns undefined if none is found.
   */
  clearRoute(from: Point, to: Point): Point[] | undefined {
    // A label joins anything touching it, so wires must avoid labels just as they avoid pins.
    const pins: Point[] = this.sheet.labels.map((l) => ({ x: l.x, y: l.y }));
    for (const comp of this.sheet.components) {
      for (const pin of comp.pins) pins.push(pinWorld(comp, pin));
    }
    const wires = this.sheet.wires.map((w) => w.points);
    const offsets = [0];
    for (let d = 20; d <= 400; d += 20) offsets.push(d, -d);
    const candidates: Point[][] = [route(from, to), [from, { x: from.x, y: to.y }, to]];
    const midX = Math.round((from.x + to.x) / 20) * 10;
    const midY = Math.round((from.y + to.y) / 20) * 10;
    for (const d of offsets) {
      candidates.push([from, { x: midX + d, y: from.y }, { x: midX + d, y: to.y }, to]);
      candidates.push([from, { x: from.x, y: midY + d }, { x: to.x, y: midY + d }, to]);
    }
    const bodies = this.sheet.components.map(bodyBox);
    const best = (paths: Point[][]) => {
      const clear = paths.map(simplify).filter((path) => isClear(path, from, to, pins, wires));
      // Running through a symbol is legal but hard to read, so use that only as a last resort.
      return clear.find((path) => !crossesBody(path, bodies)) ?? clear[0];
    };
    return best(candidates) ?? best(sidesteps(from, to, pins));
  }
}

/** A stand-in for something touching a spot, as a label joins by the same rules as a wire's end. */
const PROBE = "\u0001probe";
const OTHER_PROBE = "\u0001other probe";
const probeAt = (at: Point, net = PROBE): NetLabel => ({ id: "", x: at.x, y: at.y, net });

/** What's on each net: pins as "part id/pin" and given names as "=name", with how to say each one. */
function netMembers(schematic: Schematic): Map<string, { net: string; words: string }> {
  const { pinNets, namedNets } = localNetlist(schematic);
  const members = new Map<string, { net: string; words: string }>();
  for (const comp of schematic.components) {
    for (const [pin, net] of pinNets.get(comp.id) ?? []) {
      members.set(`${comp.id}/${pin}`, { net, words: `${comp.refDes || "a part"} pin ${pin}` });
    }
  }
  for (const [name, net] of namedNets) members.set(`=${name}`, { net, words: `the net ${name}` });
  return members;
}

/** Something joined to a wire at a spot: another wire, a part's pin or a net's label. */
interface Contact {
  at: Point;
  wire?: Wire;
  comp?: SchComponent;
  label?: NetLabel;
}

/** What is joined to each wire, by the same rules as buildNetlist. */
function wireContacts(schematic: Schematic): Map<Wire, Contact[]> {
  const CELL = 200;
  const contacts = new Map<Wire, Contact[]>(schematic.wires.map((w) => [w, []]));
  const cells = new Map<string, { a: Point; b: Point; wire: Wire }[]>();
  for (const wire of schematic.wires) {
    for (let i = 1; i < wire.points.length; i++) {
      const a = wire.points[i - 1];
      const b = wire.points[i];
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(a.y, b.y) / CELL); cy <= Math.floor(Math.max(a.y, b.y) / CELL); cy++) {
          const k = `${cx},${cy}`;
          const list = cells.get(k);
          if (list) list.push({ a, b, wire });
          else cells.set(k, [{ a, b, wire }]);
        }
      }
    }
  }
  const rest = (at: Point, on: Omit<Contact, "at">, cornersOnly = false) => {
    for (const { a, b, wire } of cells.get(`${Math.floor(at.x / CELL)},${Math.floor(at.y / CELL)}`) ?? []) {
      if (wire === on.wire || !onSegment(at, a, b)) continue;
      // A corner resting on another wire's run doesn't join it, though two corners do.
      if (cornersOnly && pointKey(at) !== pointKey(a) && pointKey(at) !== pointKey(b)) continue;
      contacts.get(wire)!.push({ at, ...on });
      if (on.wire) contacts.get(on.wire)!.push({ at, wire });
    }
  };
  for (const comp of schematic.components) for (const pin of comp.pins) rest(pinWorld(comp, pin), { comp });
  for (const label of schematic.labels) rest({ x: label.x, y: label.y }, { label });
  for (const wire of schematic.wires) {
    wire.points.forEach((p, i) => rest(p, { wire }, i > 0 && i < wire.points.length - 1));
  }
  return contacts;
}

/** The wire from a moved pin's new spot to where it's held, keeping right angles. */
function bend(path: Point[], to: Point, held: boolean): Point[] {
  const points = simplify(path);
  const [start, next, after] = points;
  if (!next) return route(to, start);
  const flat = start.y === next.y;
  const upright = start.x === next.x;
  const corner = { x: flat ? next.x : to.x, y: flat ? to.y : next.y };
  if (after) {
    // Slides the first run along the second, so the rest of the wire stays where it is.
    const square = (flat && next.x === after.x) || (upright && next.y === after.y);
    return square ? [to, corner, ...points.slice(2)] : [...route(to, start), ...points.slice(1)];
  }
  if (!flat && !upright) return [...route(to, start), next];
  // A held run stays on its line, with a jog at the pin. A free one moves along with the part.
  return [to, held ? { x: flat ? to.x : next.x, y: flat ? next.y : to.y } : corner, next];
}

/** How far along a wire each run through this spot is, counting its points from 0. */
function placesOnWire(points: Point[], at: Point): number[] {
  const places: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (onSegment(at, a, b)) places.push(i - 1 + Math.hypot(at.x - a.x, at.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1));
  }
  return places;
}

/** A wire ending on a moving pin. */
interface FollowingWire {
  wire: Wire;
  original: Point[];
  /** The part that stays put, and the free parts either side leading to moving pins. Absent if nothing holds it. */
  held?: {
    middle: Point[];
    head?: Point[];
    tail?: Point[];
    headOnRun: boolean;
    tailOnRun: boolean;
  };
}

/**
 * One move of the selected parts, from where they began. Wires follow their pins, while anything
 * else joined to a wire holds that spot of it in place, so tees and named nets stay connected.
 */
export class PartMove {
  private before: string;
  private pins: { comp: SchComponent; pin: Point; from: Point }[];
  private comps: { comp: SchComponent; x: number; y: number }[];
  private carried: { wire: Wire; original: Point[] }[] = [];
  private following: FollowingWire[] = [];
  private labels: { label: NetLabel; from: Point; onPin: boolean }[] = [];
  private notes: { note: FreeText; x: number; y: number }[] = [];
  /** New wires back to spots that can't follow, such as a run passing through a pin. */
  private leads: { from: Point; wire: Wire; added: boolean }[] = [];

  constructor(private doc: Doc, comps: SchComponent[], selection: Set<string> = new Set()) {
    const s = doc.sheet;
    this.before = connectivitySignature(s, true);
    this.comps = comps.map((comp) => ({ comp, x: comp.x, y: comp.y }));
    this.pins = comps.flatMap((comp) => comp.pins.map((pin) => ({ comp, pin, from: pinWorld(comp, pin) })));
    this.notes = s.texts.filter((n) => selection.has(n.id)).map((note) => ({ note, x: note.x, y: note.y }));
    const moving = new Set(comps);
    const spots = new Set(this.pins.map((p) => pointKey(p.from)));
    const contacts = wireContacts(s);

    // Selected wires travel with the selection, unless they're joined to something staying put.
    const carried = new Set(s.wires.filter((w) => selection.has(w.id)));
    const staysPut = (c: Contact) => (c.comp && !moving.has(c.comp)) || (c.wire && !carried.has(c.wire));
    for (let changed = true; changed;) {
      changed = false;
      for (const wire of carried) {
        if (contacts.get(wire)!.some(staysPut)) {
          carried.delete(wire);
          changed = true;
        }
      }
    }
    this.carried = [...carried].map((wire) => ({ wire, original: wire.points }));

    // A label on a pin holds that pin's connection, and one on a carried wire goes with it.
    const onlyNotes = !comps.length && !carried.size;
    const onWire = new Map<NetLabel, Wire[]>();
    for (const [wire, list] of contacts) {
      for (const { label } of list) if (label) onWire.set(label, [...(onWire.get(label) ?? []), wire]);
    }
    const travelling = new Set<NetLabel>();
    for (const label of s.labels) {
      const wires = onWire.get(label) ?? [];
      const onPin = spots.has(pointKey(label));
      const picked = selection.has(label.id) && (onlyNotes || wires.every((w) => carried.has(w)));
      if (!onPin && !picked && !wires.some((w) => carried.has(w))) continue;
      travelling.add(label);
      this.labels.push({ label, from: { x: label.x, y: label.y }, onPin });
    }

    const ends = new Set<string>();
    const passes = new Set<string>();
    for (const wire of s.wires) {
      const points = wire.points;
      if (carried.has(wire) || points.length < 2) continue;
      const first = points[0];
      const last = points[points.length - 1];
      ends.add(pointKey(first));
      ends.add(pointKey(last));
      const holds = contacts.get(wire)!.filter((c) => {
        if (c.comp) return !moving.has(c.comp);
        if (c.label) return !travelling.has(c.label);
        // A wire ending on a moving pin leaves with that pin.
        const other = c.wire!.points;
        const leaves = spots.has(pointKey(c.at)) && (pointKey(other[0]) === pointKey(c.at) || pointKey(other[other.length - 1]) === pointKey(c.at));
        return !leaves;
      });
      for (const c of contacts.get(wire)!) if (c.comp && moving.has(c.comp)) passes.add(pointKey(c.at));
      if (spots.has(pointKey(first)) || spots.has(pointKey(last))) this.following.push(this.planWire(wire, holds, spots));
    }
    // Pins resting on what can't follow them keep their connection through a new lead.
    const fixedPins = new Set(s.components.filter((c) => !moving.has(c)).flatMap((c) => c.pins.map((p) => pointKey(pinWorld(c, p)))));
    const led = new Set<string>();
    for (const { from } of this.pins) {
      const spot = pointKey(from);
      if (ends.has(spot) || led.has(spot) || !(passes.has(spot) || fixedPins.has(spot))) continue;
      led.add(spot);
      this.leads.push({ from, wire: { id: newId("w"), points: [] }, added: false });
    }
  }

  private planWire(wire: Wire, holds: Contact[], spots: Set<string>): FollowingWire {
    const points = wire.points;
    const n = points.length - 1;
    const headMoves = spots.has(pointKey(points[0]));
    const tailMoves = spots.has(pointKey(points[n]));
    const placed: { place: number; at: Point }[] = [];
    if (!headMoves) placed.push({ place: 0, at: points[0] });
    if (!tailMoves) placed.push({ place: n, at: points[n] });
    for (const hold of holds) for (const place of placesOnWire(points, hold.at)) placed.push({ place, at: hold.at });
    if (!placed.length) return { wire, original: points };
    placed.sort((a, b) => a.place - b.place);
    const from = placed[0];
    const to = placed[placed.length - 1];
    const joined = (at: Point) => holds.some((h) => (h.wire || h.label) && pointKey(h.at) === pointKey(at));
    return {
      wire,
      original: points,
      held: {
        middle: [from.at, ...points.slice(Math.ceil(from.place), Math.floor(to.place) + 1), to.at],
        head: headMoves ? [...points.slice(0, Math.floor(from.place) + 1), from.at] : undefined,
        tail: tailMoves ? [...points.slice(Math.ceil(to.place)).reverse(), to.at] : undefined,
        headOnRun: from.place < n || joined(from.at),
        tailOnRun: to.place > 0 || joined(to.at),
      },
    };
  }

  /** Puts everything at this offset from where it began. */
  shift(dx: number, dy: number): void {
    for (const { comp, x, y } of this.comps) { comp.x = x + dx; comp.y = y + dy; }
    for (const { note, x, y } of this.notes) { note.x = x + dx; note.y = y + dy; }
    for (const { wire, original } of this.carried) wire.points = original.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    for (const { label, from, onPin } of this.labels) {
      if (!onPin) { label.x = from.x + dx; label.y = from.y + dy; }
    }
    this.follow();
  }

  /** Brings wires and labels to the pins where they are now. Careful routes around everything, which is slower. */
  follow(careful = false): void {
    // Pins can swap places, so this always works from where they began.
    const to = new Map(this.pins.map(({ comp, pin, from }) => [pointKey(from), pinWorld(comp, pin)]));
    for (const { label, from, onPin } of this.labels) {
      if (onPin) Object.assign(label, to.get(pointKey(from)));
    }
    if (careful) {
      // Routes keep clear of what stays, and of each other as they're placed.
      for (const f of this.following) f.wire.points = f.held?.middle ?? [];
      for (const lead of this.leads) lead.wire.points = [];
    }
    const lead = (at: Point, path: Point[], held: boolean) => {
      const clear = careful ? this.doc.clearRoute(at, path[path.length - 1]) : undefined;
      return clear ?? bend(path, at, held);
    };
    for (const { wire, original, held } of this.following) {
      const first = original[0];
      const last = original[original.length - 1];
      const a = to.get(pointKey(first));
      const b = to.get(pointKey(last));
      if (!held) {
        // Both ends moved, so a wire with nothing else on it keeps its shape if it can.
        const dx = a!.x - first.x;
        const dy = a!.y - first.y;
        wire.points = dx === b!.x - last.x && dy === b!.y - last.y
          ? original.map((p) => ({ x: p.x + dx, y: p.y + dy }))
          : (careful ? this.doc.clearRoute(a!, b!) : undefined) ?? route(a!, b!);
        continue;
      }
      const head = held.head ? lead(a!, held.head, held.headOnRun) : [];
      const tail = held.tail ? lead(b!, held.tail, held.tailOnRun).reverse() : [];
      wire.points = simplify([...head, ...held.middle, ...tail]);
    }
    for (const item of this.leads) {
      const at = to.get(pointKey(item.from))!;
      item.wire.points = (careful ? this.doc.clearRoute(at, item.from) : undefined) ?? route(at, item.from);
      if (!item.added) {
        this.doc.sheet.wires.push(item.wire);
        item.added = true;
      }
    }
  }

  /** Whether the connections and net names match how they began. Clears away wires that have shrunk to nothing. */
  connectionsKept(): boolean {
    const s = this.doc.sheet;
    if (connectivitySignature(s, true) !== this.before) return false;
    const shrunk = new Set([...this.following.map((f) => f.wire), ...this.leads.map((l) => l.wire)].filter((w) => simplify(w.points).length < 2));
    if (shrunk.size) s.wires = s.wires.filter((w) => !shrunk.has(w));
    return true;
  }

  /** Ends a drag. Bending can land on another wire or pin, so that reroutes cleanly before giving up. */
  settle(): boolean {
    if (this.connectionsKept()) return true;
    this.follow(true);
    return this.connectionsKept();
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

/**
 * For two ends in line with pins between them, when the far end can only be reached along that
 * line, as where it tees into a wire: step aside, pass them, and come back onto the line.
 */
function sidesteps(from: Point, to: Point, pins: Point[]): Point[][] {
  const upright = from.x === to.x;
  const paths: Point[][] = [];
  if (!upright && from.y !== to.y) return paths;
  const along = (p: Point) => (upright ? p.y : p.x);
  const inLine = pins.filter((p) => (upright ? p.x === to.x : p.y === to.y) && !same(p, from) && !same(p, to) && onSeg(p, from, to));
  // Back onto the line halfway from the far end to the nearest of them, as that gap can be short.
  const gap = Math.min(...inLine.map((p) => Math.abs(along(p) - along(to))));
  if (!Number.isFinite(gap)) return paths;
  const on = along(to) + Math.sign(along(from) - along(to)) * Math.round(gap / 2);
  for (let d = 20; d <= 200; d += 20) {
    for (const aside of [d, -d]) {
      paths.push(upright
        ? [from, { x: from.x + aside, y: from.y }, { x: from.x + aside, y: on }, { x: to.x, y: on }, to]
        : [from, { x: from.x, y: from.y + aside }, { x: on, y: from.y + aside }, { x: on, y: to.y }, to]);
    }
  }
  return paths;
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

/** Drops repeated points, and those in the middle of a straight run. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    // A wire doubling back still covers the far spot, and something may be joined there.
    const onward = prev && last && (last.x - prev.x) * (p.x - last.x) + (last.y - prev.y) * (p.y - last.y) > 0;
    if (onward && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) {
      out[out.length - 1] = p;
    } else {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}
