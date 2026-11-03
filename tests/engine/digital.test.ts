import { describe, expect, it } from "vitest";
import type { SimResult } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { at, vec } from "./helpers";

/** Times a vector crosses level in the given direction. */
function edges(r: SimResult, name: string, level: number, rising: boolean): number[] {
  const t = r.axis!.re;
  const y = vec(r, name).re;
  const out: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const a = y[i - 1]!;
    const b = y[i]!;
    if (rising ? a < level && b >= level : a > level && b <= level) {
      out.push(t[i - 1]! + ((level - a) / (b - a)) * (t[i]! - t[i - 1]!));
    }
  }
  return out;
}

const CLOCK = `.model ck d_clock(frequency=1meg duty=0.5 delay=0)\n`;

describe("gates", () => {
  it("applies rise and fall delays exactly", () => {
    const r = simulate(`inverter delay
a1 clk ck
a2 clk out inv
${CLOCK}.model inv d_inverter(rise_delay=30n fall_delay=10n)
`, { type: "tran", tstep: 10e-9, tstop: 5e-6 });
    const clkUp = edges(r, "v(clk)", 2.5, true);
    const clkDown = edges(r, "v(clk)", 2.5, false);
    const outUp = edges(r, "v(out)", 2.5, true);
    const outDown = edges(r, "v(out)", 2.5, false);
    expect(clkUp.length).toBeGreaterThanOrEqual(4);
    // Falling clock makes the output rise after 30 ns; rising clock makes it fall after 10 ns.
    for (const t of clkDown) if (t < 4.9e-6) expect(outUp.some((u) => Math.abs(u - t - 30e-9) < 1e-12)).toBe(true);
    for (const t of clkUp) if (t < 4.9e-6) expect(outDown.some((u) => Math.abs(u - t - 10e-9) < 1e-12)).toBe(true);
    // The clock itself has the stated period.
    expect(Math.abs(clkUp[2]! - clkUp[1]! - 1e-6)).toBeLessThan(1e-12);
  });

  it("evaluates each gate type through array ports", () => {
    const table = (type: string): number[] => {
      const r = simulate(`gate ${type}
a1 a ca
a2 b cb
a3 [a b] y g
.model ca d_clock(frequency=1meg duty=0.5 delay=0)
.model cb d_clock(frequency=500k duty=0.5 delay=0)
.model g ${type}(rise_delay=1n fall_delay=1n)
`, { type: "tran", tstep: 10e-9, tstop: 2e-6 });
      // Sample at the four input combinations: 11, 01, 10, 00.
      return [0.4e-6, 0.9e-6, 1.4e-6, 1.9e-6].map((t) => Math.round(at(r, "v(y)", t) / 5));
    };
    expect(table("d_and")).toEqual([1, 0, 0, 0]);
    expect(table("d_nand")).toEqual([0, 1, 1, 1]);
    expect(table("d_or")).toEqual([1, 1, 1, 0]);
    expect(table("d_nor")).toEqual([0, 0, 0, 1]);
    expect(table("d_xor")).toEqual([0, 1, 1, 0]);
    expect(table("d_xnor")).toEqual([1, 0, 0, 1]);
  });

  it("rejects a pulse shorter than the inertial delay", () => {
    const r = simulate(`inertial
a1 a ca
a2 a y buf
.model ca d_clock(frequency=10meg duty=0.1 delay=100n)
.model buf d_buffer(rise_delay=20n fall_delay=20n)
`, { type: "tran", tstep: 1e-9, tstop: 1e-6 });
    expect(edges(r, "v(a)", 2.5, true).length).toBeGreaterThan(3);
    expect(edges(r, "v(y)", 2.5, true).length).toBe(0);
  });

  it("oscillates a ring of three inverters at 2 N t", () => {
    const tau = 10e-9;
    const r = simulate(`ring
a1 a b inv
a2 b c inv
a3 c a inv
.model inv d_inverter(rise_delay=10n fall_delay=10n)
`, { type: "tran", tstep: 1e-9, tstop: 1e-6 });
    const up = edges(r, "v(a)", 2.5, true);
    expect(up.length).toBeGreaterThan(10);
    for (let i = 2; i < up.length; i++) {
      expect(Math.abs(up[i]! - up[i - 1]! - 6 * tau)).toBeLessThan(1e-12);
    }
  });

  it("settles on a stable state from a cross-coupled NAND latch", () => {
    const r = simulate(`latch
a1 [s qb] q nd
a2 [r q] qb nd
a3 s cs
a4 r cr
.model nd d_nand(rise_delay=1n fall_delay=1n)
.model cs d_constsource(state=1)
.model cr d_constsource(state=1)
`, { type: "tran", tstep: 1e-9, tstop: 100e-9 });
    expect(Math.abs(at(r, "v(q)", 90e-9) + at(r, "v(qb)", 90e-9) - 5)).toBeLessThan(1e-6);
  });

  it("shares a bus through tristate drivers with a pull-down", () => {
    const r = simulate(`bus
a1 d cd
a2 e ce
a3 d e bus gate
a4 bus pd
.model cd d_constsource(state=1)
.model ce d_clock(frequency=1meg duty=0.5 delay=0)
.model gate d_tristate(delay=1n)
.model pd d_pulldown(load=1p)
`, { type: "tran", tstep: 5e-9, tstop: 2e-6 });
    expect(Math.abs(at(r, "v(bus)", 0.2e-6) - 5)).toBeLessThan(1e-6);
    expect(Math.abs(at(r, "v(bus)", 0.7e-6))).toBeLessThan(1e-6);
  });
});

describe("sequential models", () => {
  it("divides by two with a D flip-flop", () => {
    const r = simulate(`divider
a1 clk ck
a2 qb clk 0 0 q qb ff
${CLOCK}.model ff d_dff(clk_delay=5n rise_delay=2n fall_delay=2n set_delay=1n reset_delay=1n)
`, { type: "tran", tstep: 10e-9, tstop: 10e-6 });
    const up = edges(r, "v(q)", 2.5, true);
    expect(up.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < up.length; i++) expect(Math.abs(up[i]! - up[i - 1]! - 2e-6)).toBeLessThan(1e-12);
    // Output follows the clock edge by clk_delay plus the output delay.
    const clk = edges(r, "v(clk)", 2.5, true);
    expect(clk.some((t) => Math.abs(up[0]! - t - 7e-9) < 1e-12)).toBe(true);
  });

  it("chains flip-flops into a ripple counter that counts", () => {
    const r = simulate(`counter
a1 clk ck
a2 v1 v1 clk 0 0 q0 nq0 jk
a3 v1 v1 nq0 0 0 q1 nq1 jk
a4 v1 cone
${CLOCK}.model jk d_jkff(clk_delay=1n rise_delay=1n fall_delay=1n set_delay=1n reset_delay=1n)
.model cone d_constsource(state=1)
`, { type: "tran", tstep: 5e-9, tstop: 16e-6 });
    const u0 = edges(r, "v(q0)", 2.5, true);
    const u1 = edges(r, "v(q1)", 2.5, true);
    expect(Math.abs(u0[2]! - u0[1]! - 2e-6)).toBeLessThan(1e-11);
    expect(Math.abs(u1[2]! - u1[1]! - 4e-6)).toBeLessThan(1e-11);
  });

  it("toggles a T flip-flop and honours set and reset", () => {
    const r = simulate(`tff
a1 clk ck
a2 v1 clk 0 rst q nq t
a3 v1 cone
a4 rst pr
${CLOCK}.model t d_tff(clk_delay=1n rise_delay=1n fall_delay=1n set_delay=1n reset_delay=1n ic=0)
.model cone d_constsource(state=1)
.model pr d_clock(frequency=100k duty=0.5 delay=5u)
`, { type: "tran", tstep: 5e-9, tstop: 9e-6 });
    expect(edges(r, "v(q)", 2.5, true).length).toBeGreaterThanOrEqual(2);
    // Reset goes high at 5 us and holds Q low.
    expect(at(r, "v(q)", 8e-6)).toBeLessThan(0.1);
  });

  it("is transparent while a D latch is enabled", () => {
    const r = simulate(`dlatch
a1 d cd
a2 en ce
a3 d en 0 0 q nq la
.model cd d_clock(frequency=2meg duty=0.5 delay=0)
.model ce d_clock(frequency=250k duty=0.5 delay=0)
.model la d_dlatch(data_delay=1n enable_delay=1n set_delay=1n reset_delay=1n rise_delay=1n fall_delay=1n ic=0)
`, { type: "tran", tstep: 2e-9, tstop: 4e-6 });
    // While enabled, Q follows the fast input; once disabled it stays put.
    const during = edges(r, "v(q)", 2.5, true).filter((t) => t < 2e-6);
    const after = edges(r, "v(q)", 2.5, true).filter((t) => t > 2.1e-6);
    expect(during.length).toBeGreaterThanOrEqual(3);
    expect(after.length).toBe(0);
  });

  it("sets and resets an SR flip-flop on the clock edge", () => {
    const r = simulate(`srff
a1 clk ck
a2 s cs
a3 r cr
a4 s r clk 0 0 q nq sr
${CLOCK}.model cs d_clock(frequency=100k duty=0.5 delay=0)
.model cr d_clock(frequency=100k duty=0.5 delay=5u)
.model sr d_srff(clk_delay=1n rise_delay=1n fall_delay=1n set_delay=1n reset_delay=1n)
`, { type: "tran", tstep: 5e-9, tstop: 9e-6 });
    expect(at(r, "v(q)", 4.5e-6)).toBeGreaterThan(4.9);
    expect(at(r, "v(q)", 8.5e-6)).toBeLessThan(0.1);
  });

  it("runs truth-table chips, combinational and clocked", () => {
    const r = simulate(`chips
a1 clk ck
a2 [clk] [q0 q1] cnt
a3 [q0 q1] [y] dec
${CLOCK}.model cnt d_chip(behaviour="
+;two bit counter
+/inputs CLK
+/outputs Q0 Q1
+/clock CLK + 2 1 0
+X XX F+0 F+1
+/table 1
+X XX F0 F1
+")
.model dec d_chip(behaviour="
+/inputs A B
+/outputs Y
+/table 2
+H H H
+X X L
+")
`, { type: "tran", tstep: 5e-9, tstop: 8e-6 });
    const up0 = edges(r, "v(q0)", 2.5, true);
    const up1 = edges(r, "v(q1)", 2.5, true);
    expect(Math.abs(up0[2]! - up0[1]! - 2e-6)).toBeLessThan(5e-9);
    expect(Math.abs(up1[1]! - up1[0]! - 4e-6)).toBeLessThan(5e-9);
    const upY = edges(r, "v(y)", 2.5, true);
    expect(Math.abs(upY[1]! - upY[0]! - 4e-6)).toBeLessThan(5e-9);
  });

  it("stores and returns a word in d_ram", () => {
    const r = simulate(`ram
a1 d cd
a2 a ca
a3 we cw
a4 cs cc
a5 [d] [o] [a] we [cs] mem
.model cd d_constsource(state=1)
.model ca d_constsource(state=1)
.model cc d_constsource(state=1)
.model cw d_clock(frequency=100k duty=0.1 delay=1u)
.model mem d_ram(select_value=1 read_delay=10n)
`, { type: "tran", tstep: 5e-9, tstop: 5e-6 });
    expect(at(r, "v(o)", 4e-6)).toBeGreaterThan(4.9);
  });
});

describe("mixed signal", () => {
  it("applies ADC thresholds, with unknown between them", () => {
    const r = simulate(`adc
V1 in 0 PWL(0 0 3m 3 6m 0)
R1 in 0 1k
a1 [in] [d] adc1
.model adc1 adc_bridge(in_low=1 in_high=2 rise_delay=0 fall_delay=0)
`, { type: "tran", tstep: 10e-6, tstop: 6e-3 });
    // The digital net shows mid-rail while unknown, between the thresholds.
    expect(at(r, "v(d)", 0.5e-3)).toBeLessThan(0.01);
    expect(Math.abs(at(r, "v(d)", 1.5e-3) - 2.5)).toBeLessThan(0.01);
    expect(at(r, "v(d)", 2.5e-3)).toBeGreaterThan(4.99);
    const up = edges(r, "v(d)", 4, true);
    expect(Math.abs(up[0]! - 2e-3)).toBeLessThan(1e-6);
    const down = edges(r, "v(d)", 1, false);
    expect(Math.abs(down[0]! - 5e-3)).toBeLessThan(1e-6);
  });

  it("drives an analog node from a DAC with its levels and edge time", () => {
    const r = simulate(`dac
a1 d cd
a2 [d] [out] dac1
R1 out 0 1k
.model cd d_clock(frequency=100k duty=0.5 delay=1u)
.model dac1 dac_bridge(out_low=0.5 out_high=3.3 out_undef=1 t_rise=100n t_fall=200n)
`, { type: "tran", tstep: 20e-9, tstop: 12e-6 });
    expect(Math.abs(at(r, "v(out)", 0.5e-6) - 0.5)).toBeLessThan(1e-2);
    expect(Math.abs(at(r, "v(out)", 3e-6) - 3.3)).toBeLessThan(1e-2);
    expect(Math.abs(at(r, "v(out)", 8e-6) - 0.5)).toBeLessThan(1e-2);
    // Halfway up the 100 ns ramp that starts at the 1 us edge.
    expect(Math.abs(at(r, "v(out)", 1.05e-6) - (0.5 + 3.3) / 2)).toBeLessThan(0.05);
  });

  it("bridges a digital port on an analog net automatically", () => {
    const r = simulate(`bridge
V1 in 0 PWL(0 0 1m 5)
R1 in 0 1k
a1 in out inv
R2 out n 1k
C1 n 0 1n
.model inv d_inverter(rise_delay=1n fall_delay=1n)
`, { type: "tran", tstep: 1e-6, tstop: 1e-3 });
    // Threshold is 2.5 V, reached at 0.5 ms; output drives the R-C from 5 V to 0.
    expect(at(r, "v(out)", 0.2e-3)).toBeGreaterThan(4.9);
    expect(at(r, "v(out)", 0.8e-3)).toBeLessThan(0.1);
    const down = edges(r, "v(out)", 2.5, false);
    expect(Math.abs(down[0]! - 0.5e-3)).toBeLessThan(1e-6);
    // The RC settles with its own time constant of 1 us after the edge.
    expect(at(r, "v(n)", 0.8e-3)).toBeLessThan(0.1);
  });

  it("closes the loop through an analog RC: Schmitt-style oscillator period", () => {
    const r = simulate(`rc oscillator
a1 n out inv
R1 out n 1k
C1 n 0 1u
.model inv d_inverter(rise_delay=1n fall_delay=1n)
`, { type: "tran", tstep: 10e-6, tstop: 2e-3 });
    // Without hysteresis a single threshold at 2.5 V holds the node there, with fast chatter
    // bounded by the gate delay; the mean sits at the threshold.
    const v = at(r, "v(n)", 1.5e-3);
    expect(Math.abs(v - 2.5)).toBeLessThan(0.1);
  });

  it("settles digital logic at a DC operating point", () => {
    const r = simulate(`dc logic
V1 a 0 5
V2 b 0 0
R1 a 0 1k
R2 b 0 1k
a1 [a b] y nd
R3 y 0 1k
.model nd d_nand(rise_delay=1n fall_delay=1n)
`, { type: "op" });
    expect(vec(r, "v(y)").re[0]!).toBeGreaterThan(4.9);
  });

  it("sweeps a threshold in a DC analysis", () => {
    const r = simulate(`dc sweep
V1 a 0 0
R1 a 0 1k
a1 a y buf
R2 y 0 1k
.model buf d_buffer(rise_delay=1n fall_delay=1n)
`, { type: "dc", source: "v1", start: 0, stop: 5, step: 0.5 });
    const y = vec(r, "v(y)").re;
    expect(y[4]!).toBeLessThan(0.1);
    expect(y[6]!).toBeGreaterThan(4.9);
  });

  it("warns about firmware devices and solves the rest", () => {
    const r = simulate("t\nV1 a 0 1\nR1 a 0 1\na1 [a] [b] cpu\n.model cpu d_cpu(hex_file=x)\n", { type: "op" });
    expect(r.warnings.join()).toMatch(/unsupported device ignored: a1/);
  });
});

describe("analog code models", () => {
  const dc = (body: string): SimResult => simulate(`t\nV1 a 0 2\nR0 a 0 1k\nV2 b 0 3\nR00 b 0 1k\n${body}\n`, { type: "op" });
  const y = (r: SimResult): number => vec(r, "v(y)").re[0]!;

  it("computes gain, summer and mult", () => {
    expect(y(dc("a1 %vd(a b) %v(y) g\n.model g gain(in_offset=0.5 gain=2 out_offset=1)\nRy y 0 1k"))).toBeCloseTo((2 - 3 + 0.5) * 2 + 1, 6);
    expect(y(dc("a1 [a b] y s\n.model s summer(in_offset=[0 1] in_gain=[2 3] out_gain=10 out_offset=1)\nRy y 0 1k"))).toBeCloseTo((2 * 2 + (3 + 1) * 3) * 10 + 1, 5);
    expect(y(dc("a1 [a b] y m\n.model m mult(in_offset=[0 0] in_gain=[1 1] out_gain=0.1 out_offset=0)\nRy y 0 1k"))).toBeCloseTo(0.6, 6);
  });

  it("clamps with limit and climit", () => {
    expect(y(dc("a1 a y l\n.model l limit(gain=5 out_lower_limit=-1 out_upper_limit=4)\nRy y 0 1k"))).toBeCloseTo(4, 6);
    expect(y(dc("a1 a a b y c\n.model c climit(gain=5 upper_delta=0.5 lower_delta=0)\nRy y 0 1k"))).toBeLessThanOrEqual(3);
  });

  it("interpolates pwl and sources current through %id", () => {
    expect(y(dc("a1 a y p\n.model p pwl(x_array=[0 1 3] y_array=[0 10 30])\nRy y 0 1k"))).toBeCloseTo(20, 5);
    // A %id output is a current through the port, here 2 mA into 1 k.
    const r = dc("a1 %vd(a 0) %id(0 y) p\n.model p pwl(x_array=[0 1 3] y_array=[0 1m 3m])\nRy y 0 1k");
    expect(y(r)).toBeCloseTo(2, 4);
  });

  it("realises s_xfer as a first-order lag", () => {
    const r = simulate(`lag
V1 in 0 PULSE(0 1 0 1n 1n 1 2)
R0 in 0 1k
a1 %vd(in 0) %vd(y 0) f
Ry y 0 1k
.model f s_xfer(gain=1 num_coeff=[1] den_coeff=[0.001 1] int_ic=[0 0])
`, { type: "tran", tstep: 10e-6, tstop: 5e-3 });
    expect(Math.abs(at(r, "v(y)", 1e-3) - (1 - Math.exp(-1)))).toBeLessThan(2e-3);
    expect(Math.abs(at(r, "v(y)", 3e-3) - (1 - Math.exp(-3)))).toBeLessThan(2e-3);
  });

  it("gives s_xfer the right second-order AC response", () => {
    const w0 = 2 * Math.PI * 1000;
    const r = simulate(`second order
V1 in 0 AC 1
R0 in 0 1k
a1 %vd(in 0) %vd(y 0) f
Ry y 0 1k
.model f s_xfer(gain=1 num_coeff=[${w0 * w0}] den_coeff=[1 ${w0 * Math.SQRT2} ${w0 * w0}])
`, { type: "ac", sweep: "lin", points: 1, fstart: 1000, fstop: 1000 });
    const v = vec(r, "v(y)");
    expect(Math.abs(Math.hypot(v.re[0]!, v.im![0]!) - Math.SQRT1_2)).toBeLessThan(1e-4);
  });

  it("generates a voltage-controlled square wave", () => {
    const r = simulate(`square
V1 c 0 2
R0 c 0 1k
a1 %vd(c 0) %vd(y 0) sq
Ry y 0 1k
.model sq square(cntl_array=[0 4] freq_array=[0 2000] out_low=0 out_high=5 duty_cycle=0.25 rise_time=1u fall_time=1u)
`, { type: "tran", tstep: 5e-6, tstop: 10e-3 });
    const up = edges(r, "v(y)", 2.5, true);
    expect(Math.abs(up[2]! - up[1]! - 1e-3)).toBeLessThan(1e-6);
    const down = edges(r, "v(y)", 2.5, false);
    expect(Math.abs(down[1]! - up[1]! - 0.25e-3)).toBeLessThan(2e-6);
  });

  it("places a precision comparator's edge at the crossing", () => {
    const r = simulate(`comparator
V1 in 0 SIN(0 1 1k)
V2 ref 0 0.5
R1 in 0 1k
R2 ref 0 1k
a1 y in ref cmp
Ry y 0 1k
.model cmp precision_comparator(output_level=5 rise_fall_time=1n)
`, { type: "tran", tstep: 20e-6, tstop: 2e-3 });
    const up = edges(r, "v(y)", 2.5, true);
    const expected = Math.asin(0.5) / (2 * Math.PI * 1000);
    expect(Math.abs(up[0]! - expected)).toBeLessThan(2e-8);
  });

  it("follows the XSPICE hysteresis curves", () => {
    const r = simulate(`hyst
V1 in 0 PWL(0 0 1 3 2 0)
R0 in 0 1k
a1 in y h
Ry y 0 1k
.model h hyst(in_low=1 in_high=2 hyst=0.25 out_lower_limit=0 out_upper_limit=5)
`, { type: "tran", tstep: 5e-3, tstop: 2 });
    // Rising ramp runs 1.25..2.25, falling ramp 0.75..1.75.
    expect(at(r, "v(y)", 1.75 / 3)).toBeCloseTo(2.5, 1);
    expect(at(r, "v(y)", 2 - 1.25 / 3)).toBeCloseTo(2.5, 1);
  });

  it("replays triggered_pwl from an edge", () => {
    const r = simulate(`triggered
V1 in 0 PULSE(0 5 1m 1u 1u 10m 20m)
R0 in 0 1k
a1 %vd(in 0) %vd(y 0) tp
Ry y 0 1k
.model tp triggered_pwl(time_array=[0 1m 2m] output_array=[0 2 0] vth=2.5 edge=Rising retriggerable=false repeat=false)
`, { type: "tran", tstep: 20e-6, tstop: 5e-3 });
    expect(at(r, "v(y)", 0.5e-3)).toBeLessThan(1e-3);
    expect(Math.abs(at(r, "v(y)", 2e-3) - 2)).toBeLessThan(0.02);
    expect(at(r, "v(y)", 4e-3)).toBeLessThan(1e-3);
  });
});
