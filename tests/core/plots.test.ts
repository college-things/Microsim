// Windows opened together keep out of each other's way, and plots draw what the samples did.
import { describe, expect, it } from "vitest";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { buildNetlist, pinWorld } from "../../src/core/netlist";
import { simulate } from "../../src/engine/index";
import { freeSpot, tileLayout, type Box } from "../../src/ui/instruments";
import { formatSI, isFlatRange, logTicks, niceTicks, seriesStyle, traceColumns } from "../../src/ui/plot";

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const SCOPE = { width: 520, height: 340 };
const BODE = { width: 540, height: 420 };
const METER = { width: 300, height: 180 };

describe("windows that open together", () => {
  for (const [sheetWidth, sheetHeight] of [[952, 618], [792, 518]]) {
    it(`puts a scope and a Bode plotter apart on a ${sheetWidth} wide sheet, clear of the circuit`, () => {
      const [scope, bode] = tileLayout([SCOPE, BODE], [], sheetWidth, sheetHeight) as Box[];
      expect(overlaps(scope, bode)).toBe(false);
      for (const box of [scope, bode]) {
        expect(box.left).toBeGreaterThanOrEqual(sheetWidth * 0.3);
        expect(box.left + box.width).toBeLessThanOrEqual(sheetWidth);
        expect(box.top + box.height).toBeLessThanOrEqual(sheetHeight);
        expect(box.height).toBeGreaterThanOrEqual(180);
      }
    });
  }

  it("shows every meter on a large sheet", () => {
    const boxes = tileLayout([METER, METER, METER, METER], [], 952, 618);
    expect(boxes.every(Boolean)).toBe(true);
    const placed = boxes as Box[];
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i], placed[j])).toBe(false);
  });

  it("leaves closed what would bury the circuit", () => {
    const boxes = tileLayout(Array.from({ length: 8 }, () => METER), [], 792, 518);
    expect(boxes.filter(Boolean).length).toBeGreaterThan(0);
    expect(boxes.filter(Boolean).length).toBeLessThan(8);
    for (const box of boxes) if (box) expect(box.left).toBeGreaterThanOrEqual(792 * 0.3);
  });

  it("keeps off a window that is already open", () => {
    const open = { left: 500, top: 8, width: 444, height: 200 };
    const [scope] = tileLayout([METER], [open], 952, 618);
    expect(scope && overlaps(scope, open)).toBe(false);
  });

  it("still opens one on a sheet too small to share", () => {
    const boxes = tileLayout([SCOPE, BODE], [], 390, 400);
    expect(boxes[0]).toBeDefined();
    expect(boxes[1]).toBeUndefined();
    expect(boxes[0]!.left).toBeGreaterThanOrEqual(0);
    expect(boxes[0]!.left + boxes[0]!.width).toBeLessThanOrEqual(390);
    // The circuit gets what's above it.
    expect(boxes[0]!.top).toBeGreaterThan(100);
    expect(boxes[0]!.top + boxes[0]!.height).toBeLessThanOrEqual(400);
  });

  it("gives up rather than looping on a sheet with no height", () => {
    expect(tileLayout([SCOPE], [], 390, 40)).toEqual([undefined]);
    expect(tileLayout([SCOPE], [], 0, 0)).toEqual([undefined]);
  });
});

describe("a window opened on its own", () => {
  it("starts at the top right, and goes beside the last one when there's room", () => {
    const first = { ...freeSpot(400, 300, [], 1000, 700), width: 400, height: 300 };
    expect(first).toMatchObject({ left: 592, top: 8 });
    const second = { ...freeSpot(400, 300, [first], 1000, 700), width: 400, height: 300 };
    expect(overlaps(first, second)).toBe(false);
  });

  it("never lands on another window's title when the sheet is full", () => {
    const taken: Box[] = [];
    for (let i = 0; i < 8; i++) {
      const box = { ...freeSpot(540, 420, taken, 952, 618), width: 540, height: 420 };
      for (const other of taken) expect(Math.abs(other.left - box.left) >= 20 || Math.abs(other.top - box.top) >= 20).toBe(true);
      taken.push(box);
    }
  });
});

/** Runs the column reduction with one x pixel per unit, and returns the points it draws. */
const traced = (samples: [number, number][]) => {
  const points: [number, number][] = [];
  traceColumns(samples.map((s) => s[0]), samples.map((s) => s[1]), (v) => v, (v) => v, (x, y) => points.push([x, y]), (x, y) => points.push([x, y]));
  return points;
};

describe("drawing a trace", () => {
  it("draws a rising edge as sharply as a falling one", () => {
    const rising = traced([[0, 5], [1, 5], [2, 5], [2.2, 0], [3, 0]]);
    const falling = traced([[0, 0], [1, 0], [2, 0], [2.2, 5], [3, 5]]);
    // Every point of the edge is in its own column, in the order it happened.
    expect(rising.filter(([x]) => x === 2).map(([, y]) => y)).toEqual([5, 0]);
    expect(falling.filter(([x]) => x === 2).map(([, y]) => y)).toEqual([0, 5]);
  });

  it("doesn't go back on itself within a column", () => {
    const up = traced([[0, 10], [1, 10], [1.1, 8], [1.2, 6], [1.3, 4], [2, 2]]);
    const column = up.filter(([x]) => x === 1).map(([, y]) => y);
    expect(column).toEqual([...column].sort((a, b) => b - a));
  });

  it("keeps a spike narrower than a pixel", () => {
    const spike = traced([[0, 5], [1, 5], [1.1, 0], [1.2, 5], [2, 5]]);
    expect(spike.filter(([x]) => x === 1).map(([, y]) => y)).toEqual([5, 0, 5]);
  });

  it("skips samples that aren't numbers", () => {
    expect(traced([[0, NaN], [1, 3], [2, Infinity], [3, 4]])).toEqual([[1, 3], [1, 3], [3, 4]]);
  });
});

describe("plot axes", () => {
  it("keeps the last decade of a sweep that ends just short of it", () => {
    expect(logTicks(0, Math.log10(9999999.99))).toEqual([1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7]);
  });

  it("doesn't add a decade the sweep never reaches", () => {
    expect(logTicks(1, Math.log10(5e3))).toEqual([10, 100, 1000]);
    expect(logTicks(1.2, 1.8)).toEqual([]);
  });

  it("reads decibels and degrees without a prefix", () => {
    expect(formatSI(-0.5, "dB")).toBe("-0.5 dB");
    expect(formatSI(-45.04, "deg")).toBe("-45.04 deg");
    expect(formatSI(0.5, "V")).toBe("500 mV");
  });

  it("gives more curves than colours a line style of their own", () => {
    const looks = Array.from({ length: 10 }, (_, i) => seriesStyle(i));
    expect(new Set(looks.map((look) => `${look.color} ${look.line}`)).size).toBe(10);
    expect(looks[0].line).toBe("solid");
    expect(looks[8].line).toBe("dashed");
  });

  it("finishes on a range only a few rounding steps wide", () => {
    for (const value of [3.3, 1.5, 12, 1e6, 1e-9]) {
      const ulp = value * Number.EPSILON;
      expect(niceTicks(value, value + 3 * ulp, 5).length).toBeLessThanOrEqual(15);
      expect(niceTicks(value - 0.06 * ulp, value + ulp, 5).length).toBeLessThanOrEqual(15);
    }
    expect(niceTicks(0, 5e-324, 5).length).toBeLessThanOrEqual(15);
  });

  it("gives ordinary ranges the same ticks as before", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(-1, 1, 5)).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(niceTicks(0.5, 3.2, 6).length).toBeGreaterThan(3);
  });

  it("treats a level with rounding noise on it as flat", () => {
    expect(isFlatRange(3.3, 3.3)).toBe(true);
    expect(isFlatRange(3.3, 3.3 + 3 * 3.3 * Number.EPSILON)).toBe(true);
    expect(isFlatRange(0, 0)).toBe(true);
    expect(isFlatRange(3.3, 3.31)).toBe(false);
    expect(isFlatRange(-1e-9, 1e-9)).toBe(false);
  });
});

describe("the full-wave rectifier's drawing", () => {
  const schematic = buildExample(EXAMPLES.find((e) => e.name.startsWith("Full-wave"))!);

  it("runs no wire through a part", () => {
    for (const comp of schematic.components) {
      const pins = comp.pins.map((pin) => pinWorld(comp, pin));
      const xs = pins.map((p) => p.x);
      const ys = pins.map((p) => p.y);
      const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      for (const wire of schematic.wires) {
        for (let i = 1; i < wire.points.length; i++) {
          const [a, b] = [wire.points[i - 1], wire.points[i]];
          // Only the two-pin parts have a straight line between their pins to run along.
          if (comp.pins.length !== 2) continue;
          const alongUpright = left === right && a.x === left && b.x === left && Math.min(a.y, b.y) < bottom && Math.max(a.y, b.y) > top;
          const alongFlat = top === bottom && a.y === top && b.y === top && Math.min(a.x, b.x) < right && Math.max(a.x, b.x) > left;
          expect(alongUpright || alongFlat, `${comp.refDes} has a wire through it`).toBe(false);
        }
      }
    }
  });

  it("is still a bridge", () => {
    const netlist = buildNetlist(schematic);
    const nets = (kind: string) => schematic.components.filter((c) => c.kind === kind).map((c) => netlist.pinNets.get(c.id)!);
    const [d1, d2, d3, d4] = nets("diode");
    expect(d1.get("K")).toBe(d2.get("K"));
    expect(d3.get("A")).toBe("0");
    expect(d4.get("A")).toBe("0");
    expect(d1.get("A")).toBe(d3.get("K"));
    expect(d2.get("A")).toBe(d4.get("K"));
    expect(d1.get("A")).not.toBe(d2.get("A"));
    const [gen] = nets("vsin");
    expect(new Set([gen.get("p"), gen.get("n")])).toEqual(new Set([d1.get("A"), d2.get("A")]));
    const [load] = nets("resistor");
    expect(load.get("1")).toBe(d1.get("K"));
    const result = simulate(netlist.text, { type: "tran", tstop: 0.1, tstep: 1e-4, tmax: 1e-4 });
    const out = result.vectors.find((v) => v.name === `v(${load.get("1")})`)!.re;
    expect(Math.min(...out.slice(out.length >> 1))).toBeGreaterThan(9);
  });
});
