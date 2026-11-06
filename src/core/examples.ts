// Starter circuits, drawn for this app and built through the same API as the editor.
import { Doc } from "./doc";
import { assemble51 } from "../engine/asm51";
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

EXAMPLES.push({
  name: "Holding tank process",
  build(doc) {
    const fill = doc.addPart("vdc", -220, -60, { value: "2" });
    const drain = doc.addPart("vdc", -220, 90, { value: "0.5" });
    const tank = doc.addPart("holding-tank", 0, 0, { capacity: "10", rate: "1" });
    const scope = doc.addPart("tektronix-scope", 220, -130, { timePerDiv: "1" });
    const gnd = doc.addPart("ground", -220, 190);
    doc.connectPins(fill, "p", tank, "FILL"); doc.connectPins(drain, "p", tank, "DRAIN");
    doc.connectPins(fill, "n", gnd, "g"); doc.connectPins(drain, "n", gnd, "g");
    doc.connectPins(tank, "LEVEL", scope, "A"); doc.connectPins(tank, "FULL", scope, "B"); doc.connectPins(scope, "G", gnd, "g");
    doc.schematic.texts.push({ id: "tank-explanation", x: -100, y: 180, text: "LEVEL: 1 V = 1 L. Net filling rate: 1.5 L/s. FULL: 5 V at 99%." });
  },
}, {
  name: "Conveyor process",
  build(doc) {
    const speed = doc.addPart("vdc", -240, -60, { value: "2" });
    const enable = doc.addPart("vdc", -240, 90, { value: "5" });
    const belt = doc.addPart("conveyor", 0, 0, { length: "10", gain: "1", sensor: "5" });
    const scope = doc.addPart("tektronix-scope", 230, -130, { timePerDiv: "1" });
    const gnd = doc.addPart("ground", -240, 190);
    doc.connectPins(speed, "p", belt, "SPEED"); doc.connectPins(enable, "p", belt, "ENABLE");
    doc.connectPins(speed, "n", gnd, "g"); doc.connectPins(enable, "n", gnd, "g");
    doc.connectPins(belt, "POSITION", scope, "A"); doc.connectPins(belt, "SENSOR", scope, "B"); doc.connectPins(scope, "G", gnd, "g");
    doc.schematic.texts.push({ id: "belt-explanation", x: -100, y: 180, text: "POSITION: 1 V = 1 m. Belt repeats every 5 s. Set ENABLE below 2.5 V to stop." });
  },
}, {
  name: "8051 serial hello",
  build(doc) {
    // Hand-assembled: timer 1 mode 2 (TH1=FDh) gives 9600 baud at 11.0592 MHz; sends a zero-terminated string forever.
    const mcu = doc.addPart("mcu8051", -60, 0, { frequency: "11.0592Meg", code: "758920758dfd758bfd759850d28e90001fe49360f9f5993099fdc299a380f248656c6c6f2066726f6d20383035310d0a00" });
    const load = doc.addPart("resistor", 120, 120, { value: "100k" });
    load.rotation = 90;
    const gnd = doc.addPart("ground", 120, 220);
    const terminal = doc.addPart("serial-terminal", 200, -60, { baud: "9600" });
    doc.connectPins(mcu, "P3.1", load, "1");
    doc.connectPins(load, "2", gnd, "g");
    doc.connectPins(mcu, "RST", gnd, "g");
    doc.connectPins(mcu, "P3.1", terminal, "RX");
    doc.schematic.texts.push({ id: "uart-explanation", x: -100, y: 260, text: "P3.1 (TXD) sends 8N1 at 9600 baud. The serial terminal decodes it." });
  },
}, {
  name: "8051 serial echo",
  build(doc) {
    const program = assemble51(ECHO_SOURCE).code;
    const mcu = doc.addPart("mcu8051", -60, 0, { frequency: "11.0592Meg", code: Array.from(program, (b) => b.toString(16).padStart(2, "0")).join(""), asm: ECHO_SOURCE });
    const load = doc.addPart("resistor", 120, 120, { value: "100k" });
    load.rotation = 90;
    const gnd = doc.addPart("ground", 120, 220);
    const terminal = doc.addPart("serial-terminal", 200, -60, { baud: "9600" });
    doc.connectPins(mcu, "P3.1", load, "1");
    doc.connectPins(load, "2", gnd, "g");
    doc.connectPins(mcu, "RST", gnd, "g");
    doc.connectPins(mcu, "P3.1", terminal, "RX");
    doc.connectPins(mcu, "P3.0", terminal, "TX");
    doc.schematic.texts.push({ id: "echo-explanation", x: -100, y: 260, text: "Run it, then type into the serial terminal. The 8051 sends each letter back in upper case." });
  },
});

EXAMPLES.push({
  name: "Frequency counter and spectrum",
  build(doc) {
    // A 25% duty square wave has strong odd and even harmonics for the spectrum analyzer to show.
    const gen = doc.addPart("function-generator", -220, -40, { shape: "square", freq: "2k", amp: "2.5", offset: "2.5", duty: "25" });
    const gnd = doc.addPart("ground", -210, 80);
    const load = doc.addPart("resistor", -80, 20, { value: "10k" });
    load.rotation = 90;
    const counter = doc.addPart("frequency-counter", 20, -140);
    const analyzer = doc.addPart("spectrum-analyzer", 120, -140, { fmax: "40k" });
    doc.connectPins(gen, "n", gnd, "g");
    doc.connectPins(gen, "p", load, "1");
    doc.connectPins(load, "2", gnd, "g");
    doc.connectPins(gen, "p", counter, "IN");
    doc.connectPins(gen, "p", analyzer, "IN");
    doc.schematic.texts.push({ id: "measure-explanation", x: -100, y: 140, text: "Run it: the counter reads 2 kHz at 25% duty, and the analyzer shows the harmonics. Every fourth one is missing." });
  },
}, {
  name: "Word generator count",
  build(doc) {
    // The word generator counts in binary on D0 to D3; the logic analyzer shows the count.
    const words = doc.addPart("word-generator", -120, 0, { words: "0 1 2 3 4 5 6 7 8 9 A B C D E F", rate: "8k" });
    const logic = doc.addPart("logic-analyzer", 120, 0);
    for (const [bit, channel] of [["D0", "1"], ["D1", "2"], ["D2", "3"], ["D3", "4"]]) doc.connectPins(words, bit, logic, channel);
    doc.schematic.texts.push({ id: "words-explanation", x: -100, y: 110, text: "D0 to D3 count from 0 to F in binary, one word every 125 us, then repeat." });
  },
});

EXAMPLES.push({
  name: "Logic converter majority",
  build(doc) {
    // Three-input majority: OUT is 1 when at least two of A, B and C are 1.
    const ab = doc.addPart("and", -40, -80), ac = doc.addPart("and", -40, 0), bc = doc.addPart("and", -40, 80);
    const or1 = doc.addPart("or", 80, -40), or2 = doc.addPart("or", 180, 0);
    const load = doc.addPart("resistor", 260, 60, { value: "10k" });
    load.rotation = 90;
    const gnd = doc.addPart("ground", 260, 160);
    const converter = doc.addPart("logic-converter", 0, 240);
    doc.connectPins(ab, "y", or1, "a"); doc.connectPins(ac, "y", or1, "b");
    doc.connectPins(or1, "y", or2, "a"); doc.connectPins(bc, "y", or2, "b");
    doc.connectPins(or2, "y", load, "1"); doc.connectPins(load, "2", gnd, "g");
    doc.connectPins(converter, "A", ab, "a"); doc.connectPins(converter, "A", ac, "a");
    doc.connectPins(converter, "B", ab, "b"); doc.connectPins(converter, "B", bc, "a");
    doc.connectPins(converter, "C", ac, "b"); doc.connectPins(converter, "C", bc, "b");
    doc.connectPins(converter, "OUT", or2, "y");
    doc.schematic.texts.push({ id: "majority-explanation", x: -120, y: 330, text: "Double-click the logic converter and read the truth table: OUT = AB + AC + BC." });
  },
});

/** Echoes each received character, upper-casing letters. Shown in Design > Microcontroller program. */
const ECHO_SOURCE = `; 9600 baud 8N1 at 11.0592 MHz: timer 1 in mode 2 reloads from 0FDH.
        ORG 0
        MOV TMOD,#20H
        MOV TH1,#0FDH
        MOV TL1,#0FDH
        MOV SCON,#50H      ; mode 1, receiver enabled
        SETB TR1
WAIT:   JNB RI,WAIT        ; wait for a character
        CLR RI
        MOV A,SBUF
        CJNE A,#'a',$+3    ; C is set when A < 'a'
        JC SEND
        CJNE A,#'z'+1,$+3  ; C is set when A <= 'z'
        JNC SEND
        CLR C
        SUBB A,#20H        ; lower case to upper case
SEND:   MOV SBUF,A
        JNB TI,$
        CLR TI
        SJMP WAIT
        END
`;

export function buildExample(example: Example): Schematic {
  const doc = new Doc();
  doc.schematic.name = example.name;
  example.build(doc);
  return doc.schematic;
}
