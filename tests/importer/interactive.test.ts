// Scripts here are written for the test, in the shape the format uses.
import { describe, expect, it } from "vitest";
import { applyInteractiveState } from "../../src/importer/interactive";
import { normalizeStoredValue } from "../../src/importer/values";

const script = (body: string) => `* !!!BEGIN-INTERACT\n${body}\n* !!!END-INTERACT\n`;

describe("interactive parts", () => {
  it("splits a potentiometer by the shown setting", () => {
    const template = `${script("*  : increment ++++f4 ;\n*  : setresistance ++++f6 ;\n*  50.0 VARIABLE setting\n*  0.0000001 0.9999999 *zeroadj f.min f.max")}x%p %t1 %t2 %t3 Potentiometer%p\n.subckt Potentiometer%p 1 2 3\nR1 1 2  1e-3\nR2 2 3  1e-3\n.ends\n`;
    const result = applyInteractiveState({ template, parameters: ["0", "0", "0", "5", "0", "10k"], display: "25 %", state: 0 });
    expect(result.params).toEqual({ r1: "2500", r2: "7500" });
    expect(result.template).toContain("R1 1 2  {param:r1}");
    expect(result.template).toContain("R2 2 3  {param:r2}");
  });

  it("falls back to the script's starting setting and honours its limits", () => {
    const template = `${script("*  : setresistance ++++f2 ;\n*  50.0 VARIABLE setting\n*  0.1 0.9 *zeroadj f.min f.max")}x%p Potentiometer%p\nR1 1 2 1\nR2 2 3 1\n`;
    expect(applyInteractiveState({ template, parameters: ["0", "100"], state: 0 }).params).toEqual({ r1: "50", r2: "50" });
    expect(applyInteractiveState({ template, parameters: ["0", "100"], display: "100 %", state: 0 }).params).toEqual({ r1: "90", r2: "10" });
  });

  it("keeps an expression value as an expression", () => {
    const template = `${script("*  : setresistance ++++f2 ;")}x%p Potentiometer%p\nR1 1 2 1\nR2 2 3 1\n`;
    const { params } = applyInteractiveState({ template, parameters: ["0", "Rtotal"], display: "50 %", state: 0 });
    expect(params.r1).toBe("{(Rtotal)*0.5}");
  });

  it("handles a variable inductor like a capacitor, though no sample has one", () => {
    const template = `${script("*  : tinductance ++++f2 ;\n*  0.0001 0.999999 *zeroadj f.min f.max")}x%p %t1 %t2 VariableInductor%p\n.subckt VariableInductor%p 1 2\nL1 1 2  50e-12\n.ends\n`;
    const result = applyInteractiveState({ template, parameters: ["0", "1m"], display: "20 %", state: 0 });
    expect(result.params.value).toBe("0.0002");
    expect(result.template).toContain("L1 1 2  {param:value}");
  });

  it("uses the shown voltage of a variable source, or the middle of its range", () => {
    const template = `${script("*  : tmaxvalue ++++f2 ;\n*  : tminvalue ++++f4 ;\n*    value SET_INSTANCE vsource ::V V1 dc")}x%p VariableDCVoltage%p\nV1 1 2  10\n`;
    expect(applyInteractiveState({ template, parameters: ["0", "100", "0", "0"], display: "30V", state: 0 }).params.value).toBe("30");
    expect(applyInteractiveState({ template, parameters: ["0", "100", "0", "0"], state: 0 }).params.value).toBe("50");
  });

  it("drives a switch from its saved state", () => {
    const template = `${script("*  2.0 constant high\n*  0.0 constant low\n*  2 constant max_states\n*  *animation_state max_states low high STATE volt\n*  value SET_INSTANCE Vsource ::V V2 dc")}x%p Switch%p\nV2 5 0 DC 0\n`;
    const on = applyInteractiveState({ template, parameters: [], state: 1 });
    expect(on.template).toMatch(/^V2 5 0 DC \{param:level\}$/m);
    expect(on.params.level).toBe("2");
    expect(applyInteractiveState({ template, parameters: [], state: 0 }).params.level).toBe("0");
  });

  it("leaves unrecognised parts alone", () => {
    const template = `${script("* nothing useful")}x%p Mystery%p\nR1 1 2 5\n`;
    expect(applyInteractiveState({ template, parameters: [], state: 3 }).template).toBe(template);
  });
});

describe("stored values", () => {
  it("reads a capital M as mega and leaves everything else", () => {
    expect(normalizeStoredValue("2M")).toBe("2Meg");
    expect(normalizeStoredValue("1.5M")).toBe("1.5Meg");
    expect(normalizeStoredValue("1e3M")).toBe("1e3Meg");
    expect(normalizeStoredValue("100m")).toBe("100m");
    expect(normalizeStoredValue("10Meg")).toBe("10Meg");
    expect(normalizeStoredValue("10MEG")).toBe("10MEG");
    expect(normalizeStoredValue("Rm")).toBe("Rm");
    expect(normalizeStoredValue("Mass")).toBe("Mass");
    expect(normalizeStoredValue("2Mil")).toBe("2Mil");
    expect(normalizeStoredValue("2MIL")).toBe("2MIL");
    expect(normalizeStoredValue("2MHz")).toBe("2MegHz");
  });
});
