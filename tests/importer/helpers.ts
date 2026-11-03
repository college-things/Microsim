// Test-only helpers. The real netlister lives in src/core/netlist.ts and resolves wire geometry;
// this one trusts Pin.net, which is what the file says, so it can check the importer on its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImportResult, SchComponent, Schematic } from "../../src/core/schematic";
import { importDetailed } from "../../src/importer";
import { IMPLODE_TABLES } from "../../src/importer/implode";

export const SAMPLE_ROOT = "C:\\Users\\Public\\Documents\\National Instruments\\Circuit Design Suite 14.2\\samples";

export function listSamples(root = SAMPLE_ROOT): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry.toLowerCase().endsWith(".ms14")) found.push(full);
    }
  };
  visit(root);
  return found.sort();
}

export function readSample(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file));
}

/**
 * Imports a file both ways. bound is what the app receives, with connectivity in the drawing.
 * view is the same with each pin's file net written back, for checking what the file states.
 */
export function importBoth(bytes: Uint8Array): { bound: ImportResult; view: ImportResult } {
  const { result, fileNets } = importDetailed(bytes);
  const components = result.schematic.components.map((c) => ({
    ...c,
    pins: c.pins.map((p) => {
      const net = fileNets.get(c.id)?.get(p.name);
      const { net: _, ...rest } = p;
      return net === undefined ? rest : { ...rest, net };
    }),
  }));
  return { bound: result, view: { ...result, schematic: { ...result.schematic, components } } };
}

export function expandComponent(comp: SchComponent): string {
  const nets = new Map(comp.pins.map((p) => [p.name, p.net]));
  // The netlister's name for a part whose name the file hides.
  const ref = comp.refDes || `P_${comp.id}`;
  return comp.spice
    .replace(/\{ref\}/g, ref)
    .replace(/\{pin:([^}]+)\}/g, (_, pin: string) => nets.get(pin) ?? `nc_${ref}_${pin}`.replace(/\W/g, "_"))
    .replace(/\{param:([^}]+)\}/g, (_, name: string) => comp.params[name] ?? "0");
}

export function netlistOf(schematic: Schematic): string {
  const lines = [`* ${schematic.name}`];
  for (const comp of schematic.components) {
    const line = expandComponent(comp);
    if (line) lines.push(line);
  }
  if (schematic.definitions) lines.push(schematic.definitions);
  lines.push(".end");
  return lines.join("\n");
}

const LEAK = /%t|%m(?!\w)|%p(?!\w)|%S\d|%f\d|%v\d|#\d/;

/** Lines holding an unexpanded template token. XSPICE port types such as %vd( are legal output. */
export function findLeaks(text: string): string[] {
  return text.split("\n").filter((line) => !line.startsWith("*") && LEAK.test(line));
}

export function issueType(message: string): string {
  const colon = message.indexOf(":");
  return colon > 0 && colon < 16 ? message.slice(0, colon) : "Other";
}

/** Writes implode bits least significant first. */
export class BitWriter {
  bytes: number[] = [];
  private buf = 0;
  private cnt = 0;

  bits(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
      this.buf |= ((value >> i) & 1) << this.cnt;
      if (++this.cnt === 8) {
        this.bytes.push(this.buf);
        this.buf = 0;
        this.cnt = 0;
      }
    }
  }

  flush(): number[] {
    if (this.cnt) this.bytes.push(this.buf);
    this.buf = 0;
    this.cnt = 0;
    return this.bytes;
  }
}

/** Code words for a table, as stored: read one bit at a time, inverted, most significant first. */
function codesOf(table: { count: Uint16Array; symbol: Uint16Array }): Map<number, { code: number; length: number }> {
  const out = new Map<number, { code: number; length: number }>();
  let first = 0;
  let index = 0;
  for (let length = 1; length < table.count.length; length++) {
    for (let i = 0; i < table.count[length]; i++) out.set(table.symbol[index + i], { code: first + i, length });
    index += table.count[length];
    first = (first + table.count[length]) << 1;
  }
  return out;
}

const CODES = {
  literal: codesOf(IMPLODE_TABLES.literal),
  length: codesOf(IMPLODE_TABLES.length),
  distance: codesOf(IMPLODE_TABLES.distance),
};

function writeCode(w: BitWriter, entry: { code: number; length: number }): void {
  for (let i = entry.length - 1; i >= 0; i--) w.bits(((entry.code >> i) & 1) ^ 1, 1);
}

export type ImplodeToken = number | { length: number; distance: number };

/** Builds a stream from literals and back references. It favours clarity over compression. */
export function buildImplode(tokens: ImplodeToken[], coded: boolean, dictBits = 4, terminate = true): Uint8Array {
  const w = new BitWriter();
  const { BASE, EXTRA } = IMPLODE_TABLES;
  const writeLength = (length: number) => {
    for (let sym = BASE.length - 1; sym >= 0; sym--) {
      if (length >= BASE[sym] && length < BASE[sym] + (1 << EXTRA[sym])) {
        w.bits(1, 1);
        writeCode(w, CODES.length.get(sym)!);
        w.bits(length - BASE[sym], EXTRA[sym]);
        return;
      }
    }
    throw new Error(`bad length ${length}`);
  };
  for (const token of tokens) {
    if (typeof token === "number") {
      w.bits(0, 1);
      if (coded) writeCode(w, CODES.literal.get(token)!);
      else w.bits(token, 8);
    } else {
      writeLength(token.length);
      const shift = token.length === 2 ? 2 : dictBits;
      const d = token.distance - 1;
      writeCode(w, CODES.distance.get(d >> shift)!);
      w.bits(d & ((1 << shift) - 1), shift);
    }
  }
  if (terminate) writeLength(519);
  return new Uint8Array([coded ? 1 : 0, dictBits, ...w.flush()]);
}

const MAGIC = "MSMCompressedElectronicsWorkbenchXML";

export function buildContainer(chunks: { size: number; data: Uint8Array }[], declaredTotal?: number): Uint8Array {
  const total = declaredTotal ?? chunks.reduce((sum, c) => sum + c.size, 0);
  const length = MAGIC.length + 8 + chunks.reduce((sum, c) => sum + 8 + c.data.length, 0);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  view.setUint32(MAGIC.length, total, true);
  let pos = MAGIC.length + 8;
  for (const chunk of chunks) {
    view.setUint32(pos, chunk.size, true);
    view.setUint32(pos + 4, chunk.data.length, true);
    out.set(chunk.data, pos + 8);
    pos += 8 + chunk.data.length;
  }
  return out;
}

export function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

export type { ImportResult };
