// Every imported shape must be drawable, because one bad value used to blank a whole sheet.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importMs14 } from "../../src/importer/index";

const ROOT = "C:/Users/Public/Documents/National Instruments/Circuit Design Suite 14.2/samples";

function samples(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return samples(full);
    return name.toLowerCase().endsWith(".ms14") ? [full] : [];
  });
}

describe.skipIf(!existsSync(ROOT))("imported geometry", () => {
  it("has finite coordinates and non-negative ellipse radii in every sample", () => {
    const bad: string[] = [];
    for (const file of samples(ROOT)) {
      const { schematic } = importMs14(new Uint8Array(readFileSync(file)));
      for (const comp of schematic.components) {
        if (!Number.isFinite(comp.x) || !Number.isFinite(comp.y)) bad.push(`${file}: ${comp.refDes} position`);
        for (const g of comp.graphics ?? []) {
          if (g.kind === "ellipse" && (g.rx < 0 || g.ry < 0 || !Number.isFinite(g.rx) || !Number.isFinite(g.ry))) {
            bad.push(`${file}: ${comp.refDes} ellipse ${g.rx},${g.ry}`);
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
