import { describe, expect, it } from "vitest";
import { Mcs51 } from "../../src/engine/mcs51";
import { assemble51 } from "../../src/engine/asm51";
import { simulate } from "../../src/engine";
import { decodeUart, terminalText } from "../../src/core/uart";

const run = (source: string, steps: number, readPort?: (port: number) => number) => {
  let cpu!: Mcs51;
  cpu = new Mcs51(assemble51(source).code, readPort ?? (() => 255));
  for (let n = 0; n < steps; n++) cpu.step();
  return cpu;
};

describe("8052 timer 2", () => {
  it("auto-reloads from RCAP2, sets TF2 and takes its interrupt at 2BH", () => {
    const cpu = run(`
        ORG 0
        SJMP START
        ORG 2BH
        INC R5            ; count interrupts
        CLR TF2           ; TF2 is cleared by software
        RETI
START:  MOV RCAP2H,#0FFH
        MOV RCAP2L,#0F0H  ; reload 0FFF0H: overflow every 16 machine cycles
        MOV TH2,#0FFH
        MOV TL2,#0F0H
        SETB ET2
        SETB EA
        SETB TR2
HERE:   SJMP HERE`, 400);
    // About 1 interrupt per 16 cycles once running; SJMP takes 2 cycles per step.
    expect(cpu.ram[5]).toBeGreaterThan(30);
    expect(cpu.ram[5]).toBeLessThan(60);
    expect(cpu.read(0xcd)).toBe(0xff);
    expect(cpu.read(0xcc)).toBeGreaterThanOrEqual(0xf0);
  });
  it("captures TH2:TL2 into RCAP2 on a T2EX falling edge, and sets EXF2", () => {
    let t2ex = 1;
    const cpu = run(`
        MOV T2CON,#09H    ; CP/RL2 = 1 (capture), EXEN2 = 1
        SETB TR2
HERE:   SJMP HERE`, 50, (port) => (port === 1 ? 0xfd | (t2ex << 1) : 255));
    t2ex = 0;
    cpu.step();
    expect(cpu.read(0xc8, true) & 0x40).toBe(0x40);
    const captured = (cpu.read(0xcb) << 8) | cpu.read(0xca);
    expect(captured).toBeGreaterThan(50);
    expect(captured).toBeLessThan(120);
  });
  it("counts falling edges on T2 (P1.0) in counter mode", () => {
    let level = 1;
    let cpu!: Mcs51;
    cpu = new Mcs51(assemble51("MOV T2CON,#06H\nHERE: SJMP HERE").code, (port) => (port === 1 ? 0xfe | level : 255));
    cpu.step();
    for (let n = 0; n < 40; n++) { level = n & 1; cpu.step(); }
    expect((cpu.read(0xcd) << 8) | cpu.read(0xcc)).toBe(20);
  });
  it("generates the serial baud rate with TCLK: 9600 baud at 11.0592 MHz from RCAP2 = 0FFDCH", () => {
    const program = assemble51(`
        MOV SCON,#50H
        MOV RCAP2H,#0FFH
        MOV RCAP2L,#0DCH  ; 65536 - 11059200 / (32 * 9600) = 65500
        MOV TH2,#0FFH
        MOV TL2,#0DCH
        MOV T2CON,#34H    ; RCLK, TCLK, TR2
AGAIN:  MOV DPTR,#MSG
NEXT:   CLR A
        MOVC A,@A+DPTR
        JZ AGAIN
        MOV SBUF,A
        JNB TI,$
        CLR TI
        INC DPTR
        SJMP NEXT
MSG:    DB "T2 ok",0`).code;
    const hex = Array.from(program, (b) => b.toString(16).padStart(2, "0")).join("");
    const pins = Array.from({ length: 32 }, (_, i) => `p${i}`).join(" ");
    const result = simulate(`* t2 baud\nA1 [${pins}] 0 cpu\n.model cpu d_mcu8051(program="${hex}" frequency=11.0592Meg)\nR1 p25 0 100k\n.end`, { type: "tran", tstep: 2e-6, tstop: 8e-3, tmax: 2e-6 });
    const v = result.vectors.find((x) => x.name === "v(p25)")!;
    expect(terminalText(decodeUart(result.axis!.re, v.re, { baud: 9600, threshold: 2.5 }).bytes)).toContain("T2 ok");
  }, 60000);
});
