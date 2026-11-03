// Turns a schematic into SPICE text by resolving wire geometry into named nets.
import { PART_BY_KIND } from "./library";
import type { Point, SchComponent, Schematic } from "./schematic";

export interface NetlistResult {
  text: string;
  /** Net name per component id and pin name. Unconnected pins are absent. */
  pinNets: Map<string, Map<string, string>>;
  /** SPICE name per component id. Differs from refDes when the display name is unsafe. */
  refs: Map<string, string>;
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

const key = (p: Point) => `${Math.round(p.x)},${Math.round(p.y)}`;

function onSegment(p: Point, a: Point, b: Point): boolean {
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

const unsafe = (text: string) => text.replace(/[\r\n\u0000-\u001f\u2028\u2029]+/g, " ");

function expand(template: string, comp: SchComponent, ref: string, nets: Map<string, string>, params: Record<string, string>): string {
  return template
    .replace(/\{ref\}/g, ref)
    .replace(/\{pin:([^}]+)\}/g, (_, pin: string) => nets.get(pin) ?? `nc_${ref}_${pin}`.replace(/[^\w]/g, "_"))
    .replace(/\{param:([^}]+)\}/g, (_, name: string) => unsafe(params[name] ?? comp.params[name] ?? "0"));
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
      return `V{ref} {pin:p} {pin:n} PULSE(${offset - amp} ${offset + amp} 0 ${half} ${half} ${period * 1e-6} ${period})`;
    }
    const edge = period * 1e-3;
    const width = Math.max(edge, (parseValue(p.duty) / 100) * period - edge);
    return `V{ref} {pin:p} {pin:n} PULSE(${offset - amp} ${offset + amp} 0 ${edge} ${edge} ${width} ${period})`;
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
    out[def.key] = String(value);
  }
  return out;
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
      union.join(id, `pt:${key(at)}`);
      if (pin.net) union.join(id, `net:${pin.net}`);
    }
  }

  // Index wire segments by coarse cell so large imported sheets stay near linear.
  const CELL = 200;
  const cells = new Map<string, { a: Point; b: Point; id: string }[]>();
  doc.wires.forEach((wire) => {
    for (let i = 0; i < wire.points.length; i++) {
      union.join(`wire:${wire.id}`, `pt:${key(wire.points[i])}`);
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
    union.join(`net:${label.net}`, `pt:${key(at)}`);
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
  const pinNets = new Map<string, Map<string, string>>();
  for (const pin of pins) {
    const root = union.find(pin.id);
    let net = names.get(root);
    if (!net && (population.get(root) ?? 0) > 1) {
      while (taken.has(`n${auto}`)) auto++;
      net = `n${auto++}`;
      taken.add(net);
      names.set(root, net);
    }
    if (!net) continue;
    let map = pinNets.get(pin.comp.id);
    if (!map) pinNets.set(pin.comp.id, (map = new Map()));
    map.set(pin.name, net);
  }

  const refs = spiceRefs(doc, warnings);
  const lines = [`* ${unsafe(doc.name)}`];
  const definitions = new Set<string>();
  if (doc.definitions.trim()) definitions.add(doc.definitions.trim());
  let hasGround = false;
  for (const comp of doc.components) {
    const part = PART_BY_KIND.get(comp.kind);
    const dynamic = comp.instrument || comp.kind === "switch" || comp.kind === "potentiometer";
    const params = checkedParams(comp, errors);
    const template = dynamic ? instrumentSpice({ ...comp, params }) : comp.spice;
    const nets = pinNets.get(comp.id) ?? new Map<string, string>();
    for (const net of nets.values()) if (net === "0") hasGround = true;
    if (!template.trim()) continue;
    for (const pin of comp.pins) {
      if (!nets.has(pin.name)) warnings.push(`${comp.refDes || part?.name}: pin ${pin.name} is not connected.`);
    }
    lines.push(expand(template, comp, refs.get(comp.id)!, nets, params));
    if (part?.definitions) definitions.add(part.definitions);
  }
  if (!hasGround && doc.components.length) warnings.push("The circuit has no ground connection.");
  for (const def of definitions) lines.push(def);
  lines.push(".end");
  return { text: lines.join("\n"), pinNets, refs, warnings, errors };
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

/** Which pins are joined together, independent of net names. Equal means same connections. */
export function connectivitySignature(doc: Schematic): string {
  const groups = new Map<string, string[]>();
  for (const [id, nets] of buildNetlist(doc).pinNets) {
    for (const [pin, net] of nets) {
      const list = groups.get(net);
      if (list) list.push(`${id}/${pin}`);
      else groups.set(net, [`${id}/${pin}`]);
    }
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort().join("|"))
    .sort()
    .join("\n");
}
