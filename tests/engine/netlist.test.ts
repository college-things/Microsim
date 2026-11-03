import { describe, expect, it } from "vitest";
import { SimError } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { compile, diff, evalConst, parseExpr, parseNumber, type Ast } from "../../src/engine/expr";
import { at, op, vec } from "./helpers";

function codeOf(fn: () => unknown): SimError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e;
    throw e;
  }
  throw new Error("expected a SimError");
}

describe("numbers and expressions", () => {
  it("parses engineering suffixes with trailing units", () => {
    const cases: [string, number][] = [
      ["10kOhm", 10e3], ["1uF", 1e-6], ["2.5MEG", 2.5e6], ["3m", 3e-3], ["1f", 1e-15],
      ["4p", 4e-12], ["5n", 5e-9], ["6G", 6e9], ["7T", 7e12], ["1e3", 1e3], ["-2.5e-3", -2.5e-3],
      ["10V", 10], ["1mil", 25.4e-6], [".5u", 0.5e-6], ["1MegOhm", 1e6],
    ];
    for (const [text, value] of cases) {
      expect(parseNumber(text.toLowerCase())).not.toBeNull();
      expect(Math.abs(parseNumber(text)! - value) / Math.abs(value)).toBeLessThan(1e-12);
    }
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("1+2")).toBeNull();
  });

  const none = { ident: (): Ast | null => null };

  it("follows operator precedence", () => {
    const cases: [string, number][] = [
      ["1+2*3", 7], ["(1+2)*3", 9], ["-2^2", -4], ["2^3^2", 512], ["10/4", 2.5],
      ["1k+1", 1001], ["2*(3+4)/7", 2], ["sqrt(16)+abs(-1)", 5], ["max(1,5,3)", 5], ["min(4,2)", 2],
      ["log(1000)", 3], ["ln(exp(2))", 2], ["if(1>0,10,20)", 10], ["if(1<0,10,20)", 20],
      ["u(1)+u(-1)", 1], ["1<2", 1], ["2**3", 8], ["1?5:6", 5], ["pi", Math.PI],
    ];
    for (const [text, value] of cases) {
      expect(Math.abs(evalConst(parseExpr(text, none)) - value)).toBeLessThan(1e-12);
    }
  });

  it("rejects malformed expressions", () => {
    expect(() => parseExpr("1+", none)).toThrow();
    expect(() => parseExpr("(1", none)).toThrow();
    expect(() => parseExpr("nosuch+1", none)).toThrow(/nosuch/);
    expect(() => parseExpr("nosuch(1)", none)).toThrow(/nosuch/);
    expect(() => parseExpr("sin(1,2)", none)).toThrow(/arguments/);
  });

  it("differentiates symbolically in agreement with finite differences", () => {
    const vars = { ident: (n: string): Ast | null => (n === "x" ? { k: "v", i: 0 } : n === "y" ? { k: "v", i: 1 } : null) };
    const exprs = [
      "x^3", "x*y", "x/y", "sin(x)*cos(y)", "exp(x*y)", "ln(x+3)", "log(x+3)", "sqrt(x+3)", "tanh(x)",
      "atan(x)", "abs(x-5)", "max(x,y)", "min(x,y)", "if(x>0,x^2,y)", "x^y", "2^x", "asin(x/10)", "tan(x)", "uramp(x)",
      "sinh(x)", "cosh(x)", "atan2(x,y)", "acos(x/10)",
    ];
    const point = new Float64Array([0.7, 1.3]);
    for (const text of exprs) {
      const ast = parseExpr(text, vars);
      const f = compile(ast);
      for (let i = 0; i < 2; i++) {
        const d = compile(diff(ast, i))(point);
        const h = 1e-6;
        const up = new Float64Array(point);
        up[i]! += h;
        const dn = new Float64Array(point);
        dn[i]! -= h;
        const numeric = (f(up) - f(dn)) / (2 * h);
        expect(Math.abs(d - numeric)).toBeLessThan(1e-6 * (1 + Math.abs(numeric)));
      }
    }
  });
});

describe("netlist syntax", () => {
  it("handles title, comments, continuation, case and gnd", () => {
    const r = simulate(`V1 this is the title, not a source
* a full-line comment
VIN IN GND 10 ; inline comment
r1 in OUT
+ 1K $ dollar comment
R2 Out 0
* comment inside a continuation
+ 1kOhm
.END
R3 this is after the end and must be ignored
`, { type: "op" });
    expect(Math.abs(op(r, "v(out)") - 5)).toBeLessThan(1e-6);
    expect(r.vectors.map((v) => v.name)).toEqual(["v(in)", "v(out)", "i(vin)"]);
    expect(r.warnings).toEqual([]);
  });

  it("handles CRLF line endings and blank lines", () => {
    const r = simulate("t\r\n\r\nV1 a 0 1\r\n\r\nR1 a 0 1k\r\n", { type: "op" });
    expect(Math.abs(op(r, "v(a)") - 1)).toBeLessThan(1e-9);
  });

  it("evaluates .param, {expr}, <expr>, and quoted expressions", () => {
    const r = simulate(`params
.param vs=2 rtop = {1k*2}
.param rbot='rtop/2' extra={vs+1}
V1 a 0 {vs*extra/2}
R1 a b {rtop}
R2 b 0 <rbot*(1+1)-1k>
`, { type: "op" });
    // vs*extra/2 = 3, R1 = 2k, R2 = 1k.
    expect(Math.abs(op(r, "v(a)") - 3)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(b)") - 1)).toBeLessThan(1e-6);
  });

  it("resolves forward parameter references and reports cycles", () => {
    const r = simulate("t\n.param a={b*2}\n.param b=3\nV1 x 0 {a}\nR1 x 0 1\n", { type: "op" });
    expect(Math.abs(op(r, "v(x)") - 6)).toBeLessThan(1e-9);
    const e = codeOf(() => simulate("t\n.param a={b}\n.param b={a}\nV1 x 0 {a}\nR1 x 0 1\n", { type: "op" }));
    expect(e.code).toBe("parse");
    expect(e.message).toMatch(/depends on itself/);
  });

  it("accepts .options, ignoring unknown ones, and honours known ones", () => {
    const r = simulate("t\n.options reltol=1e-4 gmin=1e-13 nosuch=5 method=gear\nV1 a 0 1\nR1 a 0 1\n", { type: "op" });
    expect(Math.abs(op(r, "v(a)") - 1)).toBeLessThan(1e-9);
    expect(r.warnings).toEqual([]);
  });

  it("uses .nodeset as a guess without changing the solution", () => {
    const r = simulate("t\n.nodeset v(b)=0.5\nV1 a 0 1\nR1 a b 1k\nR2 b 0 1k\n", { type: "op" });
    expect(Math.abs(op(r, "v(b)") - 0.5)).toBeLessThan(1e-6);
  });

  it("reports parse errors with the line number", () => {
    const missing = codeOf(() => simulate("t\nV1 a 0 1\nR1 a\n", { type: "op" }));
    expect(missing.code).toBe("parse");
    expect(missing.line).toBe(3);
    expect(missing.message).toMatch(/Line 3/);

    const badValue = codeOf(() => simulate("t\nV1 a 0 1\n\nR1 a 0 nonsense\n", { type: "op" }));
    expect(badValue.code).toBe("parse");
    expect(badValue.line).toBe(4);

    const badExpr = codeOf(() => simulate("t\nV1 a 0 {1+}\nR1 a 0 1\n", { type: "op" }));
    expect(badExpr.code).toBe("parse");
    expect(badExpr.line).toBe(2);

    expect(codeOf(() => simulate("t\nV1 a 0 PULSE(1)\nR1 a 0 1\n", { type: "op" })).code).toBe("parse");
    expect(codeOf(() => simulate("t\nV1 a 0 PWL(0 1 1)\nR1 a 0 1\n", { type: "op" })).code).toBe("parse");
    expect(codeOf(() => simulate("t\n.ends\n", { type: "op" })).code).toBe("parse");
    expect(codeOf(() => simulate("t\n.subckt a b\nR1 b 0 1\n", { type: "op" })).code).toBe("parse");
    expect(codeOf(() => simulate("t\nV1 a 0 1\nV1 b 0 1\n", { type: "op" })).message).toMatch(/Duplicate/);
    expect(codeOf(() => simulate("t\nK1 L1 L2 0.5\nL1 a 0 1\nL2 a 0 1\nR1 a 0 1\nK2 L1 L2 2\n", { type: "op" })).code).toBe("parse");
    expect(codeOf(() => simulate("t\nF1 a 0 V9 2\nR1 a 0 1\n", { type: "op" })).message).toMatch(/v9/);
  });

  it("warns about unsupported lines by name and solves the rest", () => {
    const r = simulate(`mixed signal
V1 a 0 1
R1 a 0 1k
a1 [a] [dout] cpu1
.model cpu1 d_cpu(cpu_part_id="x")
Y1 a 0 b 0 Z0=50 TD=1n
.lib nosuch.lib
.backup
`, { type: "op" });
    const w = r.warnings.join("\n");
    expect(w).toMatch(/Line 4: unsupported device ignored: a1/);
    expect(w).toMatch(/Line 6: unsupported device ignored: y1/);
    expect(w).toMatch(/Line 7: unsupported directive/);
    expect(w).toMatch(/Line 8: unsupported directive/);
    expect(Math.abs(op(r, "v(a)") - 1)).toBeLessThan(1e-9);
  });

  it("warns about an unsupported source function and uses the DC value", () => {
    const r = simulate("t\nV1 a 0 DC 2 TRNOISE(0 1 1k 5 100)\nR1 a 0 1\n", { type: "op" });
    expect(r.warnings.join()).toMatch(/Line 2.*trnoise/);
    expect(Math.abs(op(r, "v(a)") - 2)).toBeLessThan(1e-9);
  });

  it("tolerates duplicate models, using the later definition", () => {
    const r = simulate(`dup
V1 a 0 5
R1 a d 1k
D1 d 0 dm
.model dm D(IS=1)
.model dm D(IS=1e-14)
`, { type: "op" });
    expect(r.warnings.join()).toMatch(/duplicate .model 'dm'/);
    expect(op(r, "v(d)")).toBeGreaterThan(0.5);
  });

  it("warns at most once per model about unknown parameters", () => {
    const r = simulate(`vendor
V1 a 0 5
R1 a d 1k
D1 d 0 dm
D2 d 0 dm
D3 d 0 dm
.model dm D IS=1e-14 NOPE=1 NADA=2 ALSO=3 mfg=acme tnom=25
.model unused D WHAT=2
`, { type: "op" });
    const notes = r.warnings.filter((w) => /dm/.test(w));
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/nope, nada, also/);
    expect(notes[0]).not.toMatch(/mfg|tnom/);
    expect(r.warnings.join()).not.toMatch(/unused/);
  });

  it("gives a clear error for an unknown model", () => {
    const e = codeOf(() => simulate("t\nV1 a 0 1\nD1 a 0 nosuch\n", { type: "op" }));
    expect(e.code).toBe("parse");
    expect(e.message).toMatch(/Unknown model 'nosuch'/);
    expect(e.line).toBe(3);
  });

  it("rejects a model of the wrong type", () => {
    const e = codeOf(() => simulate("t\nV1 a 0 1\nD1 a 0 m1\n.model m1 NPN\n", { type: "op" }));
    expect(e.message).toMatch(/type 'npn'/);
  });

  it("accepts .model without parentheses and with commas", () => {
    const r = simulate("t\nV1 a 0 5\nR1 a d 1k\nD1 d 0 dm\n.model dm D IS=1e-14, N=1\n", { type: "op" });
    expect(r.warnings).toEqual([]);
    expect(op(r, "v(d)")).toBeGreaterThan(0.5);
  });
});

describe("subcircuits", () => {
  it("expands instances with parameter defaults and overrides", () => {
    const r = simulate(`subckt params
.subckt div in out params: rtop=1k rbot={rtop}
R1 in out {rtop}
R2 out 0 {rbot}
.ends div
V1 a 0 3
X1 a b div
X2 a c div params: rtop=2k rbot=1k
X3 a d div rbot=2k
`, { type: "op" });
    expect(Math.abs(op(r, "v(b)") - 1.5)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(c)") - 1)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(d)") - 2)).toBeLessThan(1e-6);
  });

  it("nests, scopes internal nodes, and lists them after top-level nodes", () => {
    const r = simulate(`nested
.subckt leaf in out
.param half=500
R1 in mid {half}
R2 mid out {half}
.ends
.subckt pair a b
X1 a m leaf
X2 m b leaf
.ends
V1 t 0 1
X1 t u pair
R9 u 0 2k
`, { type: "op" });
    const names = r.vectors.map((v) => v.name);
    expect(names.slice(0, 2)).toEqual(["v(t)", "v(u)"]);
    expect(names).toContain("v(x1.m)");
    expect(names).toContain("v(x1.x1.mid)");
    expect(names).toContain("v(x1.x2.mid)");
    expect(names.indexOf("v(x1.m)")).toBeGreaterThan(names.indexOf("v(u)"));
    expect(names[names.length - 1]).toBe("i(v1)");
    expect(Math.abs(op(r, "v(u)") - 0.5)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(x1.m)") - 0.75)).toBeLessThan(1e-6);
    expect(Math.abs(op(r, "v(x1.x2.mid)") - 0.625)).toBeLessThan(1e-6);
  });

  it("resolves subcircuit-local definitions lexically", () => {
    const r = simulate(`scoped
.param k=7
.subckt outer p
.subckt inner p
R1 p 0 {k}
.ends
.model dm D(IS=1e-14)
X1 p inner
D1 p 0 dm
.ends
I1 0 n 1m
X1 n outer
`, { type: "op" });
    expect(op(r, "v(n)")).toBeGreaterThan(0);
    expect(() => simulate("t\n.subckt s a\n.model dm D\n.ends\nV1 x 0 1\nD1 x 0 dm\n", { type: "op" })).toThrowError(/Unknown model/);
  });

  it("reports wrong port counts and unknown subcircuits", () => {
    expect(codeOf(() => simulate("t\n.subckt s a b\nR1 a b 1\n.ends\nX1 n s\n", { type: "op" })).message).toMatch(/connects 1 nodes/);
    expect(codeOf(() => simulate("t\nX1 n nosuch\n", { type: "op" })).message).toMatch(/Unknown subcircuit/);
    expect(codeOf(() => simulate("t\n.subckt s a\nX1 a s\n.ends\nX1 n s\nR1 n 0 1\n", { type: "op" })).message).toMatch(/instantiates itself/);
  });

  it("handles sources, controlled sources, inductors and K inside instances", () => {
    const r = simulate(`inside
.subckt xf p s
L1 p 0 1m
L2 s 0 1m
K1 L1 L2 0.9
.ends
.subckt buf i o gain=2
Vs i m 0
E1 x 0 m 0 {gain}
R1 x o 1
F1 0 m Vs 0
.ends
V1 in 0 AC 1
X1 in out xf
R1 out 0 1k
V2 d 0 1.5
Rd d 0 1
Xb d o2 buf gain=3
R2 o2 0 1meg
`, { type: "ac", sweep: "lin", points: 1, fstart: 10e3, fstop: 10e3 });
    expect(vec(r, "v(out)").im).toBeDefined();
    expect(r.vectors.map((v) => v.name)).toContain("i(x1.l1)");
    expect(r.vectors.map((v) => v.name)).toContain("i(xb.vs)");
    const d = simulate(`inside dc
.subckt buf i o gain=2
Vs i m 0
E1 x 0 m 0 {gain}
R1 x o 1
.ends
V2 d 0 1.5
Rd d m 1
Rm m 0 1k
Xb d o2 buf gain=3
R2 o2 0 1meg
`, { type: "op" });
    expect(Math.abs(op(d, "v(o2)") - 4.5)).toBeLessThan(1e-4);
  });
});

describe("runtime options", () => {
  const n = "t\nV1 a 0 PULSE(0 1 0 1u 1u 1 2)\nR1 a b 1k\nC1 b 0 1u\n";

  it("reports progress up to 1", () => {
    const seen: number[] = [];
    simulate(n, { type: "tran", tstep: 1e-5, tstop: 1e-3 }, { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it("returns partial data on cancellation without throwing", () => {
    let calls = 0;
    const r = simulate(n, { type: "tran", tstep: 1e-5, tstop: 1e-3 }, { shouldStop: () => ++calls > 10 });
    expect(r.axis!.re.length).toBeLessThan(20);
    expect(r.axis!.re.length).toBeGreaterThan(0);
    expect(r.warnings.join()).toMatch(/partial/);
    expect(vec(r, "v(b)").re.length).toBe(r.axis!.re.length);

    calls = 0;
    const dc = simulate("t\nV1 a 0 1\nR1 a 0 1\n", { type: "dc", source: "v1", start: 0, stop: 100, step: 1 }, { shouldStop: () => ++calls > 3 });
    expect(dc.axis!.re.length).toBeLessThanOrEqual(3);
    calls = 0;
    const ac = simulate("t\nV1 a 0 AC 1\nR1 a 0 1\n", { type: "ac", sweep: "lin", points: 100, fstart: 1, fstop: 100 }, { shouldStop: () => ++calls > 3 });
    expect(ac.axis!.re.length).toBeLessThanOrEqual(3);
  });

  it("fills statistics", () => {
    const r = simulate(n, { type: "tran", tstep: 1e-5, tstop: 1e-3 });
    expect(r.stats.unknowns).toBe(3);
    expect(r.stats.steps).toBeGreaterThanOrEqual(100);
    expect(r.stats.iterations).toBeGreaterThanOrEqual(r.stats.steps);
    expect(r.stats.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Math.abs(at(r, "v(b)", 1e-3) - (1 - Math.exp(-1)))).toBeLessThan(2e-3);
  });

  it("rejects invalid analysis requests", () => {
    const circuit = "t\nV1 a 0 1\nR1 a 0 1\n";
    expect(codeOf(() => simulate(circuit, { type: "tran", tstep: 0, tstop: 1 })).code).toBe("parse");
    expect(codeOf(() => simulate(circuit, { type: "dc", source: "v1", start: 0, stop: 1, step: 0 })).code).toBe("parse");
    expect(codeOf(() => simulate(circuit, { type: "ac", sweep: "dec", points: 1, fstart: 0, fstop: 1 })).code).toBe("parse");
  });

  it("returns an empty result for a netlist with no devices", () => {
    const r = simulate("just a title\n", { type: "op" });
    expect(r.vectors).toEqual([]);
    expect(r.stats.unknowns).toBe(0);
  });
});
