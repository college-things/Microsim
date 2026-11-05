// A user-owned catalogue populated by exported circuits/models, including NI files.
import { parseCircuit } from "./file";
import { PART_BY_KIND, PARTS, type PartDef } from "./library";
import type { SchComponent } from "./schematic";
export interface DatabasePart { name: string; component: SchComponent; definitions: string }
export function databaseKind(part: DatabasePart): string {
  let hash = 14695981039346656037n;
  for (const char of JSON.stringify(part)) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 1099511628211n);
  return `user:${hash.toString(16)}`;
}
export function readComponentDatabase(text: string): DatabasePart[] {
  const data = JSON.parse(text);
  if (data?.format !== "microsim-components" || data.version !== 1 || !Array.isArray(data.parts) || data.parts.length > 10000) throw new Error("Expected a Microsim component catalogue, version 1.");
  for (const p of data.parts) {
    if (typeof p.name !== "string" || !p.name.trim() || typeof p.definitions !== "string") throw new Error("Invalid component entry.");
    parseCircuit(JSON.stringify({ name: p.name, components: [p.component], wires: [], labels: [], texts: [], definitions: p.definitions }));
  }
  return data.parts;
}
export function registerDatabase(parts: DatabasePart[]): void {
  for (let i = PARTS.length - 1; i >= 0; i--) if (PARTS[i].kind.startsWith("user:")) { PART_BY_KIND.delete(PARTS[i].kind); PARTS.splice(i, 1); }
  parts.forEach((p) => {
    const c = p.component;
    const def: PartDef = {
      kind: databaseKind(p), name: p.name, category: "Analog", prefix: c.refDes.replace(/[\d\W]+/g, "") || "XU",
      pins: c.pins.map(({ net: _, ...pin }) => pin),
      params: Object.entries(c.params).map(([key, value]) => ({ key, default: value, label: c.paramLabels?.[key] ?? key, text: true })),
      spice: c.spice, definitions: p.definitions, graphics: c.graphics ?? [{ kind: "rect", x: -30, y: -20, w: 60, h: 40, filled: false }], instrument: c.instrument, indicator: c.indicator,
    };
    PARTS.push(def); PART_BY_KIND.set(def.kind, def);
  });
}
export function writeComponentDatabase(parts: DatabasePart[]): string { return JSON.stringify({ format: "microsim-components", version: 1, parts }, null, 2); }
