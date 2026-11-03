import { describe, expect, it } from "vitest";
import { simulate } from "../../src/engine";
import { LU_OK, LU_SINGULAR, SparseLU, SparseMatrix } from "../../src/engine/sparse";
import { at, mag, vec } from "./helpers";

function ladder(nodes: number, source: string): string {
  const out = ["rc ladder", `V1 n0 0 ${source}`];
  for (let i = 1; i <= nodes; i++) {
    out.push(`R${i} n${i - 1} n${i} 1k`);
    out.push(`C${i} n${i} 0 1n`);
  }
  return out.join("\n") + "\n";
}

/** Complementary error function by numerical integration. */
function erfc(x: number): number {
  const steps = 4000;
  const h = x / steps;
  let s = 0;
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) * h;
    s += Math.exp(-u * u) * h;
  }
  return 1 - (2 / Math.sqrt(Math.PI)) * s;
}

describe("sparse LU", () => {
  it("solves a system needing off-diagonal pivots and reuses the ordering", () => {
    const m = new SparseMatrix(3);
    // [0 2 0; 1 0 1; 0 1 1], which has a structural zero on the first diagonal.
    const s12 = m.slot(1, 2);
    const s21 = m.slot(2, 1);
    const s23 = m.slot(2, 3);
    const s32 = m.slot(3, 2);
    const s33 = m.slot(3, 3);
    m.freeze();
    const lu = new SparseLU(m, false);
    const load = (a: number): void => {
      m.re[s12] = 2 * a;
      m.re[s21] = 1;
      m.re[s23] = 1;
      m.re[s32] = a;
      m.re[s33] = 1;
    };
    load(1);
    expect(lu.factor()).toBe(LU_OK);
    const x = new Float64Array(4);
    lu.solve(new Float64Array([0, 4, 5, 3]), x);
    expect(x[2]).toBeCloseTo(2, 12);
    expect(x[3]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(4, 12);
    const before = lu.orderings;
    load(3);
    expect(lu.factor()).toBe(LU_OK);
    expect(lu.orderings).toBe(before);
    lu.solve(new Float64Array([0, 6, 5, 3]), x);
    expect(x[2]).toBeCloseTo(1, 12);
  });

  it("detects a singular matrix and a poor pivot after values change", () => {
    const m = new SparseMatrix(2);
    const a = m.slot(1, 1);
    const b = m.slot(1, 2);
    const c = m.slot(2, 1);
    const d = m.slot(2, 2);
    m.freeze();
    const lu = new SparseLU(m, false);
    m.re[a] = 1;
    m.re[b] = 2;
    m.re[c] = 2;
    m.re[d] = 4;
    expect(lu.factor()).toBe(LU_SINGULAR);
    m.re[d] = 5;
    expect(lu.factor()).toBe(LU_OK);
    // Pivot on (1,1) goes to nearly zero; the factorization must reorder.
    m.re[a] = 1e-14;
    expect(lu.factor()).toBe(LU_OK);
    const x = new Float64Array(3);
    lu.solve(new Float64Array([0, 2, 5]), x);
    expect(Math.abs(x[1]! * 2 + x[2]! * 5 - 5)).toBeLessThan(1e-9);
    expect(Math.abs(x[2]! * 2 - 2)).toBeLessThan(1e-9);
  });

  it("factors a complex system", () => {
    const m = new SparseMatrix(2);
    const a = m.slot(1, 1);
    const b = m.slot(1, 2);
    const c = m.slot(2, 1);
    const d = m.slot(2, 2);
    m.freeze();
    m.re[a] = 1;
    m.im[a] = 1;
    m.re[b] = 2;
    m.re[c] = 0;
    m.im[c] = 3;
    m.re[d] = 1;
    m.im[d] = -1;
    const lu = new SparseLU(m, true);
    expect(lu.factor()).toBe(LU_OK);
    const xr = new Float64Array(3);
    const xi = new Float64Array(3);
    // x = (1 + j, 2 - j) gives b1 = (1+j)(1+j) + 2(2-j), b2 = 3j(1+j) + (1-j)(2-j).
    lu.solveComplex(new Float64Array([0, 4, -2]), new Float64Array([0, 0, 0]), xr, xi);
    expect(xr[1]).toBeCloseTo(1, 10);
    expect(xi[1]).toBeCloseTo(1, 10);
    expect(xr[2]).toBeCloseTo(2, 10);
    expect(xi[2]).toBeCloseTo(-1, 10);
  });
});

describe("performance", () => {
  it("runs a 1000-node RC ladder for 1000 steps quickly and accurately", () => {
    const rc = 1e3 * 1e-9;
    const tstop = 1000 * rc;
    const start = performance.now();
    const r = simulate(ladder(1000, "PULSE(0 1 0 1n 1n 1 2)"), { type: "tran", tstep: tstop / 1000, tstop });
    const elapsed = performance.now() - start;
    console.log(
      `ladder 1000 nodes: ${elapsed.toFixed(1)} ms, ${r.stats.steps} steps, ${r.stats.iterations} iterations, ${r.stats.unknowns} unknowns`,
    );
    expect(r.stats.unknowns).toBe(1002);
    expect(r.stats.steps).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(5000);
    // Far from the end, a discrete ladder approaches the semi-infinite diffusion solution.
    for (const k of [10, 20, 40]) {
      const expected = erfc(k / (2 * Math.sqrt(tstop / rc)));
      expect(Math.abs(at(r, `v(n${k})`, tstop) - expected)).toBeLessThan(5e-3);
    }
  });

  it("runs a nonlinear transient at reasonable speed", () => {
    const stages = 50;
    const lines = ["diode ladder", "V1 n0 0 SIN(0 5 1k)"];
    for (let i = 1; i <= stages; i++) {
      lines.push(`R${i} n${i - 1} n${i} 100`);
      lines.push(`D${i} n${i} 0 dm`);
      lines.push(`C${i} n${i} 0 10n`);
    }
    lines.push(".model dm D(IS=1e-14 CJO=1p)");
    const start = performance.now();
    const r = simulate(lines.join("\n") + "\n", { type: "tran", tstep: 2e-6, tstop: 2e-3 });
    const elapsed = performance.now() - start;
    console.log(`diode ladder 50 stages: ${elapsed.toFixed(1)} ms, ${r.stats.steps} steps, ${r.stats.iterations} iterations`);
    expect(elapsed).toBeLessThan(5000);
    expect(at(r, "v(n1)", 0.25e-3)).toBeGreaterThan(0.6);
    expect(at(r, "v(n1)", 0.25e-3)).toBeLessThan(0.8);
  });

  it("sweeps AC on a large ladder reusing the structure", () => {
    const start = performance.now();
    const r = simulate(ladder(1000, "AC 1"), { type: "ac", sweep: "dec", points: 20, fstart: 1e-2, fstop: 1e4 });
    const elapsed = performance.now() - start;
    console.log(`AC ladder 1000 nodes: ${elapsed.toFixed(1)} ms, ${r.stats.steps} points`);
    expect(r.stats.steps).toBe(121);
    expect(elapsed).toBeLessThan(5000);
    const v = vec(r, "v(n1000)");
    expect(mag(v, 0)).toBeGreaterThan(0.1);
    expect(mag(v, 120)).toBeLessThan(1e-6);
  });

  it("handles a dense rail shared by many devices", () => {
    const out = ["rail", "V1 rail 0 5"];
    for (let i = 0; i < 2000; i++) {
      out.push(`R${i}a rail n${i} 1k`);
      out.push(`R${i}b n${i} 0 1k`);
    }
    const start = performance.now();
    const r = simulate(out.join("\n") + "\n", { type: "op" });
    const elapsed = performance.now() - start;
    console.log(`rail with 2000 branches: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(5000);
    expect(Math.abs(vec(r, "v(n1999)").re[0]! - 2.5)).toBeLessThan(1e-6);
  });
});
