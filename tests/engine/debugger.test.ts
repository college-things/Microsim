import { describe, expect, it } from "vitest";
import { createLiveSession } from "../../src/engine";
import { assemble51 } from "../../src/engine/asm51";

const source = `
        MOV R0,#0
LOOP:   INC R0
        MOV P1,R0
        NOP
        SJMP LOOP`;

function session(resistor = "100k") {
  const { code, symbols } = assemble51(source);
  const hex = Array.from(code, (b) => b.toString(16).padStart(2, "0")).join("");
  const pins = Array.from({ length: 32 }, (_, i) => `p${i}`).join(" ");
  const deck = (r: string) => `* debug\nA1 [${pins}] 0 cpu\n.model cpu d_mcu8051(program="${hex}" frequency=12Meg)\nR1 p8 0 ${r}\n.end`;
  return { live: createLiveSession(deck(resistor), { tmax: 1e-6 }), loop: symbols.get("LOOP")!, deck };
}

describe("8051 debugger", () => {
  it("stops before a breakpoint, reports registers, and makes no progress until resumed", () => {
    const { live, loop } = session();
    expect(live.debug("a1", { breakpoints: [loop] })).toBe(true);
    expect(live.debug("nobody", { step: true })).toBe(false);
    live.advance(1e-3, 1e9);
    expect(live.halted).toBe("a1");
    const first = live.mcuState("a1")!;
    expect(first.pc).toBe(loop);
    const stopped = live.time;
    expect(live.advance(1e-3, 1e9).time.length).toBe(0);
    expect(live.time).toBe(stopped);
    // Continue: it comes round the loop and stops again, with R0 one higher.
    live.resume();
    live.advance(1e-3, 1e9);
    expect(live.halted).toBe("a1");
    expect(live.mcuState("a1")!.registers[0]).toBe(first.registers[0] + 1);
  });
  it("single-steps one instruction at a time", () => {
    const { live, loop } = session();
    live.debug("a1", { breakpoints: [loop] });
    live.advance(1e-3, 1e9);
    const pcs: number[] = [];
    live.debug("a1", { breakpoints: [] });
    for (let i = 0; i < 4; i++) {
      live.debug("a1", { step: true });
      live.resume();
      live.advance(1e-3, 1e9);
      expect(live.halted).toBe("a1");
      pcs.push(live.mcuState("a1")!.pc);
    }
    // INC R0 (1 byte), MOV P1,R0 (2), NOP (1), SJMP LOOP back to the loop.
    expect(pcs).toEqual([loop + 1, loop + 3, loop + 4, loop]);
  });
  it("keeps breakpoints through a live value change", () => {
    const { live, loop, deck } = session();
    live.debug("a1", { breakpoints: [loop] });
    live.advance(1e-3, 1e9);
    expect(live.update(deck("200k"))).toBe(true);
    expect(live.halted).toBe("a1");
    live.resume();
    live.advance(1e-3, 1e9);
    expect(live.halted).toBe("a1");
    expect(live.mcuState("a1")!.pc).toBe(loop);
  });
});
