// Moving and turning parts on every sample: a move either keeps the netlist exactly or is refused.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Doc, PartMove } from "../../src/core/doc";
import { buildNetlist, connectivitySignature } from "../../src/core/netlist";
import type { SchComponent } from "../../src/core/schematic";
import { importMs14 } from "../../src/importer/index";

const ROOT = "C:/Users/Public/Documents/National Instruments/Circuit Design Suite 14.2/samples";

function samples(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return samples(full);
    return name.toLowerCase().endsWith(".ms14") ? [full] : [];
  });
}

function step(doc: Doc, comp: SchComponent, dx: number, dy: number): boolean {
  const move = new PartMove(doc, [comp], new Set([comp.id]));
  for (let i = 1; i <= 4; i++) move.shift((dx * i) / 4, (dy * i) / 4);
  return move.settle();
}

describe.skipIf(!existsSync(ROOT))("moving parts on the samples", () => {
  it("never changes a connection, and rarely has to refuse", () => {
    let tried = 0;
    const changed: string[] = [];
    const refused: string[] = [];
    const attempts: [string, (doc: Doc, comp: SchComponent) => boolean][] = [
      ["down", (doc, comp) => step(doc, comp, 0, 40)],
      ["up", (doc, comp) => step(doc, comp, 0, -40)],
      ["left", (doc, comp) => step(doc, comp, -40, 0)],
      ["right", (doc, comp) => step(doc, comp, 40, 0)],
      ["turn", (doc, comp) => doc.transformParts([comp], (c) => { c.rotation = ((c.rotation + 90) % 360) as SchComponent["rotation"]; })],
    ];
    for (const file of samples(ROOT)) {
      const doc = new Doc();
      doc.replace(importMs14(new Uint8Array(readFileSync(file))).schematic);
      // Parts spread over the sheet, as trying every part on the big sheets takes minutes.
      const parts = doc.schematic.components.filter((c) => c.pins.length);
      const every = Math.max(1, Math.floor(parts.length / 12));
      const ids = parts.filter((_, i) => i % every === 0).map((c) => c.id);
      const original = JSON.stringify(doc.schematic);
      const text = buildNetlist(doc.schematic).text;
      const signature = connectivitySignature(doc.schematic, true);
      for (const id of ids) {
        for (const [name, attempt] of attempts) {
          doc.schematic = JSON.parse(original);
          const comp = doc.schematic.components.find((c) => c.id === id)!;
          const where = `${basename(file)}: ${comp.refDes} ${name}`;
          tried++;
          if (!attempt(doc, comp)) refused.push(where);
          else if (connectivitySignature(doc.schematic, true) !== signature || buildNetlist(doc.schematic).text !== text) changed.push(where);
        }
      }
    }
    if (process.env.MOVE_REPORT) writeFileSync(process.env.MOVE_REPORT, JSON.stringify({ tried, refused }, null, 1));
    expect(changed).toEqual([]);
    expect(tried).toBeGreaterThan(1000);
    expect(refused.length / tried).toBeLessThan(0.05);
  }, 300_000);
});
