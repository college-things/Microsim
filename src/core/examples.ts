// Starter circuits, drawn for this app and built through the same API as the editor.
import { Doc } from "./doc";
import type { Schematic } from "./schematic";

export interface Example {
  name: string;
  build(doc: Doc): void;
}

export const EXAMPLES: Example[] = [
  {
    name: "RC low-pass filter",
    build(doc) {
      const gen = doc.addPart("vsin", -200, 0, { amp: "1", freq: "1k" });
      const r = doc.addPart("resistor", -60, -30, { value: "1k" });
      const c = doc.addPart("capacitor", 60, 40, { value: "159n" });
      c.rotation = 90;
      const gnd = doc.addPart("ground", -200, 130);
      const scope = doc.addPart("oscilloscope", 170, -120);
      const bode = doc.addPart("bode-plotter", 300, -120);
      doc.connectPins(gen, "p", r, "1");
      doc.connectPins(r, "2", c, "1");
      doc.connectPins(c, "2", gnd, "g");
      doc.connectPins(gen, "n", gnd, "g");
      doc.connectPins(gen, "p", scope, "A");
      doc.connectPins(c, "1", scope, "B");
      doc.connectPins(scope, "G", gnd, "g");
      doc.connectPins(gen, "p", bode, "in+");
      doc.connectPins(gnd, "g", bode, "in-");
      doc.connectPins(c, "1", bode, "out+");
      doc.connectPins(gnd, "g", bode, "out-");
    },
  },
  {
    name: "Common-emitter amplifier",
    build(doc) {
      const vcc = doc.addPart("vcc", 120, -220, { value: "12" });
      const gen = doc.addPart("vsin", -260, 40, { amp: "10m", freq: "1k" });
      const cin = doc.addPart("capacitor", -160, 0, { value: "10u" });
      const r1 = doc.addPart("resistor", -60, -120, { value: "47k" });
      r1.rotation = 90;
      const r2 = doc.addPart("resistor", -60, 120, { value: "10k" });
      r2.rotation = 90;
      const rc = doc.addPart("resistor", 120, -120, { value: "2.2k" });
      rc.rotation = 90;
      const q = doc.addPart("npn", 100, 0);
      const re = doc.addPart("resistor", 120, 120, { value: "470" });
      re.rotation = 90;
      const ce = doc.addPart("capacitor", 220, 120, { value: "100u" });
      ce.rotation = 90;
      const gnd = doc.addPart("ground", -60, 220);
      const scope = doc.addPart("oscilloscope", 340, -120);
      doc.connectPins(gen, "p", cin, "1");
      doc.connectPins(cin, "2", q, "B");
      doc.connectPins(vcc, "p", r1, "1");
      doc.connectPins(r1, "2", q, "B");
      doc.connectPins(q, "B", r2, "1");
      doc.connectPins(r2, "2", gnd, "g");
      doc.connectPins(vcc, "p", rc, "1");
      doc.connectPins(rc, "2", q, "C");
      doc.connectPins(q, "E", re, "1");
      doc.connectPins(re, "2", gnd, "g");
      doc.connectPins(q, "E", ce, "1");
      doc.connectPins(ce, "2", gnd, "g");
      doc.connectPins(gen, "n", gnd, "g");
      doc.connectPins(q, "C", scope, "A");
      doc.connectPins(gen, "p", scope, "B");
      doc.connectPins(scope, "G", gnd, "g");
    },
  },
  {
    name: "Inverting op-amp",
    build(doc) {
      const gen = doc.addPart("vsin", -240, 40, { amp: "0.5", freq: "1k" });
      const rin = doc.addPart("resistor", -120, 0, { value: "1k" });
      const rf = doc.addPart("resistor", 40, -90, { value: "10k" });
      const u = doc.addPart("opamp", 40, 10);
      const gnd = doc.addPart("ground", -240, 180);
      const scope = doc.addPart("oscilloscope", 240, -120);
      doc.connectPins(gen, "p", rin, "1");
      doc.connectPins(rin, "2", u, "-");
      doc.connectPins(u, "-", rf, "1");
      doc.connectPins(rf, "2", u, "out");
      doc.connectPins(u, "+", gnd, "g");
      doc.connectPins(gen, "n", gnd, "g");
      doc.connectPins(u, "out", scope, "A");
      doc.connectPins(gen, "p", scope, "B");
      doc.connectPins(scope, "G", gnd, "g");
    },
  },
  {
    name: "Full-wave rectifier",
    build(doc) {
      // The source sits between the bridge's two legs, so nothing has to cross them.
      const gen = doc.addPart("vsin", 0, 0, { amp: "12", freq: "60" });
      gen.rotation = 270;
      const d1 = doc.addPart("diode", -120, -70);
      d1.rotation = 270;
      const d2 = doc.addPart("diode", 120, -70);
      d2.rotation = 270;
      const d3 = doc.addPart("diode", -120, 70);
      d3.rotation = 270;
      const d4 = doc.addPart("diode", 120, 70);
      d4.rotation = 270;
      const load = doc.addPart("resistor", 220, 0, { value: "1k" });
      load.rotation = 90;
      const c = doc.addPart("capacitor", 320, 0, { value: "100u" });
      c.rotation = 90;
      doc.addPart("ground", 220, 150);
      doc.addPart("oscilloscope", 410, -130);
      // AC comes in at the middle of each leg, DC+ leaves along the top and DC- along the bottom.
      doc.connectPins(d1, "A", d3, "K");
      doc.connectPins(d2, "A", d4, "K");
      doc.addWire([{ x: -30, y: 0 }, { x: -120, y: 0 }]);
      doc.addWire([{ x: 30, y: 0 }, { x: 120, y: 0 }]);
      doc.connectPins(d1, "K", d2, "K");
      doc.connectPins(d3, "A", d4, "A");
      doc.connectPins(d2, "K", load, "1");
      doc.connectPins(d4, "A", load, "2");
      doc.addWire([{ x: 220, y: 100 }, { x: 220, y: 140 }]);
      doc.addWire([{ x: 220, y: -100 }, { x: 320, y: -100 }, { x: 320, y: -30 }]);
      doc.addWire([{ x: 220, y: 100 }, { x: 320, y: 100 }, { x: 320, y: 30 }]);
      doc.addWire([{ x: 320, y: -100 }, { x: 395, y: -100 }]);
      doc.addWire([{ x: 320, y: 100 }, { x: 480, y: 100 }, { x: 480, y: -130 }, { x: 445, y: -130 }]);
    },
  },
  {
    name: "D flip-flop divider",
    build(doc) {
      const clk = doc.addPart("clock", -200, 0, { freq: "1k" });
      const ff = doc.addPart("dff", 0, 0);
      const load = doc.addPart("resistor", 160, 60, { value: "10k" });
      load.rotation = 90;
      const gnd = doc.addPart("ground", 160, 160);
      const logic = doc.addPart("logic-analyzer", 260, -120);
      doc.connectPins(clk, "p", ff, "CLK");
      doc.connectPins(ff, "QN", ff, "D");
      doc.connectPins(ff, "Q", load, "1");
      doc.connectPins(load, "2", gnd, "g");
      doc.connectPins(clk, "p", logic, "1");
      doc.connectPins(ff, "Q", logic, "2");
    },
  },
];

export function buildExample(example: Example): Schematic {
  const doc = new Doc();
  doc.schematic.name = example.name;
  example.build(doc);
  return doc.schematic;
}
