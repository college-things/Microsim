// Turns a schematic into SPICE text by resolving wire geometry into named nets.
import { PART_BY_KIND } from "./library";
import type { Graphic, Point, SchComponent, Schematic } from "./schematic";

export interface NetlistResult {
  text: string;
  /** Net name per component id and pin name. Unconnected pins are absent. */
  pinNets: Map<string, Map<string, string>>;
  /** SPICE name per component id. Differs from refDes when the display name is unsafe. */
  refs: Map<string, string>;
  /** Nets named only by their number here, which any edit can renumber. */
  autoNets: Set<string>;
  /** The net each given name ended up on, as a name's characters may not survive into SPICE. */
  namedNets: Map<string, string>;
  warnings: string[];
  /** Problems that would give wrong answers, so a run must not start. */
  errors: string[];
}

export function pinWorld(comp: SchComponent, pin: Point): Point {
  const x = comp.mirrored ? -pin.x : pin.x;
  switch (comp.rotation) {
    case 90: return { x: comp.x - pin.y, y: comp.y + x };
    case 180: return { x: comp.x - x, y: comp.y - pin.y };
    case 270: return { x: comp.x + pin.y, y: comp.y - x };
    default: return { x: comp.x + x, y: comp.y + pin.y };
  }
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function symbolGraphics(comp: SchComponent): Graphic[] {
  return comp.graphics ?? PART_BY_KIND.get(comp.kind)?.graphics ?? [];
}

/** A part's symbol and pins in its own coordinates. */
export function symbolBounds(comp: SchComponent): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const g of symbolGraphics(comp)) {
    if (g.kind === "line" || g.kind === "polygon") g.points.forEach((p) => add(p.x, p.y));
    else if (g.kind === "rect") { add(g.x, g.y); add(g.x + g.w, g.y + g.h); }
    else if (g.kind === "ellipse") { add(g.cx - g.rx, g.cy - g.ry); add(g.cx + g.rx, g.cy + g.ry); }
  }
  for (const p of comp.pins) add(p.x, p.y);
  if (!Number.isFinite(x0)) { x0 = y0 = -10; x1 = y1 = 10; }
  return { x0, y0, x1, y1 };
}

/** The same box on the sheet, once the part is placed, rotated and mirrored. */
export function placedBounds(comp: SchComponent, b: Bounds = symbolBounds(comp)): Bounds {
  const corners = [
    pinWorld(comp, { x: b.x0, y: b.y0 }), pinWorld(comp, { x: b.x1, y: b.y0 }),
    pinWorld(comp, { x: b.x0, y: b.y1 }), pinWorld(comp, { x: b.x1, y: b.y1 }),
  ];
  return {
    x0: Math.min(...corners.map((p) => p.x)), y0: Math.min(...corners.map((p) => p.y)),
    x1: Math.max(...corners.map((p) => p.x)), y1: Math.max(...corners.map((p) => p.y)),
  };
}

/** The value printed below a part on the sheet. */
export function shownValue(comp: SchComponent): string | undefined {
  const part = PART_BY_KIND.get(comp.kind);
  return comp.displayValue ?? (part?.valueParam ? comp.params[part.valueParam] : undefined);
}

// How many nodes each kind of SPICE element starts with. The rest of its line is values and models.
const NODE_COUNTS: Record<string, number> = { b: 2, c: 2, d: 2, e: 4, f: 2, g: 4, h: 2, i: 2, j: 3, l: 2, m: 4, o: 4, q: 4, r: 2, s: 4, t: 4, u: 3, v: 2, w: 4, z: 3 };

/** Whether SPICE text with no pins of its own, such as an opened deck, connects anything to ground. */
export function deckUsesGround(text: string): boolean {
  return text.split("\n").some((line) => {
    const words = line.trim().toLowerCase().replace(/[[\]]/g, " ").split(/\s+/);
    const letter = words[0]?.[0];
    if (!letter || "*.+;".includes(letter)) return false;
    // Subcircuits and logic devices end in a model name, and may have settings after it.
    const settings = words.findIndex((word) => word.includes("="));
    const nodes = letter === "x" || letter === "a"
      ? words.slice(1, settings < 0 ? -1 : settings - 1)
      : words.slice(1, (NODE_COUNTS[letter] ?? 0) + 1);
    return nodes.some((node) => node === "0" || node === "gnd" || node === "gnd!");
  });
}

class Union {
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
      const next: string = this.parent.get(cur)!;
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

export const pointKey = (p: Point) => `${Math.round(p.x)},${Math.round(p.y)}`;

export function onSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 0.5) return false;
  return p.x >= Math.min(a.x, b.x) - 0.5 && p.x <= Math.max(a.x, b.x) + 0.5
    && p.y >= Math.min(a.y, b.y) - 0.5 && p.y <= Math.max(a.y, b.y) + 0.5;
}

const SCALE: Record<string, number> = {
  f: 1e-15, p: 1e-12, P: 1e-12, n: 1e-9, N: 1e-9, u: 1e-6, U: 1e-6, "µ": 1e-6, "μ": 1e-6,
  m: 1e-3, M: 1e6, k: 1e3, K: 1e3, g: 1e9, G: 1e9, t: 1e12, T: 1e12,
};

/**
 * Reads a typed value. Case matters as on a schematic: m is milli and M is mega.
 * Trailing unit letters are allowed, as in 10kOhm or 2.2uF. Returns undefined for
 * anything that isn't clearly one number, such as "1,5k", "10%", "2 3" or "1k2".
 */
export function readValue(text: string | undefined): number | undefined {
  const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)\s*(.*?)\s*$/s.exec(text ?? "");
  if (!match) return undefined;
  const base = parseFloat(match[1]);
  let rest = match[3];
  let scale = 1;
  if (/^meg/i.test(rest)) {
    scale = 1e6;
    rest = rest.slice(3);
  } else if (rest && SCALE[rest[0]] !== undefined) {
    scale = SCALE[rest[0]];
    rest = rest.slice(1);
  }
  if (!/^[a-zA-ZΩ°]*$/.test(rest)) return undefined;
  if (match[2] && scale !== 1) return undefined;
  const value = base * scale;
  return Number.isFinite(value) ? value : undefined;
}

/** readValue, with 0 for unreadable text. Use where a caller supplies its own default. */
export function parseValue(text: string | undefined): number {
  return readValue(text) ?? 0;
}

/** Whether a circuit does anything over time: a source that varies, or a logic device or switch. */
export function changesOverTime(netlist: string): boolean {
  return /\b(sin|pulse|pwl|exp|sffm|am)\s*\(/i.test(netlist) || /\btime\b/i.test(netlist.replace(/^\s*\*.*$/gm, "")) || /^a\S*\s/im.test(netlist) || /^\.model\s+\S+\s+(d_|sw\b)/im.test(netlist);
}

const unsafe = (text: string) => text.replace(/[\r\n\u0000-\u001f\u2028\u2029]+/g, " ");

function expand(template: string, comp: SchComponent, ref: string, nets: Map<string, string>, params: Record<string, string>, unconnected: (ref: string, pin: string) => string): string {
  return template
    .replace(/\{ref\}/g, ref)
    .replace(/\{pin:([^}]+)\}/g, (_, pin: string) => nets.get(pin) ?? unconnected(ref, pin))
    .replace(/\{param:([^}]+)\}/g, (_, name: string) => unsafe(params[name] ?? comp.params[name] ?? "0"));
}

/** A part that repeats needs a period. Zero would otherwise show as typed and run as something else. */
export function frequencyProblem(comp: SchComponent, text = comp.params.freq): string | undefined {
  if (comp.instrument !== "function-generator" && comp.instrument !== "clock") return undefined;
  return text === undefined || (readValue(text) ?? 0) > 0 ? undefined : "Frequency must be a number greater than zero.";
}

/** SPICE for parts whose circuit form depends on their settings. */
function instrumentSpice(comp: SchComponent): string {
  const p = comp.params;
  if (comp.kind === "switch") {
    return "R{ref} {pin:1} {pin:2} " + (p.state === "closed" ? "1m" : "1G");
  }
  if (comp.kind === "potentiometer") {
    const total = parseValue(p.value) || 1;
    const fraction = Math.min(1, Math.max(0, parseValue(p.percent) / 100));
    // A small floor keeps the end positions from shorting the wiper exactly.
    const upper = Math.max(1e-3, total * fraction);
    const lower = Math.max(1e-3, total * (1 - fraction));
    return `R{ref}A {pin:1} {pin:w} ${upper}\nR{ref}B {pin:w} {pin:2} ${lower}`;
  }
  if (comp.instrument === "clock") {
    const period = 1 / (parseValue(p.freq) || 1000);
    const edge = period * 1e-3;
    return `V{ref} {pin:p} {pin:n} PULSE(0 ${parseValue(p.high) || 5} 0 ${edge} ${edge} ${period / 2 - edge} ${period})`;
  }
  if (comp.instrument === "wattmeter") {
    return "V{ref} {pin:i+} {pin:i-} DC 0";
  }
  if (comp.instrument === "function-generator") {
    const freq = parseValue(p.freq) || 1000;
    const amp = parseValue(p.amp);
    const offset = parseValue(p.offset);
    if (p.shape === "sine") {
      return `V{ref} {pin:p} {pin:n} DC ${offset} AC 1 SIN(${offset} ${amp} ${freq})`;
    }
    const period = 1 / freq;
    if (p.shape === "triangle") {
      const half = period / 2;
      return `V{ref} {pin:p} {pin:n} PULSE(${offset - amp} ${offset + amp} 0 ${half} ${half} ${period * 1e-6} ${period}) AC 1`;
    }
    const edge = period * 1e-3;
    const width = Math.max(edge, (parseValue(p.duty) / 100) * period - edge);
    return `V{ref} {pin:p} {pin:n} PULSE(${offset - amp} ${offset + amp} 0 ${edge} ${edge} ${width} ${period}) AC 1`;
  }
  if (comp.instrument === "multimeter") {
    if (p.mode === "amps") return "V{ref} {pin:p} {pin:n} DC 0";
    if (p.mode === "ohms") return "I{ref} {pin:n} {pin:p} DC 1m";
  }
  return "";
}

const POSITIVE = new Set(["resistor", "capacitor", "inductor", "potentiometer"]);

/** Checks a library part's numeric settings and returns them as plain numbers for SPICE. */
function checkedParams(comp: SchComponent, errors: string[]): Record<string, string> {
  const part = PART_BY_KIND.get(comp.kind);
  const frequency = frequencyProblem(comp);
  // A library part's unreadable value gets its own message below.
  if (frequency && (!part || readValue(comp.params.freq) !== undefined)) errors.push(`${comp.refDes || part?.name}: ${frequency}`);
  if (!part) return comp.params;
  const out: Record<string, string> = { ...comp.params };
  for (const def of part.params) {
    if (def.options || def.text) continue;
    const raw = comp.params[def.key] ?? def.default;
    const value = readValue(raw);
    if (value === undefined) {
      errors.push(`${comp.refDes || part.name}: "${raw}" is not a valid ${def.label.toLowerCase()}.`);
      continue;
    }
    if (def.key === "value" && POSITIVE.has(comp.kind) && value <= 0) {
      errors.push(`${comp.refDes || part.name}: ${def.label.toLowerCase()} must be greater than zero.`);
    }
    if (["holding-tank", "conveyor"].includes(comp.kind) && (["capacity", "length"].includes(def.key) ? value <= 0 : value < 0)) errors.push(`${comp.refDes}: ${def.label} must be ${["capacity", "length"].includes(def.key) ? "positive" : "nonnegative"}.`);
    out[def.key] = String(value);
  }
  return out;
}

export function componentTemplate(comp: SchComponent): string {
  return comp.instrument || comp.kind === "switch" || comp.kind === "potentiometer" ? instrumentSpice(comp) : comp.spice;
}

/** Names a part for SPICE so that a display name can never change what the part is. */
function spiceRefs(doc: Schematic, warnings: string[]): Map<string, string> {
  const refs = new Map<string, string>();
  const used = new Set<string>();
  // Parts that simulate choose first, so a drawing-only part can't take a name that a
  // source or expression refers to.
  const simulates = (c: SchComponent) => Boolean(c.spice.trim() || c.instrument);
  for (const comp of [...doc.components.filter(simulates), ...doc.components.filter((c) => !simulates(c))]) {
    const part = PART_BY_KIND.get(comp.kind);
    let token = comp.refDes.replace(/[^A-Za-z0-9_]/g, "_");
    if (!token) token = `P_${comp.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
    // The first letter of a SPICE name selects the device, so it must match the part.
    if (part?.spice.startsWith("{ref}") && token[0].toUpperCase() !== part.prefix[0].toUpperCase()) {
      token = `${part.prefix[0]}_${token}`;
    }
    if (used.has(token.toUpperCase())) {
      let n = 2;
      while (used.has(`${token}_${n}`.toUpperCase())) n++;
      if (comp.refDes && (comp.spice || comp.instrument)) warnings.push(`Two parts are named ${comp.refDes}. Give each a different name.`);
      token = `${token}_${n}`;
    }
    used.add(token.toUpperCase());
    refs.set(comp.id, token);
  }
  return refs;
}

export function buildNetlist(doc: Schematic): NetlistResult {
  const union = new Union();
  const warnings: string[] = [];
  const errors: string[] = [];
  const pins: { comp: SchComponent; name: string; id: string; at: Point }[] = [];

  for (const comp of doc.components) {
    for (const pin of comp.pins) {
      const at = pinWorld(comp, pin);
      const id = `${comp.id}/${pin.name}`;
      pins.push({ comp, name: pin.name, id, at });
      union.join(id, `pt:${pointKey(at)}`);
      if (pin.net) union.join(id, `net:${pin.net}`);
    }
  }

  // Index wire segments by coarse cell so large imported sheets stay near linear.
  const CELL = 200;
  const cells = new Map<string, { a: Point; b: Point; id: string }[]>();
  doc.wires.forEach((wire) => {
    for (let i = 0; i < wire.points.length; i++) {
      union.join(`wire:${wire.id}`, `pt:${pointKey(wire.points[i])}`);
      if (i === 0) continue;
      const a = wire.points[i - 1];
      const b = wire.points[i];
      const seg = { a, b, id: wire.id };
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(a.y, b.y) / CELL); cy <= Math.floor(Math.max(a.y, b.y) / CELL); cy++) {
          const k = `${cx},${cy}`;
          const list = cells.get(k);
          if (list) list.push(seg);
          else cells.set(k, [seg]);
        }
      }
    }
  });
  const touching = (p: Point) => cells.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`) ?? [];

  // A T-junction joins only where an endpoint or pin lands on a segment; plain crossings stay apart.
  for (const wire of doc.wires) {
    for (const end of [wire.points[0], wire.points[wire.points.length - 1]]) {
      if (!end) continue;
      for (const seg of touching(end)) {
        if (seg.id !== wire.id && onSegment(end, seg.a, seg.b)) union.join(`wire:${wire.id}`, `wire:${seg.id}`);
      }
    }
  }
  for (const pin of pins) {
    for (const seg of touching(pin.at)) {
      if (onSegment(pin.at, seg.a, seg.b)) union.join(pin.id, `wire:${seg.id}`);
    }
  }
  for (const label of doc.labels) {
    const at = { x: label.x, y: label.y };
    union.join(`net:${label.net}`, `pt:${pointKey(at)}`);
    for (const seg of touching(at)) {
      if (onSegment(at, seg.a, seg.b)) union.join(`net:${label.net}`, `wire:${seg.id}`);
    }
  }

  // Name each group, preferring ground and then the user's label. Distinct labels keep
  // distinct names even when their characters aren't legal in SPICE.
  const names = new Map<string, string>();
  const taken = new Set<string>(["0"]);
  const nameSources = new Set<string>();
  for (const comp of doc.components) for (const pin of comp.pins) if (pin.net) nameSources.add(pin.net);
  for (const label of doc.labels) nameSources.add(label.net);
  const sorted = [...nameSources].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const isGround = (net: string) => net === "0" || net.toLowerCase() === "gnd";
  for (const net of sorted) if (isGround(net)) names.set(union.find(`net:${net}`), "0");
  for (const net of sorted) {
    const root = union.find(`net:${net}`);
    if (names.has(root)) continue;
    const base = net.replace(/[\s(),=;*{}[\]'"\u0000-\u001f]+/g, "_") || "net";
    let clean = base;
    for (let n = 2; taken.has(clean.toLowerCase()); n++) clean = `${base}_${n}`;
    taken.add(clean.toLowerCase());
    names.set(root, clean);
  }
  const namedNets = new Map(sorted.map((net) => [net, names.get(union.find(`net:${net}`))!]));

  // Count how many things share a group, to tell real connections from a lone pin.
  const population = new Map<string, number>();
  for (const pin of pins) {
    const root = union.find(pin.id);
    population.set(root, (population.get(root) ?? 0) + 1);
  }
  for (const wire of doc.wires) {
    const root = union.find(`wire:${wire.id}`);
    population.set(root, (population.get(root) ?? 0) + 1);
  }

  let auto = 1;
  const autoNets = new Set<string>();
  const pinNets = new Map<string, Map<string, string>>();
  for (const pin of pins) {
    const root = union.find(pin.id);
    let net = names.get(root);
    if (!net && (population.get(root) ?? 0) > 1) {
      while (taken.has(`n${auto}`)) auto++;
      net = `n${auto++}`;
      taken.add(net);
      autoNets.add(net);
      names.set(root, net);
    }
    if (!net) continue;
    let map = pinNets.get(pin.comp.id);
    if (!map) pinNets.set(pin.comp.id, (map = new Map()));
    map.set(pin.name, net);
  }

  // Every unconnected pin is a node of its own, whatever its name comes to once it's safe for SPICE.
  const unconnectedNets = new Map<string, string>();
  const unconnected = (ref: string, pin: string) => {
    const key = `${ref}/${pin}`;
    let net = unconnectedNets.get(key);
    if (!net) {
      const base = `nc_${ref}_${pin}`.replace(/[^\w]/g, "_");
      net = base;
      for (let n = 2; taken.has(net.toLowerCase()); n++) net = `${base}_${n}`;
      taken.add(net.toLowerCase());
      unconnectedNets.set(key, net);
    }
    return net;
  };

  const refs = spiceRefs(doc, warnings);
  const lines = [`* ${unsafe(doc.name)}`];
  const definitions = new Set<string>();
  if (doc.definitions.trim()) definitions.add(doc.definitions.trim());
  let hasGround = false;
  for (const comp of doc.components) {
    const part = PART_BY_KIND.get(comp.kind);
    const params = checkedParams(comp, errors);
    const template = componentTemplate({ ...comp, params });
    const nets = pinNets.get(comp.id) ?? new Map<string, string>();
    for (const net of nets.values()) if (net === "0") hasGround = true;
    if (!comp.pins.length && deckUsesGround(template)) hasGround = true;
    if (!template.trim()) continue;
    for (const pin of comp.pins) {
      if (!nets.has(pin.name) && !(pin.optional ?? part?.pins.find((p) => p.name === pin.name)?.optional)) warnings.push(`${comp.refDes || part?.name}: pin ${pin.name} is not connected.`);
    }
    lines.push(expand(template, comp, refs.get(comp.id)!, nets, params, unconnected));
    if (part?.definitions) definitions.add(part.definitions);
  }
  if (!hasGround && doc.components.length) warnings.push("The circuit has no ground connection.");
  for (const def of definitions) lines.push(def);
  lines.push(".end");
  return { text: lines.join("\n"), pinNets, refs, autoNets, namedNets, warnings, errors };
}

/** Which net every pin is on, by part id, so a part's name and position make no difference. */
export function pinNetsKey(pinNets: NetlistResult["pinNets"]): string {
  return [...pinNets].map(([id, nets]) => `${id} ${[...nets].map(([pin, net]) => `${pin}=${net}`).join(" ")}`).join("\n");
}

/**
 * What a run's readings depend on. Instruments read their nets without being in the netlist, so
 * which node one watches counts as well as the text. Moving a part changes neither.
 */
export function runSignature(netlist: NetlistResult): string {
  return `${netlist.text}\n${pinNetsKey(netlist.pinNets)}`;
}

/** Independent sources at the top level of a netlist, which analyses can drive. */
export function listSources(netlist: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (const line of netlist.split("\n").slice(1)) {
    const text = line.trim();
    const lower = text.toLowerCase();
    if (lower.startsWith(".subckt")) depth++;
    else if (lower.startsWith(".ends")) depth = Math.max(0, depth - 1);
    else if (!depth && /^[vi]/i.test(text)) names.push(text.split(/\s+/)[0]);
  }
  return names;
}

/** Finds the SPICE source for a name a person typed, which may be the part's sheet name. */
export function resolveSource(netlist: string, typed: string): string | undefined {
  const sources = listSources(netlist);
  const wanted = typed.trim().toLowerCase();
  return sources.find((s) => s.toLowerCase() === wanted)
    ?? sources.find((s) => s.toLowerCase() === `v${wanted}` || s.toLowerCase() === `i${wanted}`);
}

/**
 * Where the drawing needs a dot: three or more branches meeting at a point buildNetlist joins.
 * A run counts twice at a point along it, as it leaves both ways. A corner resting on another
 * wire's run doesn't join it, so runs count only at wire ends, pins and labels.
 */
export function junctions(doc: Pick<Schematic, "components" | "wires" | "labels">): Point[] {
  const spots = new Map<string, { at: Point; branches: number; joins: boolean }>();
  const spot = (at: Point) => {
    let found = spots.get(pointKey(at));
    if (!found) spots.set(pointKey(at), found = { at, branches: 0, joins: false });
    return found;
  };
  // Filed by row and column, as this runs on every frame and big sheets have many wires.
  const runs = new Map<string, { a: Point; b: Point }[]>();
  const file = (name: string, run: { a: Point; b: Point }) => {
    const list = runs.get(name);
    if (list) list.push(run);
    else runs.set(name, [run]);
  };
  for (const wire of doc.wires) {
    wire.points.forEach((b, i) => {
      const a = wire.points[i - 1];
      if (!a || pointKey(a) === pointKey(b)) return;
      spot(a).branches++;
      spot(b).branches++;
      file(a.y === b.y ? `y${Math.round(a.y)}` : a.x === b.x ? `x${Math.round(a.x)}` : "slanted", { a, b });
    });
    for (const end of [wire.points[0], wire.points[wire.points.length - 1]]) if (end) spot(end).joins = true;
  }
  for (const comp of doc.components) {
    for (const pin of comp.pins) {
      const found = spot(pinWorld(comp, pin));
      found.branches++;
      found.joins = true;
    }
  }
  for (const label of doc.labels) spot({ x: label.x, y: label.y }).joins = true;
  const dots: Point[] = [];
  for (const { at, branches, joins } of spots.values()) {
    let total = branches;
    if (joins) {
      const here = pointKey(at);
      for (const name of [`y${Math.round(at.y)}`, `x${Math.round(at.x)}`, "slanted"]) {
        for (const { a, b } of runs.get(name) ?? []) {
          if (pointKey(a) !== here && pointKey(b) !== here && onSegment(at, a, b)) total += 2;
        }
      }
    }
    if (total >= 3) dots.push(at);
  }
  return dots;
}

/** Names on nets with no pin, which join nothing now but take in whatever lands on them. */
export function looseNames(doc: Schematic): string[] {
  const { pinNets, namedNets } = buildNetlist(doc);
  const onPins = new Set([...pinNets.values()].flatMap((nets) => [...nets.values()]));
  return [...namedNets].filter(([, net]) => !onPins.has(net)).map(([name]) => name);
}

/**
 * Which pins are joined together. Equal means same connections. With names, a net's given
 * name counts too, as a move mustn't quietly lose it.
 */
export function connectivitySignature(doc: Schematic, names = false): string {
  const { pinNets, autoNets } = buildNetlist(doc);
  const groups = new Map<string, string[]>();
  for (const [id, nets] of pinNets) {
    for (const [pin, net] of nets) {
      const list = groups.get(net);
      if (list) list.push(`${id}/${pin}`);
      else groups.set(net, [`${id}/${pin}`]);
    }
  }
  const named = (net: string) => names && !autoNets.has(net);
  return [...groups]
    .filter(([net, g]) => g.length > 1 || named(net))
    .map(([net, g]) => (named(net) ? `${net}: ` : "") + g.sort().join("|"))
    .sort()
    .join("\n");
}
