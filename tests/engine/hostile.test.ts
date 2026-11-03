import { describe, expect, it } from "vitest";
import { SimError, type AnalysisRequest } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { op } from "./helpers";

const OP: AnalysisRequest = { type: "op" };
const BUDGET_MS = 5000;

/** The run must end with a SimError, quickly. Returns the error. */
function fails(netlist: string, request: AnalysisRequest = OP): SimError {
  const start = Date.now();
  let error: unknown;
  try {
    simulate(netlist, request);
  } catch (e) {
    error = e;
  }
  expect(Date.now() - start).toBeLessThan(BUDGET_MS);
  expect(error).toBeInstanceOf(SimError);
  return error as SimError;
}

describe("strict SPICE suffixes", () => {
  it("reads M as milli and MEG as mega on an X line, the same as in .param", () => {
    const body = "t\n.subckt s a b r=1\nR1 a b {r}\n.ends\nI1 0 n 1m\n";
    const milli = simulate(`${body}X1 n 0 s PARAMS: R=100M\n`, OP);
    expect(op(milli, "v(n)")).toBeCloseTo(100e-3 * 1e-3, 10);
    const mega = simulate(`${body}X1 n 0 s PARAMS: R=100MEG\n`, OP);
    expect(op(mega, "v(n)") / 1e5).toBeCloseTo(1, 3);
    const param = simulate(`${body}.param rr=100M\nX1 n 0 s PARAMS: R={rr}\n`, OP);
    expect(op(param, "v(n)")).toBeCloseTo(op(milli, "v(n)"), 12);
  });
});

describe("hostile netlists", () => {
  it("handles a 4 MB comment and a 2 MB device line", () => {
    const r = simulate(`t\n* ${"x".repeat(4_000_000)}\nV1 a 0 1\nR1 a 0 1 ${"; ".padEnd(100, "y")}\n`, OP);
    expect(op(r, "v(a)")).toBeCloseTo(1, 6);
    const err = fails(`t\nV1 a 0 1\nR1 a ${"b ".repeat(1_000_000)}\n`);
    expect(err.code).toBe("parse");
  });

  it("parses a .param line with a hundred thousand assignments in linear time", () => {
    const parts: string[] = [];
    for (let i = 0; i < 100_000; i++) parts.push(`p${i}=${i}`);
    const start = Date.now();
    const r = simulate(`t\n.param ${parts.join(" ")}\nV1 a 0 {p99999}\nR1 a 0 1\n`, OP);
    expect(Date.now() - start).toBeLessThan(BUDGET_MS);
    expect(op(r, "v(a)")).toBeCloseTo(99999, 3);
  });

  it("fails on expressions nested too deeply", () => {
    const deep = `${"(".repeat(200_000)}1${")".repeat(200_000)}`;
    expect(fails(`t\nV1 a 0 {${deep}}\nR1 a 0 1\n`).code).toMatch(/parse|unsupported/);
    const long = `1${"+1".repeat(500_000)}`;
    const err = fails(`t\nV1 a 0 1\nR1 a 0 1\nB1 b 0 V=${long}\nR2 b 0 1\n`);
    expect(err.code).toMatch(/parse|unsupported/);
  });

  it("reports a subcircuit calling itself, directly and through another", () => {
    const direct = fails("t\n.subckt s a\nX1 a s\n.ends\nX1 n s\nR1 n 0 1\n");
    expect(direct.code).toBe("parse");
    expect(direct.message).toMatch(/instantiates itself/);
    const mutual = fails("t\n.subckt s a\nX1 a u\n.ends\n.subckt u a\nX1 a s\n.ends\nX1 n s\nR1 n 0 1\n");
    expect(mutual.message).toMatch(/instantiates itself/);
  });

  it("stops subcircuit fan-out that grows exponentially", () => {
    let text = "t\n.subckt s0 a\nR1 a 0 1\n.ends\n";
    for (let i = 1; i <= 40; i++) {
      text += `.subckt s${i} a\nX1 a s${i - 1}\nX2 a s${i - 1}\n.ends\n`;
    }
    text += "X1 n s40\n";
    expect(fails(text).code).toBe("unsupported");
    // The same fan-out with no devices at all, so only the instance count can stop it.
    let empty = "t\n.subckt s0 a\n.ends\n";
    for (let i = 1; i <= 40; i++) {
      empty += `.subckt s${i} a\nX1 a s${i - 1}\nX2 a s${i - 1}\n.ends\n`;
    }
    empty += "X1 n s40\nR1 n 0 1\n";
    expect(fails(empty).code).toBe("unsupported");
  });

  it("reports .func recursion and exponential expansion", () => {
    const self = fails("t\n.func f(x) {f(x)+f(x)}\nV1 a 0 {f(1)}\nR1 a 0 1\n");
    expect(self.message).toMatch(/calls itself/);
    let chain = ".func f0(x) {x}\n";
    for (let i = 1; i <= 40; i++) chain += `.func f${i}(x) {f${i - 1}(x)+f${i - 1}(x)}\n`;
    const big = fails(`t\n${chain}V1 a 0 {f40(1)}\nR1 a 0 1\n`);
    expect(big.message).toMatch(/too large/);
  });

  it("reports a parameter that depends on itself", () => {
    expect(fails("t\n.param a={a+1}\nV1 x 0 {a}\nR1 x 0 1\n").message).toMatch(/depends on itself/);
  });

  it("refuses a PULSE with an absurd number of periods", () => {
    const err = fails("t\nV1 a 0 PULSE(0 1 0 1f 1f 1f 4f)\nR1 a 0 1\n", { type: "tran", tstep: 1e-6, tstop: 1 });
    expect(err.code).toBe("unsupported");
    expect(err.message).toMatch(/corners/);
    expect(fails("t\nV1 a 0 PWL(0 0 1f 1 2f 0) r=0\nR1 a 0 1\n", { type: "tran", tstep: 1e-6, tstop: 1 }).code).toBe("unsupported");
  });

  it("refuses a time step near zero", () => {
    const circuit = "t\nV1 a 0 1\nR1 a 0 1\n";
    expect(fails(circuit, { type: "tran", tstep: 1e-300, tstop: 1 }).message).toMatch(/steps/);
    expect(fails(circuit, { type: "tran", tstep: 1, tstop: 1e300, tmax: 1 }).code).toBe("unsupported");
    expect(fails(circuit, { type: "tran", tstep: 0, tstop: 1 }).code).toBe("parse");
    expect(fails(circuit, { type: "tran", tstep: 1e-6, tstop: Infinity }).code).toBe("parse");
    expect(fails(circuit, { type: "tran", tstep: NaN, tstop: 1 }).code).toBe("parse");
  });

  it("refuses absurd sweeps", () => {
    const circuit = "t\nV1 a 0 AC 1\nR1 a 0 1\n";
    expect(fails(circuit, { type: "ac", sweep: "lin", points: 1e12, fstart: 1, fstop: 2 }).code).toBe("unsupported");
    expect(fails(circuit, { type: "ac", sweep: "dec", points: 1e9, fstart: 1, fstop: 1e9 }).code).toBe("unsupported");
    expect(fails(circuit, { type: "dc", source: "v1", start: 0, stop: 1, step: 1e-300 }).code).toBe("unsupported");
    expect(fails(circuit, { type: "noise", output: "v(a)", source: "v1", sweep: "lin", points: 1e12, fstart: 1, fstop: 2 }).code).toBe("unsupported");
    expect(fails(circuit, { type: "ac", sweep: "lin", points: NaN, fstart: 1, fstop: 2 }).code).toBe("parse");
  });

  it("reports zero-delay digital feedback", () => {
    const err = fails(`t
a1 a b inv
a2 b c inv
a3 c a inv
.model inv d_inverter(rise_delay=0 fall_delay=0)
`, { type: "tran", tstep: 1e-6, tstop: 1e-3 });
    expect(err.code).toBe("convergence");
    expect(err.message).toMatch(/zero-delay/);
  });

  it("does not stall on a huge POLY declaration", () => {
    let text = "t\nV1 a 0 1\nR1 a 0 1\nE1 b 0 POLY(40)";
    for (let i = 0; i < 40; i++) text += " a 0";
    text += " 1 2 3\nR2 b 0 1\n";
    const start = Date.now();
    const r = simulate(text, OP);
    expect(Date.now() - start).toBeLessThan(BUDGET_MS);
    expect(Number.isFinite(op(r, "v(b)"))).toBe(true);
  });

  it("never throws anything but SimError on junk input", () => {
    const junk = [
      "", "\n\n", "t\n(((", "t\n)))", "t\n{", "t\n'", 't\n"', "t\n<", "t\n=====", "t\nR", "t\nR1", "t\nX", "t\n.model", "t\n.subckt",
      "t\n.param", "t\n.param =", "t\n.func", "t\n.ic", "t\n.ic v(", "t\nV1 a 0 PULSE(", "t\nE1 a b VALUE", "t\nB1", "t\nB1 a b",
      "t\nK1 L1", "t\nW1 a b", "t\nS1 a b", "t\nA", "t\na1", "t\na1 [", "t\na1 %vd(", "t\nT1 a 0 b 0", "t\nZ1", "t\n.model m d_chip(behaviour=\"\")\na1 [a] [b] m\n",
      't\n.model m d_chip(behaviour="/table 1000000")\na1 [a] [b] m\n', "t\n.model m s_xfer(den_coeff=[0 0])\na1 x y m\n", "t\nV1 a 0 PWL(1 1 0 0)\n",
    ];
    for (const text of junk) {
      try {
        simulate(text, OP);
      } catch (e) {
        expect(e).toBeInstanceOf(SimError);
      }
    }
  });
});
