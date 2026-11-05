import { describe, expect, it } from "vitest";
import { createLiveSession } from "../../src/engine";
import { assemble51 } from "../../src/engine/asm51";
import { decodeUart, terminalText } from "../../src/core/uart";

/** Runs a live session to `until`, collecting one vector. */
function collect(session: ReturnType<typeof createLiveSession>, name: string, until: number, time: number[], volts: number[]) {
  const index = session.names.map((n) => n.toLowerCase()).indexOf(name);
  while (session.time < until * (1 - 1e-9)) {
    const chunk = session.advance(until, 1e9);
    time.push(...chunk.time);
    volts.push(...chunk.values[index]);
  }
}

describe("typing into a live serial input", () => {
  it("sends queued bytes as 8N1 frames that decode back, idle high in between", () => {
    const session = createLiveSession("* serial in\naIN line UART_IN\n.model UART_IN d_uart_tx(baud=9600)\nR1 line 0 100k\n.end", { tmax: 5e-6 });
    const time: number[] = [], volts: number[] = [];
    collect(session, "v(line)", 1e-3, time, volts);
    expect(Math.min(...volts.slice(1))).toBeGreaterThan(4);
    expect(session.send("ain", [..."Hi\r"].map((c) => c.charCodeAt(0)))).toBe(true);
    expect(session.send("nobody", [1])).toBe(false);
    collect(session, "v(line)", 6e-3, time, volts);
    const { bytes } = decodeUart(time, volts, { baud: 9600, threshold: 2.5 });
    expect(bytes.map((b) => b.value)).toEqual([72, 105, 13]);
    expect(bytes.every((b) => !b.error)).toBe(true);
    // Frames start close to when the bytes were typed, and run back to back.
    expect(bytes[0].time).toBeGreaterThanOrEqual(1e-3);
    expect(bytes[0].time).toBeLessThan(1.1e-3);
    expect(bytes[1].time - bytes[0].time).toBeCloseTo(10 / 9600, 6);
  });
  it("keeps the queue across a live value change", () => {
    const deck = (r: string) => `* serial in\naIN line UART_IN\n.model UART_IN d_uart_tx(baud=1200 parity=even)\nR1 line 0 ${r}\n.end`;
    const session = createLiveSession(deck("100k"), { tmax: 2e-5 });
    const time: number[] = [], volts: number[] = [];
    collect(session, "v(line)", 1e-4, time, volts);
    session.send("ain", [0x41, 0x42]);
    collect(session, "v(line)", 5e-3, time, volts);
    expect(session.update(deck("200k"))).toBe(true);
    collect(session, "v(line)", 25e-3, time, volts);
    const { bytes } = decodeUart(time, volts, { baud: 1200, threshold: 2.5, parity: "even" });
    expect(terminalText(bytes)).toBe("AB");
  });
  it("feeds an 8051 that echoes what it receives", () => {
    const program = assemble51(`
      MOV TMOD,#20H
      MOV TH1,#0FDH
      MOV TL1,#0FDH
      MOV SCON,#50H      ; mode 1, receiver on
      SETB TR1
WAIT: JNB RI,WAIT
      CLR RI
      MOV A,SBUF
      INC A              ; echo the next character, to show the core did it
      MOV SBUF,A
      JNB TI,$
      CLR TI
      SJMP WAIT`).code;
    const hex = Array.from(program, (b) => b.toString(16).padStart(2, "0")).join("");
    const pins = Array.from({ length: 32 }, (_, i) => `p${i}`).join(" ");
    const session = createLiveSession(`* echo\nA1 [${pins}] 0 cpu\n.model cpu d_mcu8051(program="${hex}" frequency=11.0592Meg)\naIN p24 UART_IN\n.model UART_IN d_uart_tx(baud=9600)\nRout p25 0 100k\n.end`, { tmax: 2e-6 });
    const time: number[] = [], volts: number[] = [];
    collect(session, "v(p25)", 0.5e-3, time, volts);
    session.send("ain", [..."HAL"].map((c) => c.charCodeAt(0)));
    collect(session, "v(p25)", 6e-3, time, volts);
    expect(terminalText(decodeUart(time, volts, { baud: 9600, threshold: 2.5 }).bytes)).toBe("IBM");
  }, 60000);
});

import { EXAMPLES, buildExample } from "../../src/core/examples";
import { buildNetlist } from "../../src/core/netlist";

describe("the serial echo example", () => {
  it("echoes typed text in upper case through the terminal's own TX line, named as the app sends to it", () => {
    const schematic = buildExample(EXAMPLES.find((e) => e.name === "8051 serial echo")!);
    const netlist = buildNetlist(schematic);
    expect(netlist.warnings).toEqual([]);
    const terminal = schematic.components.find((c) => c.instrument === "serial-terminal")!;
    const rx = netlist.pinNets.get(terminal.id)!.get("RX")!;
    const session = createLiveSession(netlist.text, { tmax: 2e-6 });
    const time: number[] = [], volts: number[] = [];
    collect(session, `v(${rx})`.toLowerCase(), 0.5e-3, time, volts);
    expect(session.send(`a${netlist.refs.get(terminal.id)}`, [..."Hi 51!"].map((c) => c.charCodeAt(0)))).toBe(true);
    collect(session, `v(${rx})`.toLowerCase(), 9e-3, time, volts);
    expect(terminalText(decodeUart(time, volts, { baud: 9600, threshold: 2.5 }).bytes)).toBe("HI 51!");
  }, 60000);
});
