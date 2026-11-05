import { describe, expect, it } from "vitest";
import { decodeUart, terminalText } from "../../src/core/uart";

/** Builds a sampled 0/5 V waveform for the given bytes at `baud`, with `idle` seconds before each frame. */
function wave(bytes: number[], baud: number, opts: { parity?: "even" | "odd"; badStop?: boolean } = {}) {
  const bit = 1 / baud, levels: number[] = [];
  for (const b of bytes) {
    levels.push(1, 1, 0);
    for (let n = 0; n < 8; n++) levels.push((b >>> n) & 1);
    if (opts.parity) { const ones = b.toString(2).split("1").length - 1; levels.push(opts.parity === "even" ? ones & 1 : (ones & 1) ^ 1); }
    levels.push(opts.badStop ? 0 : 1);
  }
  levels.push(1, 1);
  const time: number[] = [], volts: number[] = [];
  levels.forEach((l, n) => { for (let k = 0; k < 10; k++) { time.push((n + k / 10) * bit); volts.push(l * 5); } });
  return { time, volts };
}

describe("UART decoding", () => {
  it("decodes 8N1 text at 9600 baud", () => {
    const { time, volts } = wave([...Buffer.from("Hi!\r\n")], 9600);
    const { bytes } = decodeUart(time, volts, { baud: 9600, threshold: 2.5 });
    expect(terminalText(bytes)).toBe("Hi!\n");
    expect(bytes.every((b) => !b.error)).toBe(true);
  });
  it("checks parity and stop bits", () => {
    const good = wave([0x41, 0x43], 1200, { parity: "even" });
    expect(decodeUart(good.time, good.volts, { baud: 1200, threshold: 2.5, parity: "even" }).bytes.map((b) => b.error)).toEqual([undefined, undefined]);
    expect(decodeUart(good.time, good.volts, { baud: 1200, threshold: 2.5, parity: "odd" }).bytes.every((b) => b.error === "parity")).toBe(true);
    const bad = wave([0x55], 1200, { badStop: true });
    expect(decodeUart(bad.time, bad.volts, { baud: 1200, threshold: 2.5 }).bytes[0].error).toBe("framing");
  });
  it("resumes incrementally without repeating or losing bytes", () => {
    const { time, volts } = wave([...Buffer.from("abcdef")], 9600);
    let after = -Infinity, text = "";
    for (const cut of [300, 450, 700, time.length]) {
      const r = decodeUart(time.slice(0, cut), volts.slice(0, cut), { baud: 9600, threshold: 2.5 }, after);
      text += terminalText(r.bytes); after = r.resume;
    }
    expect(text).toBe("abcdef");
  });
});

import { EXAMPLES, buildExample } from "../../src/core/examples";
import { buildNetlist } from "../../src/core/netlist";
import { simulate } from "../../src/engine";

describe("8051 serial example", () => {
  it("prints text that the serial terminal decodes", () => {
    const schematic = buildExample(EXAMPLES.find((e) => e.name === "8051 serial hello")!);
    const netlist = buildNetlist(schematic);
    expect(netlist.errors ?? []).toEqual([]);
    const terminal = schematic.components.find((c) => c.kind === "serial-terminal")!;
    const net = netlist.pinNets.get(terminal.id)!.get("RX")!;
    const data = simulate(netlist.text, { type: "tran", tstep: 2e-6, tstop: 22e-3, tmax: 5e-6 });
    const v = data.vectors.find((x) => x.name.toLowerCase() === `v(${net})`.toLowerCase())!;
    const text = terminalText(decodeUart(data.axis!.re, v.re, { baud: 9600, threshold: 2.5 }).bytes);
    expect(text).toContain("Hello from 8051\n");
  });
});

describe("UART gaps", () => {
  it("reports lost samples and resynchronizes on an idle line", () => {
    const { time, volts } = wave([...Buffer.from("abcdefgh")], 9600);
    const first = decodeUart(time.slice(0, 250), volts.slice(0, 250), { baud: 9600, threshold: 2.5 });
    // Skip into the middle of a later frame.
    const later = decodeUart(time.slice(520), volts.slice(520), { baud: 9600, threshold: 2.5 }, first.resume);
    expect(later.gap).toBe(true);
    expect(terminalText(later.bytes).endsWith("gh")).toBe(true);
    expect(later.bytes.every((b) => !b.error)).toBe(true);
  });
});

describe("terminal line endings", () => {
  const bytes = (values: number[]) => values.map((value) => ({ time: 0, value }));
  it("starts one line for CR, LF or CR LF, even when CR LF is split between calls", () => {
    expect(terminalText(bytes([65, 13, 66, 10, 67, 13, 10, 68]))).toBe("A\nB\nC\nD");
    const state = { afterCr: false };
    expect(terminalText(bytes([65, 13]), state) + terminalText(bytes([10, 66]), state)).toBe("A\nB");
  });
});
