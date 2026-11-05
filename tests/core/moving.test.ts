// Moving parts: wires follow their pins, and connections and net names never change.
import { describe, expect, it } from "vitest";
import { Doc, PartMove, simplify } from "../../src/core/doc";
import { buildNetlist, connectivitySignature, pinWorld } from "../../src/core/netlist";
import type { Point, SchComponent } from "../../src/core/schematic";

const pin = (c: SchComponent, i: number) => pinWorld(c, c.pins[i]);

/** V1, R1, R2 and ground in a loop, with C1 teed into the wire between R1 and R2. */
function teed() {
  const doc = new Doc();
  const v1 = doc.addPart("vdc", -200, 0);
  const r1 = doc.addPart("resistor", -120, -100);
  const r2 = doc.addPart("resistor", 120, -100);
  const c1 = doc.addPart("capacitor", 0, 0);
  c1.rotation = 90;
  const gnd = doc.addPart("ground", 0, 200);
  const top = pin(r1, 1);
  const trunk = doc.addWire([top, pin(r2, 0)]);
  const tee = pin(c1, 0);
  doc.addWire([tee, { x: tee.x, y: top.y }]);
  const rail = 120;
  doc.addWire([pin(v1, 0), { x: pin(v1, 0).x, y: top.y }, pin(r1, 0)]);
  doc.addWire([pin(v1, 1), { x: pin(v1, 1).x, y: rail }, { x: pin(r2, 1).x, y: rail }, pin(r2, 1)]);
  doc.addWire([pin(c1, 1), { x: pin(c1, 1).x, y: rail }]);
  doc.addWire([pin(gnd, 0), { x: pin(gnd, 0).x, y: rail }]);
  return { doc, v1, r1, r2, c1, gnd, trunk };
}

/** Drags as a pointer does, a step at a time, then lets go. */
function drag(doc: Doc, comps: SchComponent[], dx: number, dy: number, selected: string[] = []): boolean {
  const move = new PartMove(doc, comps, new Set([...comps.map((c) => c.id), ...selected]));
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    move.shift(Math.round((dx * i) / steps / 10) * 10, Math.round((dy * i) / steps / 10) * 10);
  }
  return move.settle();
}

const square = (points: Point[]) => points.every((p, i) => !i || p.x === points[i - 1].x || p.y === points[i - 1].y);

describe("moving a part whose wire has a junction", () => {
  const names = ["v1", "r1", "r2", "c1", "gnd"] as const;
  for (const name of names) {
    for (const [dx, dy] of [[0, 40], [0, -40], [40, 0], [-40, 0], [30, 50]]) {
      it(`keeps connections moving ${name} by ${dx},${dy}`, () => {
        const circuit = teed();
        const before = buildNetlist(circuit.doc.schematic).text;
        expect(drag(circuit.doc, [circuit[name]], dx, dy)).toBe(true);
        expect(buildNetlist(circuit.doc.schematic).text).toBe(before);
        for (const wire of circuit.doc.schematic.wires) expect(square(wire.points)).toBe(true);
      });
    }
  }

  it("keeps the wire's run where the tee lands, with a jog at the pin", () => {
    const { doc, r1, trunk } = teed();
    const start = trunk.points[0];
    const end = trunk.points[trunk.points.length - 1];
    expect(drag(doc, [r1], 0, 40)).toBe(true);
    expect(trunk.points).toEqual([{ x: start.x, y: start.y + 40 }, start, end]);
  });

  it("keeps connections when the pin moves past the tee along the wire", () => {
    const { doc, r1 } = teed();
    const signature = connectivitySignature(doc.schematic);
    expect(drag(doc, [r1], 100, 0)).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(signature);
  });

  it("rotates and mirrors with a tee on the wire", () => {
    const { doc, r1, r2, c1 } = teed();
    const signature = connectivitySignature(doc.schematic);
    expect(doc.transformParts([r1], (c) => { c.rotation = 90; })).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(signature);
    expect(doc.transformParts([r2], (c) => { c.mirrored = true; })).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(signature);
    expect(doc.transformParts([c1], (c) => { c.rotation = 0; })).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(signature);
  });

  it("holds a tee when both ends of the wire move", () => {
    const { doc, r1, r2, c1 } = teed();
    const signature = connectivitySignature(doc.schematic);
    expect(c1.rotation).toBe(90);
    expect(drag(doc, [r1, r2], 0, 60)).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(signature);
  });

  it("moves a wire with nothing else on it whole when both its parts move", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 200, 0);
    const wire = doc.addWire([pin(a, 1), pin(b, 0)]);
    const was = wire.points.map((p) => ({ x: p.x, y: p.y + 30 }));
    expect(drag(doc, [a, b], 0, 30)).toBe(true);
    expect(wire.points).toEqual(was);
  });

  it("refuses to land on another net, and restores nothing itself", () => {
    const { doc, r1, gnd } = teed();
    const signature = connectivitySignature(doc.schematic);
    const target = pin(gnd, 0);
    const at = pin(r1, 0);
    expect(drag(doc, [r1], target.x - at.x, target.y - at.y)).toBe(false);
    expect(connectivitySignature(doc.schematic)).not.toBe(signature);
  });

  it("gives a pin resting on a run a new wire back to it", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", -300, 0);
    const b = doc.addPart("resistor", 300, 0);
    const wire = doc.addWire([pin(a, 1), pin(b, 0)]);
    const c = doc.addPart("resistor", 0, 0);
    c.rotation = 90;
    const on = pin(c, 0);
    c.y += wire.points[0].y - on.y;
    c.x += 40 - on.x;
    const signature = connectivitySignature(doc.schematic);
    expect(signature).toContain(c.id);
    expect(drag(doc, [c], 20, 30)).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(signature);
    expect(doc.schematic.wires).toHaveLength(2);
  });

  it("gives pins touching with no wire a new wire between them", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 0, 0);
    b.x = pin(a, 1).x - (pin(b, 0).x - b.x);
    const signature = connectivitySignature(doc.schematic);
    expect(signature).toContain(b.id);
    expect(drag(doc, [b], 40, 30)).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(signature);
    expect(doc.schematic.wires).toHaveLength(1);
  });

  it("leaves no wire behind when a drag comes back to where it began", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 0, 0);
    b.x = pin(a, 1).x - (pin(b, 0).x - b.x);
    const move = new PartMove(doc, [b]);
    move.shift(40, 30);
    move.shift(0, 0);
    expect(move.settle()).toBe(true);
    expect(doc.schematic.wires).toHaveLength(0);
  });

  it("reroutes clear of a wire that a bend would land on", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    doc.addWire([pin(a, 1), pin(b, 0)]);
    const c = doc.addPart("resistor", 150, 60);
    const d = doc.addPart("resistor", 450, 60);
    doc.addWire([pin(c, 1), pin(d, 0)]);
    const signature = connectivitySignature(doc.schematic);
    expect(drag(doc, [a], 0, 60)).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(signature);
  });
});

describe("dragging past a bend", () => {
  it("stays right-angled through every step", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", -120, -100);
    const b = doc.addPart("resistor", 120, -100);
    const wire = doc.addWire([pin(a, 1), pin(b, 0)]);
    expect(drag(doc, [a], 0, 40)).toBe(true);
    const move = new PartMove(doc, [b]);
    for (let d = 10; d <= 60; d += 10) {
      move.shift(0, d);
      expect(square(wire.points), `at ${d}`).toBe(true);
    }
    expect(move.settle()).toBe(true);
    expect(square(wire.points)).toBe(true);
    expect(wire.points[wire.points.length - 1]).toEqual(pin(b, 0));
  });
});

describe("named nets", () => {
  function named() {
    const circuit = teed();
    const [from, to] = [circuit.trunk.points[0], circuit.trunk.points[circuit.trunk.points.length - 1]];
    const label = { id: "OUT", x: from.x + 40, y: from.y, net: "OUT" };
    circuit.doc.schematic.labels.push(label);
    expect(from.y).toBe(to.y);
    return { ...circuit, label };
  }

  it("keeps a name on its wire when a part moves", () => {
    const { doc, r1 } = named();
    const before = buildNetlist(doc.schematic).text;
    expect(before).toContain("OUT");
    expect(drag(doc, [r1], 0, 40)).toBe(true);
    expect(buildNetlist(doc.schematic).text).toBe(before);
  });

  it("keeps a name on a wire with nothing else on it", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 200, 0);
    const wire = doc.addWire([pin(a, 1), pin(b, 0)]);
    doc.schematic.labels.push({ id: "A", x: wire.points[0].x + 20, y: wire.points[0].y, net: "A" });
    const before = buildNetlist(doc.schematic).text;
    expect(drag(doc, [a], 0, 40)).toBe(true);
    expect(buildNetlist(doc.schematic).text).toBe(before);
  });

  it("moves names and notes with everything selected", () => {
    const { doc, label } = named();
    doc.schematic.texts.push({ id: "n", x: 500, y: 500, text: "hello" });
    const s = doc.schematic;
    const before = buildNetlist(s).text;
    const x = label.x;
    const move = new PartMove(doc, s.components, new Set([...s.components, ...s.wires, ...s.labels, ...s.texts].map((i) => i.id)));
    move.shift(10, 20);
    expect(move.settle()).toBe(true);
    expect(buildNetlist(s).text).toBe(before);
    expect(label.x).toBe(x + 10);
    expect(s.texts[0]).toMatchObject({ x: 510, y: 520 });
  });

  it("a name goes with a selected wire even if it isn't selected itself", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 200, 0);
    const wire = doc.addWire([pin(a, 1), pin(b, 0)]);
    const label = { id: "A", x: wire.points[0].x + 20, y: wire.points[0].y, net: "A" };
    doc.schematic.labels.push(label);
    const y = label.y;
    expect(drag(doc, [a, b], 0, 30, [wire.id])).toBe(true);
    expect(label.y).toBe(y + 30);
  });

  it("slides along its net, but can't leave it", () => {
    const { doc, label } = named();
    const selection = new Set([label.id]);
    const along = new PartMove(doc, [], selection);
    along.shift(30, 0);
    expect(along.settle()).toBe(true);
    const off = new PartMove(doc, [], selection);
    off.shift(0, 30);
    expect(off.settle()).toBe(false);
  });

  it("notices a name being lost", () => {
    const { doc, label } = named();
    const before = connectivitySignature(doc.schematic, true);
    label.y -= 30;
    expect(connectivitySignature(doc.schematic, true)).not.toBe(before);
  });
});

describe("notes", () => {
  it("move by themselves", () => {
    const doc = new Doc();
    doc.schematic.texts.push({ id: "n", x: 0, y: 0, text: "hello" });
    const move = new PartMove(doc, [], new Set(["n"]));
    move.shift(20, 30);
    expect(move.settle()).toBe(true);
    expect(doc.schematic.texts[0]).toMatchObject({ x: 20, y: 30 });
  });

  it("paste as copies", () => {
    const doc = new Doc();
    const note = { id: "n", x: 0, y: 0, text: "hello" };
    doc.schematic.texts.push(note);
    const ids = doc.pasteClear({ components: [], wires: [], texts: [note] }, 40)!;
    expect(ids).toHaveLength(1);
    expect(doc.schematic.texts[1]).toMatchObject({ id: ids[0], x: 40, y: 40, text: "hello" });
  });
});

describe("pasting", () => {
  function nearWire() {
    const doc = new Doc();
    const v = doc.addPart("vdc", 0, 0);
    const r = doc.addPart("resistor", 100, 0);
    const source = doc.addPart("resistor", 0, 300);
    // The usual offset would land the copy's pin right on this wire.
    const landing = pin(source, 1);
    const wire = doc.addWire([{ x: landing.x + 40, y: landing.y }, { x: landing.x + 40, y: landing.y + 80 }]);
    doc.connectPins(v, "p", r, "1");
    const gnd = doc.addPart("ground", 0, 0);
    gnd.x += wire.points[0].x - pin(gnd, 0).x;
    gnd.y += wire.points[0].y - pin(gnd, 0).y;
    return { doc, source };
  }

  it("never joins the copy to the circuit", () => {
    const { doc, source } = nearWire();
    const ids = doc.pasteClear({ components: [structuredClone(source)], wires: [] }, 40)!;
    const copy = doc.schematic.components.find((c) => c.id === ids[0])!;
    expect(copy.x).toBeGreaterThan(source.x + 40);
    expect(buildNetlist(doc.schematic).pinNets.get(copy.id)?.size ?? 0).toBe(0);
  });

  it("uses the usual offset when that spot is clear", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    const ids = doc.pasteClear({ components: [structuredClone(r)], wires: [] }, 40)!;
    expect(doc.schematic.components.find((c) => c.id === ids[0])).toMatchObject({ x: 40, y: 40 });
  });

  it("keeps a copied circuit joined to itself only", () => {
    const { doc, v1, r1, r2, c1, gnd } = teed();
    const s = doc.schematic;
    const clip = structuredClone({ components: [v1, r1, r2, c1, gnd], wires: s.wires });
    const nets = connectivitySignature(s).split("\n").length;
    expect(doc.pasteClear(clip, 40)).toBeTruthy();
    // Ground is the one net they share.
    expect(connectivitySignature(s).split("\n").length).toBe(nets * 2 - 1);
  });

  it("adds nothing when there is no clear spot", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    // A comb of grounded wires under every spot the copy's pins could land on.
    const at = pin(r, 1);
    const gnd = doc.addPart("ground", 0, 0);
    gnd.x += at.x - pin(gnd, 0).x;
    gnd.y += at.y - 600 - pin(gnd, 0).y;
    doc.addWire([{ x: at.x, y: at.y - 600 }, { x: at.x + 1600, y: at.y - 600 }]);
    for (let i = 1; i < 40; i++) doc.addWire([{ x: at.x + 40 * i, y: at.y - 600 }, { x: at.x + 40 * i, y: at.y + 2000 }]);
    const parts = doc.schematic.components.length;
    const wires = doc.schematic.wires.length;
    expect(doc.pasteClear({ components: [structuredClone(r)], wires: [] }, 40)).toBeUndefined();
    expect(doc.schematic.components).toHaveLength(parts);
    expect(doc.schematic.wires).toHaveLength(wires);
  });
});

describe("simplify", () => {
  it("keeps a wire doubling back, as something may be joined at the far spot", () => {
    const points = [{ x: 10, y: 0 }, { x: -20, y: 0 }, { x: 30, y: 0 }];
    expect(simplify(points)).toEqual(points);
  });

  it("still merges a straight run", () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 0 }])).toEqual([{ x: 0, y: 0 }, { x: 30, y: 0 }]);
  });
});
