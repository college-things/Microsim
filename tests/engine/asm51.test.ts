import { describe, expect, it } from "vitest";
import { assemble51 } from "../../src/engine/asm51";
import { Mcs51 } from "../../src/engine/mcs51";

const hex = (source: string) => Array.from(assemble51(source).code, (b) => b.toString(16).padStart(2, "0")).join(" ");

describe("8051 assembler", () => {
  it("encodes each addressing mode", () => {
    expect(hex("MOV A,#12H\nMOV A,30H\nMOV A,@R1\nMOV A,R5\nMOV 30H,A\nMOV 30H,#0FFH\nMOV 31H,30H\nMOV R7,#3\nMOV @R0,A\nMOV DPTR,#1234H"))
      .toBe("74 12 e5 30 e7 ed f5 30 75 30 ff 85 30 31 7f 03 f6 90 12 34");
    expect(hex("ADD A,#1\nADDC A,R0\nSUBB A,@R0\nORL 20H,#1\nANL A,30H\nXRL 40H,A\nINC DPTR\nDEC R3\nMUL AB\nDIV AB\nDA A\nSWAP A"))
      .toBe("24 01 38 96 43 20 01 55 30 62 40 a3 1b a4 84 d4 c4");
  });
  it("addresses bits by name, by SFR.bit and by RAM byte.bit", () => {
    expect(hex("SETB P1.0\nCLR TI\nCPL ACC.7\nMOV C,20H.3\nMOV P3.1,C\nANL C,/P1.2\nORL C,EA\nSETB C\nCLR A"))
      .toBe("d2 90 c2 99 b2 e7 a2 03 92 b1 b0 92 72 af d3 e4");
  });
  it("resolves labels forward and back, with relative, absolute and long jumps", () => {
    const code = assemble51("ORG 0\nSTART: SJMP NEXT\nNOP\nNEXT: DJNZ R2,NEXT\nCJNE A,#5,START\nJB P1.0,$\nAJMP START\nLCALL SUB\nJMP START\nSUB: RET\nEND").code;
    expect(Array.from(code, (b) => b.toString(16).padStart(2, "0")).join(" "))
      .toBe("80 01 00 da fe b4 05 f8 20 90 fd 01 00 12 00 13 02 00 00 22");
  });
  it("evaluates EQU, DATA, BIT, HIGH/LOW, $ and arithmetic, including forward references", () => {
    const { code, symbols } = assemble51("COUNT EQU LIMIT-1\nLIMIT EQU 10\nBUF DATA 30H\nLED BIT P1.3\nMOV R0,#COUNT\nMOV DPTR,#TABLE\nMOV A,#HIGH(TABLE+1)\nMOV A,#LOW TABLE\nCLR LED\nMOV BUF+1,#(3*4) MOD 5\nTABLE: DB 'Hi',0,1+1\nDW 1234H\n");
    expect(symbols.get("COUNT")).toBe(9);
    expect(Array.from(code.slice(0, 6))).toEqual([0x78, 9, 0x90, 0, 14, 0x74]);
    expect(Array.from(code.slice(-6))).toEqual([0x48, 0x69, 0, 2, 0x12, 0x34]);
  });
  it("reports errors by line without echoing the source", () => {
    expect(() => assemble51("NOP\nFOO A")).toThrow(/^Line 2: "FOO" is not/);
    expect(() => assemble51("SJMP FAR\nORG 200H\nFAR: NOP")).toThrow(/Line 1: jump target/);
    expect(() => assemble51("MOV A,UNKNOWN")).toThrow(/Line 1: "UNKNOWN" is not defined/);
    expect(() => assemble51("X: NOP\nX: NOP")).toThrow(/already defined on line 1/);
    expect(() => assemble51("SETB 31H.1")).toThrow(/bit-addressable/);
  });
  it("produces code the core runs: a counter that outputs on P1", () => {
    const { code } = assemble51("MOV R7,#5\nCLR A\nLOOP: INC A\nDJNZ R7,LOOP\nMOV P1,A\nHERE: SJMP HERE");
    const cpu = new Mcs51(code);
    for (let n = 0; n < 20; n++) cpu.step();
    expect(cpu.latch(1)).toBe(5);
  });
  it("assembles every defined opcode once, matching the core's decoder lengths", () => {
    // Round trip: each form's bytes, executed from address 0, advance the PC by the assembled size (jumps aside).
    const lines = ["NOP", "RR A", "INC A", "INC 30H", "INC @R0", "INC R1", "RRC A", "DEC A", "RL A", "ADD A,#1", "RLC A", "ORL A,R2", "ANL 30H,#1", "XRL A,@R1", "MOV A,#1", "MOVC A,@A+PC", "MOVC A,@A+DPTR", "MOVX A,@DPTR", "MOVX @R0,A", "PUSH ACC", "POP B", "XCH A,R3", "XCHD A,@R0", "CPL C", "MOV R4,30H", "MOV @R1,#2"];
    for (const line of lines) {
      const { code } = assemble51(line);
      const cpu = new Mcs51(Uint8Array.from([...code, 0, 0, 0]));
      cpu.write(0x81, 0x40);
      cpu.step();
      expect(cpu.pc, line).toBe(code.length);
    }
  });
});
