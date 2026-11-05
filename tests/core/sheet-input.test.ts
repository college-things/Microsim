// How the sheet reads scrolling and clicks, where wires land, and where the drawing shows a join.
import { describe, expect, it } from "vitest";
import { Doc } from "../../src/core/doc";
import { parseCircuit, serializeCircuit } from "../../src/core/file";
import { buildNetlist, junctions, onSegment, pinWorld } from "../../src/core/netlist";
import type { Point, Wire } from "../../src/core/schematic";
import { isSecondaryClick, pointOnWires, wheelAction } from "../../src/ui/canvas";

const wheel = (deltaY: number, more: Partial<WheelEvent> = {}) => ({ deltaMode: 0, deltaX: 0, deltaY, ctrlKey: false, metaKey: false, ...more });
const wire = (...points: [number, number][]): Wire => ({ id: `w${points.join()}`, points: points.map(([x, y]) => ({ x, y })) });
const net = (doc: Doc, comp: { id: string }, pin: string) => buildNetlist(doc.schematic).pinNets.get(comp.id)?.get(pin);
const dots = (doc: Doc) => junctions(doc.schematic).map((p) => `${p.x},${p.y}`).sort();

describe("scrolling on the sheet", () => {
  it("always pans on a Mac, however hard the swipe", () => {
    for (const deltaY of [2, 99, 100, 120, 170, 300, -120]) {
      expect(wheelAction(wheel(deltaY), true)).toEqual({ panX: 0, panY: deltaY });
    }
  });

  it("pans by lines on a Mac too, so a line-based mouse wheel can't zoom", () => {
    expect(wheelAction(wheel(3, { deltaMode: 1 }), true)).toEqual({ panX: 0, panY: 60 });
  });

  it("zooms on a Mac with Ctrl or Cmd held", () => {
    expect(wheelAction(wheel(-20, { metaKey: true }), true)).toEqual({ zoom: Math.exp(0.2) });
    expect(wheelAction(wheel(10, { ctrlKey: true }), true)).toEqual({ zoom: Math.exp(-0.1) });
  });

  it("keeps a hard swipe with Cmd held to one gentle step", () => {
    expect(wheelAction(wheel(170, { metaKey: true }), true)).toEqual({ zoom: Math.exp(-0.2) });
  });

  it("zooms by the notch with a mouse wheel elsewhere, in pixels or lines", () => {
    for (const notch of [wheel(100), wheel(120), wheel(3, { deltaMode: 1 })]) {
      const action = wheelAction(notch, false);
      expect("zoom" in action && action.zoom).toBeCloseTo(0.819, 3);
    }
  });

  it("still pans with a trackpad elsewhere", () => {
    expect(wheelAction(wheel(40), false)).toEqual({ panX: 0, panY: 40 });
    expect(wheelAction(wheel(100.5), false)).toEqual({ panX: 0, panY: 100.5 });
    expect(wheelAction(wheel(100, { deltaX: 1 }), false)).toEqual({ panX: 1, panY: 100 });
  });
});

describe("right-click on a Mac", () => {
  it("includes Ctrl+click, which arrives as the main button", () => {
    expect(isSecondaryClick({ button: 0, ctrlKey: true }, true)).toBe(true);
    expect(isSecondaryClick({ button: 2, ctrlKey: false }, true)).toBe(true);
    expect(isSecondaryClick({ button: 0, ctrlKey: false }, true)).toBe(false);
  });

  it("leaves Ctrl+click alone elsewhere", () => {
    expect(isSecondaryClick({ button: 0, ctrlKey: true }, false)).toBe(false);
    expect(isSecondaryClick({ button: 2, ctrlKey: false }, false)).toBe(true);
  });
});

describe("ending on a wire", () => {
  const onWire = (p: Point | undefined, w: Wire) => p !== undefined && w.points.some((q, i) => i > 0 && onSegment(p, w.points[i - 1], q));

  it("lands exactly on the wire from anywhere in reach, even zoomed far out", () => {
    const run = wire([-100, 60], [100, 60]);
    for (const zoom of [1, 0.8, 0.51, 0.33]) {
      const reach = 5 / zoom;
      for (const off of [-0.99 * reach, -reach / 2, 0, reach / 2, 0.99 * reach]) {
        expect(pointOnWires([run], { x: -31, y: 60 + off }, reach)).toEqual({ x: -30, y: 60 });
      }
    }
  });

  it("works on upright runs, stays on the run past its end, and misses out of reach", () => {
    const run = wire([0, 0], [0, 100]);
    expect(pointOnWires([run], { x: 12, y: 44 }, 15)).toEqual({ x: 0, y: 40 });
    expect(pointOnWires([run], { x: 3, y: 104 }, 15)).toEqual({ x: 0, y: 100 });
    expect(pointOnWires([run], { x: 16, y: 44 }, 15)).toBeUndefined();
    expect(pointOnWires([run], { x: 0, y: 120 }, 15)).toBeUndefined();
  });

  it("picks the closest wire when two are in reach", () => {
    const near = wire([0, 10], [100, 10]);
    const far = wire([0, 0], [100, 0]);
    expect(pointOnWires([far, near], { x: 50, y: 8 }, 15)).toEqual({ x: 50, y: 10 });
    expect(pointOnWires([near, far], { x: 50, y: 2 }, 15)).toEqual({ x: 50, y: 0 });
  });

  it("uses a grid point on a slanted wire when one lies on it", () => {
    expect(pointOnWires([wire([0, 0], [100, 100])], { x: 52, y: 47 }, 15)).toEqual({ x: 50, y: 50 });
  });

  it("joins the net on a slanted wire with no grid point nearby", () => {
    const doc = new Doc();
    const left = doc.addPart("resistor", 0, 0);
    const right = doc.addPart("resistor", 400, 170);
    const other = doc.addPart("resistor", 150, 300);
    const from = pinWorld(left, left.pins[1]);
    const to = pinWorld(right, right.pins[0]);
    const slanted = doc.addWire([from, to]);
    expect(from.x === to.x || from.y === to.y).toBe(false);

    const pin = pinWorld(other, other.pins[0]);
    for (const zoom of [1, 0.51, 0.33]) {
      for (const off of [-4.5 / zoom, 0, 4.5 / zoom]) {
        const middle = { x: (from.x + to.x) / 2 + off * 0.3, y: (from.y + to.y) / 2 + off * 0.7 };
        const end = pointOnWires([slanted], middle, 5 / zoom)!;
        expect(onWire(end, slanted)).toBe(true);
        const before = doc.schematic.wires.length;
        doc.addWire([pin, { x: end.x, y: pin.y }, end]);
        expect(net(doc, other, "1")).toBeTruthy();
        expect(net(doc, other, "1")).toBe(net(doc, left, "2"));
        doc.schematic.wires.length = before;
      }
    }
  });

  it("keeps that connection through a save and load", () => {
    const doc = new Doc();
    const left = doc.addPart("resistor", 0, 0);
    const right = doc.addPart("resistor", 400, 170);
    const other = doc.addPart("resistor", 150, 300);
    const slanted = doc.addWire([pinWorld(left, left.pins[1]), pinWorld(right, right.pins[0])]);
    const pin = pinWorld(other, other.pins[0]);
    const end = pointOnWires([slanted], { x: 213, y: 85 }, 15)!;
    doc.addWire([pin, { x: end.x, y: pin.y }, end]);
    const loaded = parseCircuit(serializeCircuit({ schematic: doc.schematic, analyses: [], issues: [] })).schematic;
    const nets = buildNetlist(loaded).pinNets;
    expect(nets.get(other.id)?.get("1")).toBe(nets.get(left.id)?.get("2"));
  });

  it("doesn't take a wire with no length as a target", () => {
    expect(pointOnWires([wire([0, 0])], { x: 0, y: 0 }, 15)).toBeUndefined();
  });
});

describe("wires with no length", () => {
  it("aren't added", () => {
    const doc = new Doc();
    doc.addWire([{ x: 90, y: -100 }, { x: 90, y: -100 }]);
    expect(doc.schematic.wires).toHaveLength(0);
    doc.addWire([{ x: 90, y: -100 }, { x: 90, y: -50 }]);
    expect(doc.schematic.wires).toHaveLength(1);
  });

  it("are dropped when a file or recovery copy has them", () => {
    const doc = new Doc();
    doc.addWire([{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    doc.schematic.wires.push(wire([90, -100]), wire([10, 10], [10, 10]));
    const loaded = parseCircuit(serializeCircuit({ schematic: doc.schematic, analyses: [], issues: [] })).schematic;
    expect(loaded.wires).toHaveLength(1);
  });

  it("don't count as a join in the drawing", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    const at = pinWorld(r, r.pins[0]);
    doc.addWire([at, { x: at.x - 50, y: at.y }]);
    doc.schematic.wires.push({ id: "dot", points: [at] });
    expect(dots(doc)).toEqual([]);
  });
});

describe("junction dots", () => {
  const horizontal: [number, number][] = [[-100, 0], [100, 0]];

  it("marks a wire ending on another's run", () => {
    const doc = new Doc();
    doc.schematic.wires.push(wire(...horizontal), wire([0, 0], [0, 50]));
    expect(dots(doc)).toEqual(["0,0"]);
  });

  it("marks a wire ending on another's corner", () => {
    const doc = new Doc();
    doc.schematic.wires.push(wire([-100, 0], [0, 0], [0, 100]), wire([0, 0], [50, 0]));
    expect(dots(doc)).toEqual(["0,0"]);
  });

  it("marks four branches meeting at a corner and an end", () => {
    const doc = new Doc();
    doc.schematic.wires.push(wire([-100, 0], [0, 0], [0, 100]), wire([0, 0], [50, 0]), wire([0, 0], [0, -50]));
    expect(dots(doc)).toEqual(["0,0"]);
  });

  it("marks two wires run to one pin", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    const at = pinWorld(r, r.pins[0]);
    doc.addWire([at, { x: at.x - 50, y: at.y }]);
    expect(dots(doc)).toEqual([]);
    doc.addWire([at, { x: at.x, y: at.y + 50 }]);
    expect(dots(doc)).toEqual([`${at.x},${at.y}`]);
  });

  it("marks a wire running through a pin", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    const at = pinWorld(r, r.pins[0]);
    doc.addWire([{ x: at.x, y: at.y - 50 }, { x: at.x, y: at.y + 50 }]);
    expect(dots(doc)).toEqual([`${at.x},${at.y}`]);
  });

  it("marks a wire ending on a slanted one", () => {
    const doc = new Doc();
    const slanted = wire([0, 0], [100, 37]);
    const end = pointOnWires([slanted], { x: 50, y: 19 }, 15)!;
    doc.schematic.wires.push(slanted, { id: "tee", points: [end, { x: end.x, y: 100 }] });
    expect(junctions(doc.schematic)).toEqual([end]);
  });

  it("leaves plain crossings, straight joins and corners without a dot", () => {
    const doc = new Doc();
    doc.schematic.wires.push(wire(...horizontal), wire([0, -50], [0, 50]));
    expect(dots(doc)).toEqual([]);
    doc.schematic.wires = [wire([0, 0], [50, 0]), wire([50, 0], [100, 0]), wire([200, 0], [200, 50], [250, 50])];
    expect(dots(doc)).toEqual([]);
  });

  it("leaves a corner resting on another wire's run without a dot, as it doesn't join", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", -300, 0);
    const b = doc.addPart("resistor", 0, -200);
    const pa = pinWorld(a, a.pins[1]);
    const pb = pinWorld(b, b.pins[1]);
    doc.schematic.wires.push(
      { id: "run", points: [pa, { x: 200, y: pa.y }] },
      { id: "corner", points: [pb, { x: pb.x, y: pa.y }, { x: pb.x + 50, y: -100 }] },
    );
    expect(net(doc, a, "2")).not.toBe(net(doc, b, "2"));
    expect(dots(doc)).toEqual([]);
  });

  it("agrees with the netlist on what a dot joins", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    const c = doc.addPart("resistor", 150, 200);
    const pa = pinWorld(a, a.pins[1]);
    const pb = pinWorld(b, b.pins[0]);
    const pc = pinWorld(c, c.pins[0]);
    doc.addWire([pa, pb]);
    doc.addWire([pc, { x: pc.x, y: pa.y }]);
    expect(dots(doc)).toEqual([`${pc.x},${pa.y}`]);
    expect(net(doc, c, "1")).toBe(net(doc, a, "2"));
    expect(net(doc, c, "1")).toBe(net(doc, b, "1"));
  });
});
