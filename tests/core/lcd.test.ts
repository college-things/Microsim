import { describe, expect, it } from "vitest";
import { CharacterLcd, type LcdSamples } from "../../src/core/lcd";

/** Waveforms for a sequence of bus writes: each sets RS and data, then pulses E high and low. */
function bus(writes: [rs: 0 | 1, value: number][], fourBit: boolean): LcdSamples {
  const time: number[] = [], rs: number[] = [], e: number[] = [], data: number[][] = Array.from({ length: 8 }, () => []);
  let t = 0;
  const sample = (r: number, en: number, value: number) => {
    time.push(t); t += 1e-6; rs.push(r * 5); e.push(en * 5);
    for (let bit = 0; bit < 8; bit++) data[bit].push((value >> bit) & 1 ? 5 : 0);
  };
  const pulse = (r: number, value: number) => { sample(r, 0, value); sample(r, 1, value); sample(r, 1, value); sample(r, 0, value); sample(r, 0, value); };
  for (const [r, value] of writes) {
    if (!fourBit) pulse(r, value);
    else { pulse(r, value & 0xf0); pulse(r, (value << 4) & 0xf0); }
  }
  return { time, rs, e, data: fourBit ? [undefined, undefined, undefined, undefined, ...data.slice(4)] : data };
}
const text = (s: string) => [...s].map((c) => [1, c.charCodeAt(0)] as [1, number]);

describe("character LCD", () => {
  it("shows text written in 8-bit mode on two lines", () => {
    const lcd = new CharacterLcd();
    lcd.feed(bus([[0, 0x38], [0, 0x0c], [0, 0x06], [0, 0x01], ...text("Hello"), [0, 0xc0], ...text("8051!")], false));
    expect(lcd.text()).toEqual(["Hello           ", "8051!           "]);
  });
  it("follows the 4-bit power-up sequence, then two-nibble transfers", () => {
    const lcd = new CharacterLcd();
    // Three 8-bit function sets and the switch to 4-bit, each as a single nibble on D4-D7.
    const start = bus([[0, 0x30], [0, 0x30], [0, 0x30], [0, 0x20]], false);
    start.data = [undefined, undefined, undefined, undefined, ...start.data.slice(4)];
    lcd.feed(start);
    const rest = bus([[0, 0x28], [0, 0x0c], [0, 0x01], ...text("Temp 21"), [0, 0xc3], ...text("OK")], true);
    rest.time = Array.from(rest.time, (t) => t + 1);
    lcd.feed(rest);
    expect(lcd.text()).toEqual(["Temp 21         ", "   OK           "]);
  });
  it("keeps the display blank until it is turned on, and clears", () => {
    const lcd = new CharacterLcd();
    lcd.feed(bus([[0, 0x38], ...text("hidden")], false));
    expect(lcd.text()[0].trim()).toBe("");
    const more = bus([[0, 0x0c], [0, 0x01], ...text("shown")], false);
    more.time = Array.from(more.time, (t) => t + 1);
    lcd.feed(more);
    expect(lcd.text()[0].trim()).toBe("shown");
  });
  it("shifts the display and ignores reads", () => {
    const lcd = new CharacterLcd();
    const writes = bus([[0, 0x38], [0, 0x0c], ...text("ABCDEFGHIJKLMNOPQR"), [0, 0x18]], false);
    lcd.feed(writes);
    expect(lcd.text()[0]).toBe("BCDEFGHIJKLMNOPQ");
    const read = bus([[1, 0x5a]], false);
    read.time = Array.from(read.time, (t) => t + 1);
    read.rw = read.e;
    lcd.feed(read);
    expect(lcd.text()[0]).toBe("BCDEFGHIJKLMNOPQ");
  });
  it("skips samples it has already seen, so overlapping live chunks don't write twice", () => {
    const lcd = new CharacterLcd();
    const all = bus([[0, 0x38], [0, 0x0c], ...text("AB")], false);
    const half = Math.floor(all.time.length / 2);
    const slice = (from: number, to: number): LcdSamples => ({ time: Array.from(all.time).slice(from, to), rs: Array.from(all.rs).slice(from, to), e: Array.from(all.e).slice(from, to), data: all.data.map((d) => d && Array.from(d).slice(from, to)) });
    lcd.feed(slice(0, half + 3));
    lcd.feed(slice(half - 3, all.time.length));
    expect(lcd.text()[0]).toBe("AB              ");
    expect(lcd.writes).toBe(4);
  });
});

import { EXAMPLES, buildExample } from "../../src/core/examples";
import { buildNetlist } from "../../src/core/netlist";
import { createLiveSession } from "../../src/engine";

describe("the 8051 LCD example", () => {
  it("writes both lines through 4-bit mode", () => {
    const schematic = buildExample(EXAMPLES.find((e) => e.name === "8051 LCD hello")!);
    const netlist = buildNetlist(schematic);
    expect(netlist.errors).toEqual([]);
    const lcdPart = schematic.components.find((c) => c.kind === "lcd16x2")!;
    const nets = netlist.pinNets.get(lcdPart.id)!;
    const session = createLiveSession(netlist.text, { tmax: 1e-6 });
    const index = (pin: string) => session.names.map((n) => n.toLowerCase()).indexOf(`v(${nets.get(pin)})`.toLowerCase());
    const lcd = new CharacterLcd();
    while (session.time < 10e-3) {
      const chunk = session.advance(10e-3, 1e9);
      const col = (pin: string) => (nets.get(pin) === "0" ? new Float64Array(chunk.time.length) : nets.get(pin) ? chunk.values[index(pin)] : undefined);
      lcd.feed({ time: chunk.time, rs: col("RS")!, e: col("E")!, rw: col("RW"), data: ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"].map(col) });
    }
    expect(lcd.text()).toEqual(["Hello, Microsim ", "8051 + LCD      "]);
  }, 60000);
});

describe("the keypad example", () => {
  it("shows a held key on the LCD, through a live value change", () => {
    const schematic = buildExample(EXAMPLES.find((e) => e.name === "8051 keypad and LCD")!);
    const keypad = schematic.components.find((c) => c.kind === "keypad4x4")!;
    const lcdPart = schematic.components.find((c) => c.kind === "lcd16x2")!;
    const first = buildNetlist(schematic);
    expect(first.errors).toEqual([]);
    const nets = first.pinNets.get(lcdPart.id)!;
    const session = createLiveSession(first.text, { tmax: 1e-6 });
    const lcd = new CharacterLcd();
    const runTo = (until: number) => {
      while (session.time < until) {
        const chunk = session.advance(until, 1e9);
        const index = (pin: string) => session.names.map((n) => n.toLowerCase()).indexOf(`v(${nets.get(pin)})`.toLowerCase());
        const col = (pin: string) => (nets.get(pin) === "0" ? new Float64Array(chunk.time.length) : nets.get(pin) ? chunk.values[index(pin)] : undefined);
        lcd.feed({ time: chunk.time, rs: col("RS")!, e: col("E")!, rw: col("RW"), data: ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"].map(col) });
      }
    };
    runTo(10e-3);
    expect(lcd.text()).toEqual(["Press a key     ", "Key:            "]);
    keypad.params.pressed = "#";
    expect(session.update(buildNetlist(schematic).text)).toBe(true);
    runTo(14e-3);
    expect(lcd.text()[1]).toBe("Key: #          ");
    keypad.params.pressed = "none";
    expect(session.update(buildNetlist(schematic).text)).toBe(true);
    runTo(16e-3);
    keypad.params.pressed = "7";
    expect(session.update(buildNetlist(schematic).text)).toBe(true);
    runTo(20e-3);
    expect(lcd.text()[1]).toBe("Key: 7          ");
  }, 120000);
});
