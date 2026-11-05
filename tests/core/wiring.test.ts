// A wire connects what was clicked and nothing else, a drag passes its check before anything else
// acts, and a refused edit changes nothing at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTool } from "../../src/agent/tools";
import { Doc, route } from "../../src/core/doc";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { buildNetlist, connectivitySignature, pinWorld } from "../../src/core/netlist";
import type { Point, SchComponent } from "../../src/core/schematic";
import { pointOnWires, SchematicCanvas } from "../../src/ui/canvas";

const noSimulator = () => Promise.reject(new Error("Nothing here runs a simulation."));
const pin = (c: SchComponent, i: number) => pinWorld(c, c.pins[i]);
const net = (doc: Doc, c: SchComponent, name: string) => buildNetlist(doc.schematic).pinNets.get(c.id)?.get(name);

/** Where a click lands while wiring, the way the sheet works it out. */
function landing(doc: Doc, x: number, y: number): Point | undefined {
  const pins = doc.schematic.components.flatMap((c) => c.pins.map((p) => pinWorld(c, p)));
  const reach = (p: Point) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
  const onPin = pins.filter((p) => reach(p) <= 9).sort((a, b) => reach(a) - reach(b))[0];
  const onWire = pointOnWires(doc.schematic.wires, { x, y }, 5);
  if (!onPin || !onWire) return onPin ?? onWire;
  return Math.hypot(onWire.x - x, onWire.y - y) < Math.hypot(onPin.x - x, onPin.y - y) ? onWire : onPin;
}

/** Clicks a wire into place: a pin, any corners, then a pin or wire. */
function wireByHand(doc: Doc, ...clicks: [number, number][]) {
  let draft = [landing(doc, ...clicks[0])!];
  for (const [x, y] of clicks.slice(1)) {
    const target = landing(doc, x, y);
    if (target) return doc.finishWire(draft, target);
    draft = [...draft.slice(0, -1), ...route(draft[draft.length - 1], { x, y })];
  }
  throw new Error("Those clicks never reach a pin or wire.");
}

/** A common-emitter amplifier built by clicking, as a new user would, with a scope and a meter wired. */
function amplifier(): Doc {
  const doc = new Doc();
  doc.addPart("npn", 100, 0);
  for (const [x, y] of [[120, -90], [120, 90], [40, -70], [40, 70]]) doc.addPart("resistor", x, y).rotation = 90;
  doc.addPart("capacitor", -20, 0);
  doc.addPart("vsin", -100, 50);
  doc.addPart("vcc", 120, -150);
  for (const [x, y] of [[120, 140], [40, 130], [-100, 120]]) doc.addPart("ground", x, y);
  doc.addPart("oscilloscope", 300, -150);
  doc.addPart("multimeter", 300, 50);
  const wires: [number, number][][] = [
    [[120, -140], [120, -120]], [[120, -60], [120, -30]], [[120, 30], [120, 60]], [[120, 120], [120, 130]],
    [[40, -40], [40, 40]], [[10, 0], [40, 0]], [[70, 0], [40, 0]], [[40, 100], [40, 120]], [[-100, 20], [-50, 0]],
    [[-100, 80], [-100, 110]], [[40, -100], [120, -130]], [[285, -120], [120, -45]], [[315, -120], [315, -100], [40, -20]],
    [[335, -150], [370, -150], [370, 170], [120, 135]], [[290, 75], [290, 45], [120, 45]], [[310, 75], [310, 110], [120, 125]],
  ];
  for (const clicks of wires) wireByHand(doc, ...clicks);
  return doc;
}

/** Each circuit with how many ordered pairs of its pins aren't joined yet. */
// The machine examples include the four-channel Tektronix scope, with C/D initially open.
const PAIRS: Record<string, number> = { "RC low-pass filter": 128, "Common-emitter amplifier": 396, "Inverting op-amp": 126, "Full-wave rectifier": 244, "D flip-flop divider": 136, "Holding tank process": 182, "Conveyor process": 182, "8051 serial hello": 1320 };
const circuits: [string, number, () => Doc][] = [
  ["the hand-built amplifier", 456, amplifier],
  ...EXAMPLES.map((example): [string, number, () => Doc] => [example.name, PAIRS[example.name], () => {
    const doc = new Doc();
    doc.schematic = buildExample(example);
    return doc;
  }]),
];

describe("wiring every pair of pins by hand", () => {
  for (const [name, pairs, build] of circuits) {
    it(`joins only the nets at its two ends in ${name}`, () => {
      const doc = build();
      const start = JSON.stringify(doc.schematic);
      const groups = () => {
        const found = new Map<string, Set<string>>();
        for (const [id, nets] of buildNetlist(doc.schematic).pinNets) {
          for (const [pinName, value] of nets) {
            if (!found.has(value)) found.set(value, new Set());
            found.get(value)!.add(`${id}/${pinName}`);
          }
        }
        return found;
      };
      const groupOf = (all: Map<string, Set<string>>, key: string) => [...all.values()].find((g) => g.has(key));
      const pins = doc.schematic.components.flatMap((c) => c.pins.map((p) => ({ key: `${c.id}/${p.name}`, words: `${c.refDes}.${p.name}`, at: pinWorld(c, p) })));
      const before = groups();
      let tried = 0;
      for (const a of pins) {
        for (const b of pins) {
          const fromA = groupOf(before, a.key);
          if (a === b || fromA?.has(b.key)) continue;
          tried++;
          const pair = `${a.words} to ${b.words}`;
          expect(doc.finishWire([a.at], b.at).refused, pair).toBeUndefined();
          const joined = groupOf(groups(), a.key);
          expect(joined?.has(b.key), pair).toBe(true);
          const meant = new Set([...(fromA ?? []), ...(groupOf(before, b.key) ?? []), a.key, b.key]);
          expect([...joined!].filter((key) => !meant.has(key)), pair).toEqual([]);
          doc.undo();
        }
      }
      expect(JSON.stringify(doc.schematic)).toBe(start);
      expect(tried).toBe(pairs);
    });
  }

  for (const [name, , build] of circuits) {
    it(`joins only the wire clicked, wherever a lead ends on one, in ${name}`, () => {
      const doc = build();
      const start = JSON.stringify(doc.schematic);
      // What two labels at its ends would do, which can't reach anything along the way.
      const meant = (a: Point, b: Point) => connectivitySignature({ ...doc.schematic, labels: [...doc.schematic.labels, { id: "a", ...a, net: "both ends" }, { id: "b", ...b, net: "both ends" }] });
      const spots = doc.schematic.wires.flatMap((w) => w.points.slice(1).map((b, i) => ({ x: (w.points[i].x + b.x) / 2, y: (w.points[i].y + b.y) / 2 })));
      const pins = doc.schematic.components.flatMap((c) => c.pins.map((p) => pinWorld(c, p)));
      let wired = 0;
      for (const from of pins) {
        for (const spot of spots) {
          const target = landing(doc, spot.x, spot.y)!;
          const expected = meant(from, target);
          const { refused } = doc.finishWire([from], target);
          if (refused) {
            expect(refused).toMatch(/Two wires cross/);
            continue;
          }
          wired++;
          expect(connectivitySignature(doc.schematic), `${from.x},${from.y} to ${target.x},${target.y}`).toBe(expected);
          if (JSON.stringify(doc.schematic) !== start) doc.undo();
        }
      }
      expect(JSON.stringify(doc.schematic)).toBe(start);
      expect(wired).toBeGreaterThan(50);
    });
  }
});

describe("a wire with no clear path", () => {
  /** R1 to R3 with R2's pin in the way of any plain route, and no router to help. */
  function blocked() {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 100, 0);
    const r3 = doc.addPart("resistor", 200, 0);
    doc.clearRoute = () => undefined;
    return { doc, r1, r2, r3 };
  }

  it("connects through visible labels and says so", () => {
    const { doc, r1, r2, r3 } = blocked();
    const { refused, note } = doc.finishWire([pin(r1, 1)], pin(r3, 0));
    expect(refused).toBeUndefined();
    expect(note).toMatch(/both ends got the net name LINK1/);
    expect(doc.schematic.wires).toEqual([]);
    expect(doc.schematic.labels.every((l) => !l.hidden && l.net === "LINK1")).toBe(true);
    expect(net(doc, r1, "2")).toBe(net(doc, r3, "1"));
    expect(net(doc, r2, "1")).toBeUndefined();
    doc.undo();
    expect(doc.schematic.labels).toEqual([]);
  });

  it("keeps the name a net already has, whichever end it's on", () => {
    for (const named of [0, 1]) {
      const { doc, r1, r3 } = blocked();
      const at = named ? pin(r3, 0) : pin(r1, 1);
      doc.schematic.labels.push({ id: "l", x: at.x, y: at.y, net: "OUT" });
      expect(doc.finishWire([pin(r1, 1)], pin(r3, 0)).note).toMatch(/net name OUT/);
      expect(net(doc, r1, "2")).toBe("OUT");
      expect(net(doc, r3, "1")).toBe("OUT");
    }
  });

  it("keeps a net's name through connectPins too, even one that isn't safe in SPICE", () => {
    const { doc, r1, r3 } = blocked();
    const at = pin(r1, 1);
    doc.schematic.labels.push({ id: "l", x: at.x, y: at.y, net: "my out" });
    doc.connectPins(r1, "2", r3, "1");
    expect(net(doc, r3, "1")).toBe("my_out");
    expect(doc.schematic.labels.map((l) => l.net)).toEqual(["my out", "my out"]);
    expect(doc.schematic.labels.map((l) => l.x)).toEqual([pin(r1, 1).x, pin(r3, 0).x]);
  });

  it("adds nothing if connectPins is asked again, and the assistant hears that", async () => {
    const { doc, r1, r3 } = blocked();
    const again = { from_ref: "R1", from_pin: "2", to_ref: "R3", to_pin: "1" };
    await expect(runTool(doc, "connect", again, noSimulator)).resolves.toMatchObject({ note: expect.stringMatching(/same net label/) });
    const before = JSON.stringify(doc.schematic);
    expect(doc.connectPins(r1, "2", r3, "1")).toBeUndefined();
    await expect(runTool(doc, "connect", again, noSimulator)).resolves.toMatchObject({ ok: true, note: expect.stringMatching(/already connected/) });
    expect(JSON.stringify(doc.schematic)).toBe(before);
    expect(doc.schematic.labels).toHaveLength(2);
  });

  it("doesn't draw a second wire beside the first when asked again", () => {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 200, 0);
    expect(doc.connectPins(r1, "2", r2, "1")?.points.length).toBeGreaterThan(1);
    expect(doc.connectPins(r2, "1", r1, "2")).toBeUndefined();
    expect(doc.schematic.wires).toHaveLength(1);
  });

  it("doesn't stack a hand-wired name on the one a spot already shows", () => {
    const { doc, r1, r3 } = blocked();
    doc.schematic.labels.push({ id: "l", x: pin(r1, 1).x, y: pin(r1, 1).y, net: "OUT" });
    doc.finishWire([pin(r1, 1)], pin(r3, 0));
    expect(doc.schematic.labels).toHaveLength(2);
  });

  it("won't draw a route that only looks clear, through a pin just off the grid", () => {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", 0, 0);
    // Its pin rounds to the spot where the plain route turns, and the netlist joins by that rounding.
    const r2 = doc.addPart("resistor", 200.3, 0);
    const r3 = doc.addPart("resistor", 200, 100);
    const plain = route(pin(r1, 1), pin(r3, 0));
    expect(doc.clearRoute(pin(r1, 1), pin(r3, 0))).toEqual(plain);
    expect(doc.wireProblem(plain)).toMatch(/R2 pin 1/);
    doc.connectPins(r1, "2", r3, "1");
    expect(doc.schematic.wires).toEqual([]);
    expect(net(doc, r1, "2")).toBe(net(doc, r3, "1"));
    expect(net(doc, r2, "1")).toBeUndefined();
  });

  it("finds a net's name on the far side of a wire", () => {
    const { doc, r1, r2 } = blocked();
    const lead = doc.addWire([{ x: 200, y: 100 }, { x: 300, y: 100 }]);
    const stray = doc.addPart("resistor", 280, 200);
    stray.rotation = 90;
    doc.addWire([lead.points[1], pin(stray, 0)]);
    doc.schematic.labels.push({ id: "l", x: pin(stray, 0).x, y: pin(stray, 0).y, net: "OUT" });
    expect(doc.finishWire([pin(r1, 1)], { x: 250, y: 100 }).note).toMatch(/net name OUT/);
    expect(net(doc, r1, "2")).toBe("OUT");
    expect(net(doc, r2, "1")).toBeUndefined();
  });

  it("makes ground the name when one end is on ground, however it got there", () => {
    const { doc, r1, r3 } = blocked();
    const gnd = doc.addPart("ground", 400, 400);
    doc.addWire([pin(r3, 1), pin(gnd, 0)]);
    doc.finishWire([pin(r1, 1)], pin(r3, 1));
    expect(net(doc, r1, "2")).toBe("0");
    expect(doc.schematic.labels[0].net).toBe("0");
  });

  it("doesn't take a name a file's pin already uses", () => {
    const { doc, r1, r2, r3 } = blocked();
    r2.pins[0].net = "link1";
    doc.finishWire([pin(r1, 1)], pin(r3, 0));
    expect(doc.schematic.labels[0].net).toBe("LINK2");
    expect(net(doc, r1, "2")).not.toBe(net(doc, r2, "1"));
  });

  it("leaves two ends alone if they're already on one net", () => {
    const { doc, r1, r2, r3 } = blocked();
    r1.pins[1].net = "A";
    r3.pins[0].net = "A";
    // A plain wire runs through R2's pins, on a net of their own.
    r2.pins[0].net = "B";
    const before = JSON.stringify(doc.schematic);
    const { refused, note } = doc.finishWire([pin(r1, 1)], pin(r3, 0));
    expect(refused).toBeUndefined();
    expect(note).toBe("Those are already connected.");
    expect(JSON.stringify(doc.schematic)).toBe(before);
  });
});

describe("corners placed by hand", () => {
  /** R1's pin 2 at (30,0), with R2's pin 1 straight below it at (30,80) and R3 away to one side. */
  function parts() {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 60, 80);
    const r3 = doc.addPart("resistor", 300, 200);
    return { doc, r1, r2, r3 };
  }

  it("keeps the draft open if it runs through a pin, says which, and changes nothing", () => {
    const { doc, r1, r3 } = parts();
    const before = JSON.stringify(doc.schematic);
    const draft = [pin(r1, 1), { x: 30, y: 120 }];
    const { refused } = doc.finishWire(draft, pin(r3, 0));
    expect(refused).toMatch(/connect the wire to R2 pin 1/);
    expect(JSON.stringify(doc.schematic)).toBe(before);
    expect(doc.dirty).toBe(false);
  });

  it("gives a wire ended in free space the same check", () => {
    const { doc, r1 } = parts();
    expect(doc.finishWire([pin(r1, 1), { x: 30, y: 120 }]).refused).toMatch(/connect the wire to R2 pin 1/);
    expect(doc.schematic.wires).toEqual([]);
    expect(doc.finishWire([pin(r1, 1), { x: 30, y: 50 }]).refused).toBeUndefined();
    expect(doc.schematic.wires).toHaveLength(1);
  });

  it("lets a draft end on the very net it runs through", () => {
    const { doc, r1, r2 } = parts();
    expect(doc.finishWire([pin(r1, 1), { x: 30, y: 120 }, { x: -100, y: 120 }], pin(r2, 0)).refused).toBeUndefined();
    expect(net(doc, r1, "2")).toBe(net(doc, r2, "1"));
  });

  it("lets a wire run over what's already on the net it starts from", () => {
    const { doc, r1, r2, r3 } = parts();
    doc.addWire([pin(r1, 1), { x: -60, y: 0 }, { x: -60, y: 80 }, pin(r2, 0)]);
    expect(doc.finishWire([pin(r1, 1), { x: 30, y: 120 }], pin(r3, 0)).refused).toBeUndefined();
    expect(net(doc, r1, "2")).toBe(net(doc, r3, "1"));
  });

  it("won't pick up a stray net name on the way", () => {
    const { doc, r1, r3 } = parts();
    doc.schematic.labels.push({ id: "l", x: 30, y: 50, net: "STRAY" });
    expect(doc.wireProblem([pin(r1, 1), { x: 30, y: 60 }])).toMatch(/the net STRAY/);
    expect(doc.finishWire([pin(r1, 1), { x: 30, y: 60 }], pin(r3, 0)).refused).toMatch(/the net STRAY/);
  });

  it("is happy with a plain crossing, which joins nothing", () => {
    const { doc, r1 } = parts();
    doc.addWire([{ x: 0, y: 40 }, { x: 60, y: 40 }]);
    expect(doc.wireProblem([pin(r1, 1), { x: 30, y: 70 }])).toBeUndefined();
  });

  it("won't end where two nets' wires cross, as that would join them both", () => {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", 0, 0);
    const a = doc.addPart("resistor", 200, 100);
    const b = doc.addPart("resistor", 300, -100);
    doc.addWire([pin(a, 0), { x: 400, y: 100 }]);
    const c = doc.addPart("resistor", 300, 300);
    c.rotation = 90;
    doc.addWire([{ x: 300, y: -70 }, pin(c, 0)]);
    b.rotation = 90;
    const before = JSON.stringify(doc.schematic);
    expect(doc.crossingAt({ x: 300, y: 100 })).toBe(true);
    expect(doc.finishWire([pin(r1, 1)], { x: 300, y: 100 }).refused).toMatch(/Two wires cross/);
    expect(JSON.stringify(doc.schematic)).toBe(before);
    expect(doc.crossingAt({ x: 320, y: 100 })).toBe(false);
    // Nor does a wire get there by stopping on that spot.
    expect(doc.finishWire([pin(r1, 1), { x: 30, y: 100 }, { x: 300, y: 100 }]).refused).toMatch(/Two wires cross/);
    expect(doc.finishWire([pin(r1, 1)], { x: 320, y: 100 }).refused).toBeUndefined();
    expect(net(doc, r1, "2")).toBe(net(doc, a, "1"));
    expect(net(doc, r1, "2")).not.toBe(net(doc, b, "2"));
  });
});

/** A real sheet with its drawing and browser stubbed out, driven by the events it listens for. */
function sheet(doc = new Doc()) {
  const listeners = new Map<string, (e: unknown) => void>();
  const el = {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    setAttribute() {}, focus() {}, setPointerCapture() {}, releasePointerCapture() {},
    hasPointerCapture: () => true,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  vi.stubGlobal("document", { createElement: () => el });
  vi.stubGlobal("window", { addEventListener() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("navigator", { platform: "test" });
  const canvas = new SchematicCanvas({ append() {} } as unknown as HTMLElement, doc);
  const status = { text: "" };
  canvas.onStatus = (text) => { status.text = text; };
  // A fresh sheet draws (0,0) at (400,300).
  const fire = (type: string, x: number, y: number, more: object = {}) => listeners.get(type)!({ pointerId: 1, button: 0, buttons: 1, clientX: x + 400, clientY: y + 300, ...more });
  const click = (x: number, y: number) => {
    fire("pointerdown", x, y);
    fire("pointerup", x, y, { buttons: 0 });
  };
  const drag = (from: Point, ...to: Point[]) => {
    fire("pointerdown", from.x, from.y);
    for (const p of to) fire("pointermove", p.x, p.y);
  };
  return { doc, canvas, status, fire, click, drag };
}

describe("a drag under way", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a thing the document knows about, and ends once", () => {
    const doc = new Doc();
    expect(doc.settle()).toBe(true);
    const settle = vi.fn(() => {
      // Ending one can make changes of its own without going round again.
      doc.checkpoint();
      return false;
    });
    doc.hold(settle);
    expect(doc.held).toBe(true);
    expect(doc.settle()).toBe(false);
    expect(doc.held).toBe(false);
    expect(doc.settle()).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("leaves no trace if it comes back to where it began", () => {
    const s = sheet();
    const { doc, fire } = s;
    const r1 = doc.addPart("resistor", 0, 0);
    doc.checkpoint();
    doc.dirty = false;
    const before = JSON.stringify(doc.schematic);
    s.drag({ x: 0, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 0 });
    fire("pointerup", 0, 0, { buttons: 0 });
    expect(JSON.stringify(doc.schematic)).toBe(before);
    expect(doc.dirty).toBe(false);
    doc.undo();
    expect(doc.schematic.components.map((c) => c.id)).toEqual([r1.id]);
  });

  /** R1 wired to R3, with R2's pin just above the wire, so dragging R1 up bends the wire across that pin. */
  function bent() {
    const s = sheet();
    const { doc } = s;
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 100, -100);
    r2.rotation = 90;
    const r3 = doc.addPart("resistor", 230, 0);
    doc.addWire([pin(r1, 1), pin(r3, 0)]);
    const before = connectivitySignature(doc.schematic);
    s.drag({ x: 0, y: 0 }, { x: 0, y: -35 }, { x: 0, y: -70 });
    expect(pin(r1, 1).y).toBe(-70);
    expect(connectivitySignature(doc.schematic), "mid-drag").not.toBe(before);
    expect(doc.held).toBe(true);
    return { ...s, r1, r2, r3, before };
  }

  it("settles when its pointer lifts, as ever", () => {
    const { doc, fire, before } = bent();
    fire("pointerup", 0, -70, { buttons: 0 });
    expect(doc.held).toBe(false);
    expect(connectivitySignature(doc.schematic)).toBe(before);
  });

  it("settles before an arrow key, which then moves the settled part", () => {
    const { doc, canvas, fire, r1, r2, before } = bent();
    canvas.nudgeSelected(10, 0);
    expect(connectivitySignature(doc.schematic)).toBe(before);
    expect(net(doc, r2, "2")).toBeUndefined();
    expect(doc.schematic.components[0].x).toBe(10);
    expect(doc.schematic.components[0].y).toBe(-70);
    // Letting go afterward does nothing more.
    fire("pointermove", 200, 200);
    fire("pointerup", 200, 200, { buttons: 0 });
    expect(doc.schematic.components[0].x).toBe(10);
    expect(r1.id).toBe(doc.schematic.components[0].id);
  });

  it("settles before a turn, or a mirror", () => {
    for (const act of ["rotateSelected", "mirrorSelected"] as const) {
      const { doc, canvas, before } = bent();
      canvas[act]();
      expect(doc.held).toBe(false);
      expect(connectivitySignature(doc.schematic)).toBe(before);
    }
  });

  it("settles before a delete, whose result then stands", () => {
    const { doc, canvas, fire } = bent();
    canvas.deleteSelected();
    expect(doc.schematic.components.map((c) => c.refDes)).toEqual(["R2", "R3"]);
    fire("pointerup", 0, -70, { buttons: 0 });
    expect(doc.schematic.components.map((c) => c.refDes)).toEqual(["R2", "R3"]);
  });

  it("settles before an undo, so going back can't take the step before it", () => {
    const s = sheet();
    const { doc } = s;
    doc.addPart("resistor", 300, 300);
    doc.checkpoint();
    const added = doc.addPart("resistor", 0, 0);
    s.drag({ x: 0, y: 0 }, { x: 50, y: 50 });
    doc.undo();
    expect(doc.schematic.components.map((c) => c.id)).toContain(added.id);
    expect(doc.schematic.components.find((c) => c.id === added.id)!.x).toBe(0);
    // Dragging back where it began and letting go doesn't reach for an undo step.
    s.fire("pointermove", 0, 0);
    s.fire("pointerup", 0, 0, { buttons: 0 });
    expect(doc.schematic.components).toHaveLength(2);
  });

  it("settles when the system ends the touch", () => {
    const { doc, fire, before } = bent();
    fire("pointercancel", 0, -70, { buttons: 0 });
    expect(doc.held).toBe(false);
    expect(connectivitySignature(doc.schematic)).toBe(before);
  });

  it("settles when capture is lost", () => {
    const { doc, fire, before } = bent();
    fire("lostpointercapture", 0, -70, { buttons: 0 });
    expect(doc.held).toBe(false);
    expect(connectivitySignature(doc.schematic)).toBe(before);
  });

  it("settles when the mouse comes back with no button down", () => {
    const { doc, fire, r1, before } = bent();
    fire("pointermove", 200, 200, { buttons: 0 });
    expect(doc.held).toBe(false);
    expect(connectivitySignature(doc.schematic)).toBe(before);
    expect(doc.schematic.components.find((c) => c.id === r1.id)!.x).toBe(0);
  });

  it("carries on if no move ever reported a button, as a trackpad gesture might", () => {
    const s = sheet();
    const r1 = s.doc.addPart("resistor", 0, 0);
    s.fire("pointerdown", 0, 0, { buttons: 0 });
    s.fire("pointermove", 40, 0, { buttons: 0 });
    s.fire("pointermove", 80, 0, { buttons: 0 });
    expect(s.doc.held).toBe(true);
    expect(r1.x).toBe(80);
    s.fire("pointerup", 80, 0, { buttons: 0 });
    expect(s.doc.held).toBe(false);
  });

  it("settles when a second finger comes down, and ignores the first from then on", () => {
    const { doc, fire, before } = bent();
    fire("pointerdown", 500, 500, { pointerId: 2 });
    expect(doc.held).toBe(false);
    expect(connectivitySignature(doc.schematic)).toBe(before);
    const parts = JSON.stringify(doc.schematic.components);
    fire("pointermove", 50, 50);
    fire("pointerup", 50, 50, { buttons: 0 });
    expect(JSON.stringify(doc.schematic.components)).toBe(parts);
  });

  it("ignores another finger's moves and lifts while it's going", () => {
    const { doc, fire, r1 } = bent();
    fire("pointermove", 300, 300, { pointerId: 2 });
    fire("pointerup", 300, 300, { pointerId: 2, buttons: 0 });
    expect(doc.held).toBe(true);
    expect(pin(r1, 1).y).toBe(-70);
  });

  it("says so if its check refuses it, whatever ended it", () => {
    const s = sheet();
    const { doc, canvas, status } = s;
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 300, 0);
    const before = connectivitySignature(doc.schematic);
    const landOn = pin(b, 0);
    s.drag({ x: 0, y: 0 }, { x: landOn.x - 30, y: landOn.y });
    canvas.nudgeSelected(0, 10);
    expect(status.text).toMatch(/wasn't applied/);
    expect(connectivitySignature(doc.schematic)).toBe(before);
    // The part has just jumped back, so the key that ended the drag does nothing more.
    expect(doc.schematic.components.find((c) => c.id === a.id)).toMatchObject({ x: 0, y: 0 });
    canvas.nudgeSelected(0, 10);
    expect(doc.schematic.components.find((c) => c.id === a.id)).toMatchObject({ x: 0, y: 10 });
  });

  it("does nothing if what was pressed has gone by its first step", () => {
    const s = sheet();
    const { doc, canvas, status } = s;
    doc.addPart("resistor", 0, 0);
    s.fire("pointerdown", 0, 0);
    canvas.deleteSelected();
    s.fire("pointermove", 40, 40);
    s.fire("pointerup", 40, 40, { buttons: 0 });
    expect(doc.schematic.components).toEqual([]);
    expect(status.text).toBe("");
  });

  it("starts from how things are at its first step, not at the press", () => {
    const s = sheet();
    const { doc, canvas } = s;
    doc.addPart("resistor", 0, 0);
    s.fire("pointerdown", 0, 0);
    s.fire("pointerup", 0, 0, { buttons: 0 });
    s.fire("pointerdown", 0, 0);
    // A press hasn't moved anything yet, so a turn just goes ahead.
    canvas.rotateSelected();
    expect(doc.schematic.components[0].rotation).toBe(90);
    s.fire("pointermove", 40, 40);
    expect(doc.schematic.components[0].x).toBe(40);
    expect(doc.schematic.components[0].rotation).toBe(90);
    s.fire("pointerup", 40, 40, { buttons: 0 });
  });

  it("never costs the assistant a tool call that reported ok", async () => {
    const s = sheet();
    const { doc } = s;
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 300, 0);
    // A drag that will be refused, as it lands R1's pin on R2's.
    const landOn = pin(r2, 0);
    s.drag({ x: 0, y: 0 }, { x: landOn.x - 30, y: landOn.y });
    const added = (await runTool(doc, "add_component", { kind: "capacitor", x: 0, y: 300 }, noSimulator)) as { ref: string };
    expect(s.status.text).toMatch(/wasn't applied/);
    expect(await runTool(doc, "connect", { from_ref: "R1", from_pin: "2", to_ref: added.ref, to_pin: "1" }, noSimulator)).toMatchObject({ ok: true });
    s.fire("pointermove", 100, 100);
    s.fire("pointerup", 100, 100, { buttons: 0 });
    expect(doc.findByRef(added.ref)).toBeDefined();
    expect(net(doc, doc.findByRef("R1")!, "2")).toBe(net(doc, doc.findByRef(added.ref)!, "1"));
    expect(r1.id).toBe(doc.findByRef("R1")!.id);
  });

  it("keeps what the assistant added while a drag that's fine carries on to its end", async () => {
    const s = sheet();
    const { doc } = s;
    doc.addPart("resistor", 0, 0);
    s.drag({ x: 0, y: 0 }, { x: 40, y: 40 });
    await runTool(doc, "add_component", { kind: "capacitor", x: 0, y: 300 }, noSimulator);
    s.fire("pointermove", 80, 80);
    s.fire("pointerup", 80, 80, { buttons: 0 });
    expect(doc.schematic.components.map((c) => [c.refDes, c.x])).toEqual([["R1", 40], ["C1", 0]]);
    expect(s.status.text).toBe("");
    doc.undo();
    expect(doc.schematic.components.map((c) => [c.refDes, c.x])).toEqual([["R1", 0]]);
  });

  it("settles before a tool reads the circuit too", async () => {
    const { doc, r2 } = bent();
    const circuit = (await runTool(doc, "get_circuit", {}, noSimulator)) as { components: { ref: string; nets: Record<string, string> }[] };
    expect(circuit.components.find((c) => c.ref === r2.refDes)!.nets).toEqual({});
  });
});

describe("a refused edit", () => {
  /** R1 and R2 wired, with a ground part's own pin on a pin of R3 so it can't be separated. */
  function circuit() {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", 0, 0, { value: "1k" });
    const r2 = doc.addPart("resistor", 300, 0);
    doc.addWire([pin(r1, 1), pin(r2, 0)]);
    const r3 = doc.addPart("resistor", 0, 300);
    const gnd = doc.addPart("ground", 0, 0);
    gnd.x = pin(r3, 1).x - gnd.pins[0].x;
    gnd.y = pin(r3, 1).y - gnd.pins[0].y;
    return { doc, r1, r2, r3, gnd };
  }

  /** Refuses, then edits as a Properties panel would, through the object it was holding. */
  function expectUntouched(doc: Doc, held: SchComponent, refuse: () => void) {
    const schematic = doc.schematic;
    const before = JSON.stringify(schematic);
    const notified = vi.fn();
    doc.subscribe(notified);
    refuse();
    expect(doc.schematic).toBe(schematic);
    expect(JSON.stringify(doc.schematic)).toBe(before);
    expect(doc.schematic.components).toContain(held);
    expect(notified).not.toHaveBeenCalled();
    held.params.value = "4.7k";
    expect(buildNetlist(doc.schematic).text).toContain(" 4700");
  }

  it("transformParts leaves every object as it was", () => {
    const { doc, r1, r2 } = circuit();
    expectUntouched(doc, r1, () => {
      expect(doc.transformParts([r1], (c) => { c.x = pin(r2, 1).x - 30; c.y = pin(r2, 1).y; })).toBe(false);
    });
  });

  it("the assistant's move_component leaves every object as it was", async () => {
    const { doc, r1, r2 } = circuit();
    const land = pin(r2, 1);
    const schematic = doc.schematic;
    await expect(runTool(doc, "move_component", { ref: "R1", x: land.x - 30, y: land.y }, noSimulator)).rejects.toThrow(/left as it was/);
    expect(doc.schematic).toBe(schematic);
    expect(doc.schematic.components).toContain(r1);
    r1.params.value = "4.7k";
    expect(buildNetlist(doc.schematic).text).toContain(" 4700");
  });

  it("disconnectPin leaves every object as it was", () => {
    const { doc, r3, gnd } = circuit();
    expectUntouched(doc, r3, () => {
      expect(() => doc.disconnectPin(gnd, "g")).toThrow(/can't be separated/);
    });
  });

  it("tidyLayout leaves every object as it was", () => {
    const doc = new Doc();
    const v = doc.addPart("vdc", -500, -500);
    const r1 = doc.addPart("resistor", 300, 300, { value: "1k" });
    doc.addWire([pin(v, 0), pin(r1, 0)]);
    doc.schematic.labels.push({ id: "l", x: 900, y: 900, net: "X" });
    // A layout that goes wrong: the name that named nothing reaches a pin.
    doc.clearRoute = () => {
      const first = doc.schematic.components[0];
      Object.assign(doc.schematic.labels[0], pinWorld(first, first.pins[0]));
      return undefined;
    };
    expectUntouched(doc, r1, () => {
      expect(doc.tidyLayout()).toBe(false);
    });
  });

  it("a success keeps the parts panels hold too", () => {
    const { doc, r1 } = circuit();
    const schematic = doc.schematic;
    expect(doc.transformParts([r1], (c) => { c.y = 60; })).toBe(true);
    expect(doc.schematic).toBe(schematic);
    expect(doc.schematic.components).toContain(r1);
    expect(r1.y).toBe(60);
    expect(doc.tidyLayout()).toBe(true);
    expect(doc.schematic.components).toContain(r1);
    r1.params.value = "4.7k";
    expect(buildNetlist(doc.schematic).text).toContain(" 4700");
  });

  it("a disconnect that goes through still does, on the part it was given", () => {
    const { doc, r1, r2 } = circuit();
    doc.disconnectPin(r1, "2");
    expect(net(doc, r1, "2")).toBeUndefined();
    expect(net(doc, r2, "1")).toBeUndefined();
    expect(doc.schematic.wires).toEqual([]);
  });
});

describe("tidy layout and named nets", () => {
  function divider() {
    const doc = new Doc();
    const v = doc.addPart("vdc", -200, 0);
    const r = doc.addPart("resistor", -40, -100);
    const g = doc.addPart("ground", -200, 100);
    doc.connectPins(v, "p", r, "1");
    doc.connectPins(r, "2", g, "g");
    doc.connectPins(v, "n", g, "g");
    return { doc, v, r, g };
  }

  for (const name of ["my net", "a[1]", "out(1)", "x;y", "v=1", "\"q\"", "OUT"]) {
    it(`keeps a net called ${name}, on its pin, and says so honestly`, async () => {
      const { doc, r, v } = divider();
      const at = pin(r, 0);
      doc.schematic.labels.push({ id: "l", x: at.x, y: at.y, net: name });
      const called = net(doc, v, "p");
      expect(called).not.toMatch(/^n\d+$/);
      await expect(runTool(doc, "tidy_layout", {}, noSimulator)).resolves.toMatchObject({ ok: true });
      expect(net(doc, v, "p")).toBe(called);
      expect(net(doc, r, "1")).toBe(called);
      expect(doc.schematic.labels.find((l) => l.net === name)).toMatchObject(pin(v, 0));
    });
  }

  it("brings a GND label along instead of leaving it on empty sheet", () => {
    const { doc, r, v, g } = divider();
    const at = pin(r, 1);
    doc.schematic.labels.push({ id: "l", x: at.x, y: at.y, net: "GND" });
    expect(doc.tidyLayout()).toBe(true);
    expect(doc.schematic.labels.find((l) => l.net === "GND")).toMatchObject(pin(v, 1));
    expect(net(doc, g, "g")).toBe("0");
  });

  it("keeps the name of a net held by a hidden link from a file", () => {
    const { doc, r, v } = divider();
    const at = pin(r, 0);
    doc.schematic.labels.push({ id: "l", x: at.x, y: at.y, net: "from file", hidden: true });
    expect(doc.tidyLayout()).toBe(true);
    expect(net(doc, v, "p")).toBe("from_file");
  });

  it("drops a hidden link with no pin to hold, as it names nothing", () => {
    const { doc } = divider();
    doc.schematic.labels.push({ id: "l", x: 900, y: 900, net: "gone", hidden: true });
    expect(doc.tidyLayout()).toBe(true);
    expect(doc.schematic.labels.map((l) => l.net)).not.toContain("gone");
  });

  /** The tester's case: a name left on empty sheet, right where the layout will put R1's pin. */
  function stray(name = "OUT") {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", -100, -200);
    r1.rotation = 90;
    const r2 = doc.addPart("resistor", 100, -30);
    doc.schematic.labels.push({ id: "l", x: 0, y: -30, net: name });
    return { doc, r1, r2 };
  }

  for (const name of ["OUT", "my net", "a[1]", "GND", "0"]) {
    it(`keeps parts off a name called ${name} that names nothing, and says where it went`, async () => {
      const { doc, r1, r2 } = stray(name);
      const result = await runTool(doc, "tidy_layout", {}, noSimulator);
      expect(result).toMatchObject({ ok: true, note: `Not on any pin, so left below the circuit: ${name}.` });
      expect(net(doc, r1, "1")).toBeUndefined();
      expect(net(doc, r1, "2")).toBeUndefined();
      expect(net(doc, r2, "1")).toBeUndefined();
      const label = doc.schematic.labels[0];
      expect(label.net).toBe(name);
      const lowest = Math.max(...doc.schematic.components.flatMap((c) => c.pins.map((p) => pinWorld(c, p).y)));
      expect(label.y).toBeGreaterThan(lowest);
      // Tidying again finds it just as safe.
      expect(doc.tidyLayout()).toBe(true);
      expect(net(doc, r1, "1")).toBeUndefined();
    });
  }

  it("keeps several names that name nothing apart, and has no note when there are none", async () => {
    const { doc } = stray();
    doc.schematic.labels.push({ id: "m", x: 40, y: -30, net: "OUT" }, { id: "n", x: 80, y: -30, net: "IN" });
    await expect(runTool(doc, "tidy_layout", {}, noSimulator)).resolves.toMatchObject({ note: expect.stringMatching(/IN, OUT/) });
    expect(new Set(doc.schematic.labels.map((l) => l.y)).size).toBe(3);
    const { doc: plain } = divider();
    await expect(runTool(plain, "tidy_layout", {}, noSimulator)).resolves.not.toHaveProperty("note");
  });

  it("won't report a tidy that gave a pin a name it didn't have", () => {
    const { doc, r1, r2 } = stray();
    doc.addWire([pin(r1, 1), pin(r2, 0)]);
    // Whatever puts a name on a pin, the check catches it. This route drops the stray name on one.
    doc.clearRoute = () => {
      const parked = doc.schematic.labels[0];
      const first = doc.schematic.components[0];
      Object.assign(parked, pinWorld(first, first.pins[0]));
      return undefined;
    };
    const before = JSON.stringify(doc.schematic);
    expect(doc.tidyLayout()).toBe(false);
    expect(JSON.stringify(doc.schematic)).toBe(before);
  });

  it("gives a name spread around its net one label, as a second under it would seem undeletable", () => {
    const { doc, r, v } = divider();
    for (const [i, at] of [pin(r, 0), pin(v, 0)].entries()) doc.schematic.labels.push({ id: `l${i}`, x: at.x, y: at.y, net: "OUT" });
    expect(doc.tidyLayout()).toBe(true);
    expect(doc.schematic.labels.filter((l) => l.net === "OUT")).toHaveLength(1);
    expect(net(doc, r, "1")).toBe("OUT");
  });

  it("spells a net's own name on any labels it needs for lack of a route", () => {
    const { doc, r, v } = divider();
    const at = pin(r, 0);
    doc.schematic.labels.push({ id: "l", x: at.x, y: at.y, net: "my net" });
    doc.clearRoute = () => undefined;
    expect(doc.tidyLayout()).toBe(true);
    expect(net(doc, v, "p")).toBe("my_net");
    expect(new Set(doc.schematic.labels.map((l) => l.net)).has("my_net")).toBe(false);
  });

  it("lets an unnamed net take a name when labels have to carry it", () => {
    const { doc, r, v } = divider();
    doc.clearRoute = () => undefined;
    const before = connectivitySignature(doc.schematic);
    expect(doc.tidyLayout()).toBe(true);
    expect(connectivitySignature(doc.schematic)).toBe(before);
    expect(net(doc, v, "p")).toBe(net(doc, r, "1"));
  });
});

describe("mirroring and turning a part teed into wires on both sides", () => {
  /** C1 upright, between tees on the wire above it and the rail below, in line with both. */
  function upright() {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", -100, -100);
    const r2 = doc.addPart("resistor", 60, -100);
    doc.addWire([pin(r1, 1), pin(r2, 0)]);
    const r3 = doc.addPart("resistor", -100, 60);
    const r4 = doc.addPart("resistor", 60, 60);
    doc.addWire([pin(r3, 1), pin(r4, 0)]);
    const c1 = doc.addPart("capacitor", -20, 0);
    c1.rotation = 90;
    doc.addWire([pin(c1, 0), { x: -20, y: -100 }]);
    doc.addWire([pin(c1, 1), { x: -20, y: 60 }]);
    return { doc, c1 };
  }

  it("mirrors, keeping every connection", () => {
    const { doc, c1 } = upright();
    const text = buildNetlist(doc.schematic).text;
    expect(doc.transformParts([c1], (c) => { c.mirrored = !c.mirrored; })).toBe(true);
    expect(c1.mirrored).toBe(true);
    expect(buildNetlist(doc.schematic).text).toBe(text);
    for (const wire of doc.schematic.wires) {
      wire.points.forEach((p, i) => { if (i) expect(p.x === wire.points[i - 1].x || p.y === wire.points[i - 1].y).toBe(true); });
    }
    expect(doc.transformParts([c1], (c) => { c.mirrored = !c.mirrored; })).toBe(true);
    expect(buildNetlist(doc.schematic).text).toBe(text);
  });

  it("turns all the way round, past where its pins swap", () => {
    const { doc, c1 } = upright();
    const text = buildNetlist(doc.schematic).text;
    for (const rotation of [180, 270, 0, 90] as const) {
      expect(doc.transformParts([c1], (c) => { c.rotation = rotation; }), `rotation ${rotation}`).toBe(true);
      expect(buildNetlist(doc.schematic).text).toBe(text);
    }
  });

  it("does the same for a part lying flat", () => {
    const doc = new Doc();
    const top = doc.addPart("resistor", -100, -100);
    top.rotation = 90;
    const bottom = doc.addPart("resistor", -100, 100);
    bottom.rotation = 90;
    doc.addWire([pin(top, 1), pin(bottom, 0)]);
    const right1 = doc.addPart("resistor", 100, -100);
    right1.rotation = 90;
    const right2 = doc.addPart("resistor", 100, 100);
    right2.rotation = 90;
    doc.addWire([pin(right1, 1), pin(right2, 0)]);
    const r = doc.addPart("resistor", 0, 0);
    doc.addWire([pin(r, 0), { x: -100, y: 0 }]);
    doc.addWire([pin(r, 1), { x: 100, y: 0 }]);
    const text = buildNetlist(doc.schematic).text;
    expect(doc.transformParts([r], (c) => { c.mirrored = true; })).toBe(true);
    expect(buildNetlist(doc.schematic).text).toBe(text);
  });

  describe("on the sheet", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("says mirror when it's a mirror that was refused, and turn when it's a turn", () => {
      const s = sheet();
      const { doc, canvas, status } = s;
      const r = doc.addPart("resistor", 0, 0);
      const other = doc.addPart("resistor", 100, 0);
      doc.addWire([pin(r, 1), pin(other, 0)]);
      canvas.select([r.id]);
      const transform = doc.transformParts;
      doc.transformParts = () => false;
      canvas.mirrorSelected();
      expect(status.text).toMatch(/^Mirroring it would change/);
      canvas.rotateSelected();
      expect(status.text).toMatch(/^That turn would change/);
      doc.transformParts = transform;
      canvas.rotateSelected();
      expect(status.text).toBe("");
    });

    it("leaves nothing behind when one is refused, not even a step to undo", () => {
      const { doc, canvas } = sheet();
      const r = doc.addPart("resistor", 0, 0);
      canvas.select([r.id]);
      doc.checkpoint();
      doc.addPart("resistor", 0, 100);
      doc.undo();
      doc.dirty = false;
      const schematic = doc.schematic;
      const held = doc.schematic.components[0];
      doc.transformParts = () => false;
      canvas.rotateSelected();
      expect(doc.schematic).toBe(schematic);
      expect(doc.schematic.components[0]).toBe(held);
      expect(doc.dirty).toBe(false);
      doc.redo();
      expect(doc.schematic.components).toHaveLength(2);
    });
  });
});

describe("while placing a part", () => {
  afterEach(() => vi.unstubAllGlobals());

  function placing() {
    const s = sheet();
    const r1 = s.doc.addPart("resistor", -200, 0);
    s.canvas.select([r1.id]);
    s.canvas.beginPlace("capacitor");
    return { ...s, r1 };
  }

  it("forgets the earlier selection, so keys leave that part alone", () => {
    const { doc, canvas, r1 } = placing();
    expect(canvas.selection.size).toBe(0);
    canvas.deleteSelected();
    canvas.rotateSelected();
    canvas.mirrorSelected();
    canvas.nudgeSelected(10, 0);
    expect(doc.schematic.components).toEqual([r1]);
    expect(r1).toMatchObject({ x: -200, y: 0, rotation: 0, mirrored: false });
  });

  it("turns the part being placed with R and M", () => {
    const { doc, canvas, click } = placing();
    canvas.rotateSelected();
    canvas.mirrorSelected();
    click(100, 100);
    expect(doc.schematic.components[1]).toMatchObject({ kind: "capacitor", x: 100, y: 100, rotation: 90, mirrored: true });
    expect(canvas.selection.has(doc.schematic.components[1].id)).toBe(true);
  });

  it("then lets R turn the placed part, as before", () => {
    const { doc, canvas, click } = placing();
    click(100, 100);
    canvas.rotateSelected();
    expect(doc.schematic.components[1].rotation).toBe(90);
  });

  it("starts each placing straight", () => {
    const { doc, canvas, click } = placing();
    canvas.rotateSelected();
    click(100, 100);
    canvas.beginPlace("capacitor");
    click(300, 100);
    expect(doc.schematic.components[2].rotation).toBe(0);
  });

  it("keeps saying so while Shift places several, with the turn kept for each", () => {
    const { doc, canvas, status, fire } = placing();
    canvas.rotateSelected();
    fire("pointerdown", 100, 100, { shiftKey: true });
    fire("pointerup", 100, 100, { buttons: 0 });
    expect(status.text).toMatch(/^Placing/);
    canvas.rotateSelected();
    expect(doc.schematic.components[1].rotation).toBe(90);
    fire("pointerdown", 300, 100);
    fire("pointerup", 300, 100, { buttons: 0 });
    expect(doc.schematic.components[2].rotation).toBe(180);
    expect(status.text).toBe("");
  });

  it("keeps saying so when an arrow key moves one that Shift placed", () => {
    const { canvas, status, fire } = placing();
    fire("pointerdown", 100, 100, { shiftKey: true });
    fire("pointerup", 100, 100, { buttons: 0 });
    canvas.nudgeSelected(10, 0);
    expect(status.text).toMatch(/^Placing/);
  });

  it("leaves a name waiting to be placed behind", () => {
    const { doc, canvas, click } = placing();
    canvas.beginAnnotation("label", "OUT");
    canvas.beginPlace("capacitor");
    click(100, 100);
    expect(doc.schematic.labels).toEqual([]);
    expect(doc.schematic.components).toHaveLength(2);
  });
});

describe("dragging what can't or can move", () => {
  afterEach(() => vi.unstubAllGlobals());

  function wired() {
    const s = sheet();
    const r1 = s.doc.addPart("resistor", -100, 0);
    const r2 = s.doc.addPart("resistor", 100, 0);
    const wire = s.doc.addWire([pin(r1, 1), pin(r2, 0)]);
    return { ...s, r1, r2, wire };
  }

  it("a lone wire says what an arrow key says, only once it's really dragged", () => {
    const { doc, canvas, status, fire, click, wire } = wired();
    click(0, 0);
    expect(canvas.selection.has(wire.id)).toBe(true);
    expect(status.text).toBe("");
    const before = JSON.stringify(doc.schematic);
    fire("pointerdown", 0, 0);
    fire("pointermove", 0, 40);
    expect(status.text).toBe("A wire moves with its parts. Move a part instead.");
    expect(doc.held).toBe(false);
    fire("pointermove", 0, 80);
    fire("pointerup", 0, 80, { buttons: 0 });
    expect(JSON.stringify(doc.schematic)).toBe(before);
    expect(doc.dirty).toBe(false);
    const said = status.text;
    click(300, 300);
    expect(status.text).toBe("");
    click(0, 0);
    canvas.nudgeSelected(0, 10);
    expect(status.text).toBe(said);
    expect(JSON.stringify(doc.schematic)).toBe(before);
  });

  it("a click's wobble over a grid line stays silent, whichever way it goes", () => {
    const { canvas, status, fire, wire } = wired();
    for (const [x, by] of [[4, 1], [14, 1], [5, -1], [5, 1], [4, 3]]) {
      canvas.select([]);
      fire("pointerdown", x, 0);
      fire("pointermove", x + by, 0);
      fire("pointerup", x + by, 0, { buttons: 0 });
      expect(canvas.selection.has(wire.id)).toBe(true);
      expect(status.text).toBe("");
    }
    // The same press carried on is a drag after all.
    fire("pointerdown", 4, 0);
    fire("pointermove", 5, 0);
    expect(status.text).toBe("");
    fire("pointermove", 20, 0);
    expect(status.text).toBe("A wire moves with its parts. Move a part instead.");
  });

  it("measures that wobble on the screen, so it holds zoomed far out", () => {
    const { doc, canvas, status, fire } = sheet();
    const r1 = doc.addPart("resistor", -2000, 0);
    const r2 = doc.addPart("resistor", 2000, 0);
    doc.addWire([pin(r1, 1), pin(r2, 0)]);
    Object.assign(canvas, { zoom: 0.1 });
    // One pixel is ten units here, so every pixel crosses a grid line.
    fire("pointerdown", 0, 0);
    fire("pointermove", 1, 0);
    fire("pointermove", 2, 0);
    expect(status.text).toBe("");
    fire("pointermove", 6, 0);
    expect(status.text).toBe("A wire moves with its parts. Move a part instead.");
  });

  it("doesn't count an arrow key as a wobble, however far out it's zoomed", () => {
    const { canvas, status, wire } = wired();
    Object.assign(canvas, { zoom: 0.1 });
    canvas.select([wire.id]);
    canvas.nudgeSelected(10, 0);
    expect(status.text).toBe("A wire moves with its parts. Move a part instead.");
  });

  it("a wire selected with its parts still moves with them", () => {
    const { doc, canvas, fire, r1, r2, wire } = wired();
    canvas.select([r1.id, r2.id, wire.id]);
    fire("pointerdown", 0, 0);
    fire("pointermove", 0, 40);
    fire("pointerup", 0, 40, { buttons: 0 });
    expect(doc.schematic.components.map((c) => c.y)).toEqual([40, 40]);
    expect(wire.points.map((p) => p.y)).toEqual([40, 40]);
  });

  it("a net's name goes by its dot, though the dot sits on the wire", () => {
    const { doc, canvas, fire, wire } = wired();
    doc.schematic.labels.push({ id: "l", x: 0, y: 0, net: "OUT" });
    fire("pointerdown", 2, 1);
    expect([...canvas.selection]).toEqual(["l"]);
    fire("pointermove", 40, 0);
    fire("pointerup", 40, 0, { buttons: 0 });
    expect(doc.schematic.labels[0]).toMatchObject({ x: 40, y: 0 });
    expect(wire.points.map((p) => p.y)).toEqual([0, 0]);
    expect(net(doc, doc.schematic.components[0], "2")).toBe("OUT");
  });

  it("a click just along from the dot still means the wire", () => {
    const { canvas, doc, click, wire } = wired();
    doc.schematic.labels.push({ id: "l", x: 0, y: 0, net: "OUT" });
    click(-40, 0);
    expect([...canvas.selection]).toEqual([wire.id]);
  });
});

describe("a wire being drawn", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** R1 selected, then a wire begun from R2's pin. */
  function begun() {
    const s = sheet();
    const r1 = s.doc.addPart("resistor", -100, 0);
    const r2 = s.doc.addPart("resistor", 100, 0);
    const r3 = s.doc.addPart("resistor", 100, 100);
    s.click(-100, 0);
    expect(s.canvas.selection.has(r1.id)).toBe(true);
    s.click(70, 0);
    expect(s.status.text).toMatch(/^Wiring/);
    return { ...s, r1, r2, r3 };
  }

  it("forgets the earlier selection, so keys leave that part alone", () => {
    const { doc, canvas, status, r1 } = begun();
    expect(canvas.selection.size).toBe(0);
    canvas.deleteSelected();
    canvas.rotateSelected();
    canvas.mirrorSelected();
    canvas.nudgeSelected(0, 10);
    expect(doc.schematic.components).toHaveLength(3);
    expect(r1).toMatchObject({ x: -100, y: 0, rotation: 0, mirrored: false });
    expect(status.text).toMatch(/^Wiring/);
    expect(doc.dirty).toBe(false);
  });

  it("keeps saying so when something selected on purpose is edited meanwhile", () => {
    const { doc, canvas, status, r1, r3, click } = begun();
    canvas.select([r1.id]);
    canvas.rotateSelected();
    expect(r1.rotation).toBe(90);
    expect(status.text).toMatch(/^Wiring/);
    canvas.nudgeSelected(0, 10);
    expect(r1.y).toBe(10);
    expect(status.text).toMatch(/^Wiring/);
    click(pin(r3, 0).x, pin(r3, 0).y);
    expect(doc.schematic.wires).toHaveLength(1);
    expect(status.text).toBe("");
  });

  it("is cancelled when an undo takes away the part it started from", () => {
    const { doc, status, click } = sheet();
    doc.checkpoint();
    const c1 = doc.addPart("capacitor", 100, 100);
    click(pin(c1, 0).x, pin(c1, 0).y);
    expect(status.text).toMatch(/^Wiring/);
    doc.undo();
    expect(status.text).toBe("");
    // The next click is an ordinary click, not a corner of a wire from nowhere.
    click(0, 0);
    click(50, 50);
    expect(doc.schematic.wires).toEqual([]);
    expect(status.text).toBe("");
  });

  it("is cancelled when its part moves away from under it", () => {
    const { doc, status, click } = sheet();
    const c1 = doc.addPart("capacitor", 100, 100);
    click(pin(c1, 0).x, pin(c1, 0).y);
    c1.x += 100;
    doc.notify();
    expect(status.text).toBe("");
  });

  it("carries on through any other change", () => {
    const { doc, status, click } = sheet();
    const c1 = doc.addPart("capacitor", 100, 100);
    click(pin(c1, 0).x, pin(c1, 0).y);
    doc.addPart("resistor", 400, 400);
    doc.notify();
    expect(status.text).toMatch(/^Wiring/);
  });

  it("keeps a corner off a pin, stays open, and goes back to its hint on the next click", () => {
    const { doc, status, click } = sheet();
    const r1 = doc.addPart("resistor", 0, 0);
    doc.addPart("resistor", 60, 80);
    const r3 = doc.addPart("resistor", 300, 200);
    click(30, 0);
    click(30, 120);
    expect(status.text).toMatch(/connect the wire to R2 pin 1/);
    expect(doc.schematic.wires).toEqual([]);
    click(-20, 40);
    expect(status.text).toMatch(/^Wiring/);
    click(pin(r3, 0).x, pin(r3, 0).y);
    expect(net(doc, r1, "2")).toBe(net(doc, r3, "1"));
    expect(net(doc, doc.schematic.components[1], "1")).toBeUndefined();
  });

  it("says so when labels had to make the connection", () => {
    const { doc, status, click } = sheet();
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 100, 0);
    doc.clearRoute = () => undefined;
    click(30, 0);
    click(pin(r2, 1).x, pin(r2, 1).y);
    expect(status.text).toMatch(/both ends got the net name LINK1/);
    expect(net(doc, r1, "2")).toBe(net(doc, r2, "2"));
    expect(net(doc, r2, "1")).toBeUndefined();
  });

  it("ends in free space with a double click, if that joins nothing else", () => {
    const { doc, status, click, fire } = sheet();
    doc.addPart("resistor", 0, 0);
    click(30, 0);
    click(30, 40);
    // The second press of a double click adds nothing, then the double click ends the wire.
    click(30, 40);
    fire("dblclick", 30, 40);
    expect(doc.schematic.wires.map((w) => w.points)).toEqual([[{ x: 30, y: 0 }, { x: 30, y: 40 }]]);
    expect(status.text).toBe("");
  });

  it("stays open on a double click if something has come to lie under it", () => {
    const { doc, status, click, fire } = sheet();
    doc.addPart("resistor", 0, 0);
    click(30, 0);
    click(30, 100);
    // The assistant places a part while the wire is being drawn.
    doc.addPart("resistor", 60, 50);
    doc.notify();
    fire("dblclick", 30, 100);
    expect(doc.schematic.wires).toEqual([]);
    expect(status.text).toMatch(/connect the wire to R2 pin 1/);
    click(300, 300);
    expect(status.text).toMatch(/connect the wire to R2 pin 1/);
  });
});
