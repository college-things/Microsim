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

EXAMPLES.push({
  name: "8051 LCD hello",
  build(doc) {
    const program = assemble51(LCD_SOURCE).code;
    const mcu = doc.addPart("mcu8051", -160, 0, { frequency: "12Meg", code: Array.from(program, (b) => b.toString(16).padStart(2, "0")).join(""), asm: LCD_SOURCE });
    const lcd = doc.addPart("lcd16x2", 160, -160);
    const gnd = doc.addPart("ground", 0, 200);
    doc.connectPins(mcu, "RST", gnd, "g");
    doc.connectPins(mcu, "P2.0", lcd, "RS");
    doc.connectPins(mcu, "P2.1", lcd, "E");
    doc.connectPins(lcd, "RW", gnd, "g");
    for (const bit of [4, 5, 6, 7]) doc.connectPins(mcu, `P2.${bit}`, lcd, `D${bit}`);
    doc.schematic.texts.push({ id: "lcd-explanation", x: -60, y: 260, text: "Run it: the 8051 sets the LCD to 4-bit mode on P2 and writes two lines." });
  },
});

EXAMPLES.push({
  name: "8051 keypad and LCD",
  build(doc) {
    const program = assemble51(KEYPAD_SOURCE).code;
    const mcu = doc.addPart("mcu8051", -160, 0, { frequency: "12Meg", code: Array.from(program, (b) => b.toString(16).padStart(2, "0")).join(""), asm: KEYPAD_SOURCE });
    const lcd = doc.addPart("lcd16x2", 160, -160);
    const keypad = doc.addPart("keypad4x4", -420, 40);
    const gnd = doc.addPart("ground", 0, 200);
    doc.connectPins(mcu, "RST", gnd, "g");
    doc.connectPins(mcu, "P2.0", lcd, "RS");
    doc.connectPins(mcu, "P2.1", lcd, "E");
    doc.connectPins(lcd, "RW", gnd, "g");
    for (const bit of [4, 5, 6, 7]) doc.connectPins(mcu, `P2.${bit}`, lcd, `D${bit}`);
    for (const n of [1, 2, 3, 4]) {
      doc.connectPins(keypad, `R${n}`, mcu, `P1.${n - 1}`);
      doc.connectPins(keypad, `C${n}`, mcu, `P1.${n + 3}`);
    }
    doc.schematic.texts.push({ id: "keypad-explanation", x: -300, y: 260, text: "Run it, select the keypad and hold a key (in Properties, or on your keyboard). The LCD shows it." });
  },
});

/** Scans a 4x4 keypad on P1 (rows P1.0-P1.3 out, columns P1.4-P1.7 in) and shows the key on the LCD. */
const KEYPAD_SOURCE = `RSF     BIT 20H.0
LASTKEY DATA 30H
        ORG 0
        MOV SP,#60H
        MOV A,#30H         ; LCD power-up in 4-bit mode, as in "8051 LCD hello"
        ACALL NIBBLE
        ACALL NIBBLE
        ACALL NIBBLE
        MOV A,#20H
        ACALL NIBBLE
        MOV A,#28H
        ACALL CMD
        MOV A,#0CH
        ACALL CMD
        MOV A,#06H
        ACALL CMD
        MOV A,#01H
        ACALL CMD
        MOV DPTR,#PROMPT
        ACALL PRINT
        MOV LASTKEY,#0
MAIN:   MOV R2,#0          ; row being scanned
SCAN:   MOV A,R2
        MOV DPTR,#ROWS
        MOVC A,@A+DPTR
        MOV P1,A           ; one row low, the columns pulled high
        NOP
        NOP
        MOV A,P1
        CPL A
        ANL A,#0F0H        ; columns pulled low by a pressed key
        JNZ FOUND
        INC R2
        CJNE R2,#4,SCAN
        MOV LASTKEY,#0     ; nothing pressed: the next press shows even if it repeats
        SJMP MAIN
FOUND:  SWAP A
        MOV R3,#0
COLUMN: JB ACC.0,GOT
        RR A
        INC R3
        SJMP COLUMN
GOT:    MOV A,R2           ; key = row * 4 + column
        RL A
        RL A
        ADD A,R3
        MOV DPTR,#KEYS
        MOVC A,@A+DPTR
        CJNE A,LASTKEY,NEWKEY
        SJMP MAIN
NEWKEY: MOV LASTKEY,A
        PUSH ACC
        MOV A,#0C5H        ; second line, after "Key: "
        ACALL CMD
        POP ACC
        ACALL DAT
        SJMP MAIN

CMD:    CLR RSF
        SJMP SEND
DAT:    SETB RSF
SEND:   PUSH ACC
        ACALL NIBBLE
        POP ACC
        SWAP A
        ACALL NIBBLE
        ACALL DELAY
        RET
NIBBLE: ANL A,#0F0H
        JNB RSF,NOTDATA
        ORL A,#01H
NOTDATA: MOV P2,A
        SETB P2.1
        NOP
        CLR P2.1
        RET
PRINT:  CLR A
        MOVC A,@A+DPTR
        JZ DONE
        ACALL DAT
        INC DPTR
        SJMP PRINT
DONE:   MOV A,#0C0H
        ACALL CMD
        MOV DPTR,#KEYLABEL
PRINT2: CLR A
        MOVC A,@A+DPTR
        JZ DONE2
        ACALL DAT
        INC DPTR
        SJMP PRINT2
DONE2:  RET
DELAY:  MOV R7,#100
        DJNZ R7,$
        RET
ROWS:   DB 0FEH,0FDH,0FBH,0F7H
KEYS:   DB "123A456B789C*0#D"
PROMPT: DB "Press a key",0
KEYLABEL: DB "Key: ",0
        END
`;

/** Drives an HD44780-style LCD in 4-bit mode: RS = P2.0, E = P2.1, D4-D7 = P2.4-P2.7. */
const LCD_SOURCE = `RSF     BIT 20H.0          ; register select for the next transfer
        ORG 0
        MOV SP,#60H
        MOV A,#30H         ; power-up: three 8-bit function sets...
        ACALL NIBBLE
        ACALL NIBBLE
        ACALL NIBBLE
        MOV A,#20H         ; ...then switch to 4-bit
        ACALL NIBBLE
        MOV A,#28H         ; 4-bit, two lines
        ACALL CMD
        MOV A,#0CH         ; display on, cursor off
        ACALL CMD
        MOV A,#06H         ; move right after each character
        ACALL CMD
        MOV A,#01H         ; clear
        ACALL CMD
        MOV DPTR,#LINE1
        ACALL PRINT
        MOV A,#0C0H        ; second line
        ACALL CMD
        MOV DPTR,#LINE2
        ACALL PRINT
HERE:   SJMP HERE

CMD:    CLR RSF
        SJMP SEND
DAT:    SETB RSF
SEND:   PUSH ACC
        ACALL NIBBLE       ; high nibble first
        POP ACC
        SWAP A
        ACALL NIBBLE
        ACALL DELAY
        RET
NIBBLE: ANL A,#0F0H        ; data on P2.4-P2.7, RS on P2.0, E low
        JNB RSF,NOTDATA
        ORL A,#01H
NOTDATA: MOV P2,A
        SETB P2.1          ; pulse E; the LCD latches on the falling edge
        NOP
        CLR P2.1
        RET
PRINT:  CLR A
        MOVC A,@A+DPTR
        JZ DONE
        ACALL DAT
        INC DPTR
        SJMP PRINT
DONE:   RET
DELAY:  MOV R7,#100        ; about 200 us at 12 MHz
        DJNZ R7,$
        RET
LINE1:  DB "Hello, Microsim",0
LINE2:  DB "8051 + LCD",0
        END
`;

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

EXAMPLES.push({
  name: "555 LED blinker",
  build(doc) {
    const supply = doc.addPart("vcc", -300, -180, { value: "5" });
    const timer = doc.addPart("ne555", 0, 0);
    const r1 = doc.addPart("resistor", 180, -160, { value: "1k" });
    const r2 = doc.addPart("resistor", 180, -60, { value: "10k" });
    const timing = doc.addPart("electrolytic", -180, 120, { value: "10u" });
    const bypass = doc.addPart("capacitor", -180, 220, { value: "10n" });
    const series = doc.addPart("resistor", 300, 40, { value: "330" });
    const led = doc.addPart("led-red", 420, 40);
    const ground = doc.addPart("ground", 420, 220);
    const scope = doc.addPart("oscilloscope", 420, -120);
    doc.connectPins(supply, "p", timer, "VCC");
    doc.connectPins(supply, "p", timer, "RESET");
    doc.connectPins(supply, "p", r1, "1");
    doc.connectPins(r1, "2", timer, "DISCH");
    doc.connectPins(timer, "DISCH", r2, "1");
    doc.connectPins(r2, "2", timer, "THRESH");
    doc.connectPins(timer, "THRESH", timer, "TRIG");
    doc.connectPins(timer, "TRIG", timing, "1");
    doc.connectPins(timing, "2", ground, "g");
    doc.connectPins(timer, "GND", ground, "g");
    doc.connectPins(timer, "CTRL", bypass, "1");
    doc.connectPins(bypass, "2", ground, "g");
    doc.connectPins(timer, "OUT", series, "1");
    doc.connectPins(series, "2", led, "A");
    doc.connectPins(led, "K", ground, "g");
    doc.connectPins(timer, "OUT", scope, "A");
    doc.connectPins(timer, "TRIG", scope, "B");
    doc.connectPins(scope, "G", ground, "g");
    doc.schematic.texts.push({ id: "555-timing", x: -200, y: 300, text: "Original NE555: about 6.86 Hz, 52% duty. Timing capacitor charges between 1/3 and 2/3 supply." });
  },
}, {
  name: "7805 regulated supply",
  build(doc) {
    const input = doc.addPart("vdc", -220, 0, { value: "12" });
    const regulator = doc.addPart("7805", 0, -30);
    const capacitor = doc.addPart("electrolytic", 180, 70, { value: "10u" });
    const load = doc.addPart("resistor", 300, 70, { value: "100" });
    const ground = doc.addPart("ground", -220, 200);
    const meter = doc.addPart("multimeter", 420, -70);
    doc.connectPins(input, "p", regulator, "IN");
    doc.connectPins(input, "n", ground, "g");
    doc.connectPins(regulator, "GND", ground, "g");
    doc.connectPins(regulator, "OUT", capacitor, "1");
    doc.connectPins(capacitor, "2", ground, "g");
    doc.connectPins(regulator, "OUT", load, "1");
    doc.connectPins(load, "2", ground, "g");
    doc.connectPins(regulator, "OUT", meter, "p");
    doc.connectPins(meter, "n", ground, "g");
    doc.schematic.texts.push({ id: "7805-load", x: -120, y: 240, text: "12 V in, 5 V out at 50 mA. Model includes 2 V dropout and 1.5 A current limit; no thermal shutdown." });
  },
});
