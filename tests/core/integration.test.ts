// Schematic to netlist to engine, checked against hand calculations.
import { describe, expect, it } from "vitest";
import { findVector, rms } from "../../src/core/analyses";
import { Doc } from "../../src/core/doc";
import { PARTS } from "../../src/core/library";
import { buildNetlist } from "../../src/core/netlist";
import type { SchComponent } from "../../src/core/schematic";
import type { AnalysisRequest } from "../../src/core/sim";
import { simulate } from "../../src/engine/index";

function circuit() {
  const doc = new Doc();
  const gnd = doc.addPart("ground", 0, 400);
  const wire = (a: SchComponent, pa: string, b: SchComponent, pb: string) => doc.connectPins(a, pa, b, pb);
  const run = (request: AnalysisRequest) => {
    const netlist = buildNetlist(doc.schematic);
    return { netlist, result: simulate(netlist.text, request) };
  };
  const value = (out: ReturnType<typeof run>, comp: SchComponent, pin: string) => {
    const net = out.netlist.pinNets.get(comp.id)!.get(pin)!;
    if (net === "0") return 0;
    return findVector(out.result, `v(${net})`)!.re[0];
  };
  return { doc, gnd, wire, run, value };
}

describe("library parts simulate", () => {
  it("resistive divider", () => {
    const { doc, gnd, wire, run, value } = circuit();
    const v = doc.addPart("vdc", 0, 0, { value: "10" });
    const r1 = doc.addPart("resistor", 100, 0, { value: "1k" });
    const r2 = doc.addPart("resistor", 200, 0, { value: "3k" });
    wire(v, "p", r1, "1"); wire(r1, "2", r2, "1"); wire(r2, "2", gnd, "g"); wire(v, "n", gnd, "g");
    expect(value(run({ type: "op" }), r2, "1")).toBeCloseTo(7.5, 6);
  });

  it("RC low-pass has its corner at 1/(2 pi R C)", () => {
    const { doc, gnd, wire, run } = circuit();
    const v = doc.addPart("vsin", 0, 0);
    const r = doc.addPart("resistor", 100, 0, { value: "1k" });
    const c = doc.addPart("capacitor", 200, 0, { value: "1u" });
    wire(v, "p", r, "1"); wire(r, "2", c, "1"); wire(c, "2", gnd, "g"); wire(v, "n", gnd, "g");
    const out = run({ type: "ac", sweep: "dec", points: 200, fstart: 1, fstop: 1e5 });
    const net = out.netlist.pinNets.get(c.id)!.get("1")!;
    const vec = findVector(out.result, `v(${net})`)!;
    const axis = out.result.axis!.re;
    const i = axis.findIndex((f) => f >= 1 / (2 * Math.PI * 1e3 * 1e-6));
    expect(Math.hypot(vec.re[i], vec.im![i])).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it("inverting op-amp amplifier has gain -Rf/Rin", () => {
    const { doc, gnd, wire, run, value } = circuit();
    const v = doc.addPart("vdc", 0, 0, { value: "0.5" });
    const rin = doc.addPart("resistor", 100, 0, { value: "1k" });
    const rf = doc.addPart("resistor", 300, -100, { value: "10k" });
    const u = doc.addPart("opamp", 300, 0);
    wire(v, "p", rin, "1"); wire(rin, "2", u, "-"); wire(u, "-", rf, "1"); wire(rf, "2", u, "out");
    wire(u, "+", gnd, "g"); wire(v, "n", gnd, "g");
    expect(value(run({ type: "op" }), u, "out")).toBeCloseTo(-5, 2);
  });

  it("op-amp output saturates at its limit", () => {
    const { doc, gnd, wire, run, value } = circuit();
    const v = doc.addPart("vdc", 0, 0, { value: "2" });
    const load = doc.addPart("resistor", 300, 0, { value: "100k" });
    const u = doc.addPart("opamp", 200, 0, { vsat: "12" });
    wire(v, "p", u, "+"); wire(u, "-", gnd, "g"); wire(u, "out", load, "1"); wire(load, "2", gnd, "g"); wire(v, "n", gnd, "g");
    expect(Math.abs(value(run({ type: "op" }), u, "out") - 12)).toBeLessThan(0.1);
  });

  it("NPN common-emitter biases in the active region", () => {
    const { doc, gnd, wire, run, value } = circuit();
    const vcc = doc.addPart("vcc", 200, -200, { value: "12" });
    const rb = doc.addPart("resistor", 100, -100, { value: "1meg" });
    const rc = doc.addPart("resistor", 300, -100, { value: "2k" });
    const q = doc.addPart("npn", 200, 0);
    wire(vcc, "p", rb, "1"); wire(rb, "2", q, "B"); wire(vcc, "p", rc, "1"); wire(rc, "2", q, "C"); wire(q, "E", gnd, "g");
    const out = run({ type: "op" });
    const vb = value(out, q, "B");
    const vc = value(out, q, "C");
    expect(vb).toBeGreaterThan(0.55);
    expect(vb).toBeLessThan(0.85);
    // Ib is about 11.3uA and BF is 200 before Early effect, so about 2.3mA and Vc near 7.4V.
    expect(vc).toBeGreaterThan(5);
    expect(vc).toBeLessThan(9);
  });

  it("CMOS inverter with library MOSFETs inverts", () => {
    const { doc, gnd, wire, run, value } = circuit();
    const vdd = doc.addPart("vcc", 200, -200, { value: "5" });
    const vin = doc.addPart("vdc", 0, 0, { value: "0" });
    const p = doc.addPart("pmos", 200, -80);
    const n = doc.addPart("nmos", 200, 80);
    wire(vdd, "p", p, "S"); wire(p, "D", n, "D"); wire(n, "S", gnd, "g");
    wire(vin, "p", p, "G"); wire(p, "G", n, "G"); wire(vin, "n", gnd, "g");
    expect(value(run({ type: "op" }), n, "D")).toBeGreaterThan(4.9);
    vin.params.value = "5";
    expect(value(run({ type: "op" }), n, "D")).toBeLessThan(0.1);
  });

  it("diode, zener and LED drop plausible voltages", () => {
    for (const [kind, lo, hi] of [["diode", 0.5, 1.0], ["led", 1.3, 2.4]] as const) {
      const { doc, gnd, wire, run, value } = circuit();
      const v = doc.addPart("vdc", 0, 0, { value: "12" });
      const r = doc.addPart("resistor", 100, 0, { value: "1k" });
      const d = doc.addPart(kind, 200, 0);
      wire(v, "p", r, "1"); wire(r, "2", d, "A"); wire(d, "K", gnd, "g"); wire(v, "n", gnd, "g");
      const drop = value(run({ type: "op" }), d, "A");
      expect(drop).toBeGreaterThan(lo);
      expect(drop).toBeLessThan(hi);
    }
    const { doc, gnd, wire, run, value } = circuit();
    const v = doc.addPart("vdc", 0, 0, { value: "12" });
    const r = doc.addPart("resistor", 100, 0, { value: "1k" });
    const z = doc.addPart("zener", 200, 0);
    wire(v, "p", r, "1"); wire(r, "2", z, "K"); wire(z, "A", gnd, "g"); wire(v, "n", gnd, "g");
    const reverse = value(run({ type: "op" }), z, "K");
    expect(reverse).toBeGreaterThan(4.8);
    expect(reverse).toBeLessThan(5.6);
  });

  it("function generator drives a load in every waveform", () => {
    for (const shape of ["sine", "square", "triangle"]) {
      const { doc, gnd, wire, run } = circuit();
      const gen = doc.addPart("function-generator", 0, 0, { shape, freq: "1k", amp: "2" });
      const r = doc.addPart("resistor", 100, 0);
      wire(gen, "p", r, "1"); wire(r, "2", gnd, "g"); wire(gen, "n", gnd, "g");
      const out = run({ type: "tran", tstop: 5e-3, tstep: 5e-6 });
      const net = out.netlist.pinNets.get(gen.id)!.get("p")!;
      const vec = findVector(out.result, `v(${net})`)!;
      const measured = rms(vec.re, out.result.axis!.re);
      const expected = { sine: 2 / Math.SQRT2, square: 2, triangle: 2 / Math.sqrt(3) }[shape]!;
      expect(Math.abs(measured - expected) / expected).toBeLessThan(0.03);
    }
  });

  it("multimeter reads current and resistance", () => {
    const amps = circuit();
    const v = amps.doc.addPart("vdc", 0, 0, { value: "10" });
    const r = amps.doc.addPart("resistor", 100, 0, { value: "2k" });
    const meter = amps.doc.addPart("multimeter", 200, 0, { mode: "amps" });
    amps.wire(v, "p", r, "1"); amps.wire(r, "2", meter, "p"); amps.wire(meter, "n", amps.gnd, "g"); amps.wire(v, "n", amps.gnd, "g");
    const out = amps.run({ type: "op" });
    expect(Math.abs(findVector(out.result, `i(v${meter.refDes})`)!.re[0])).toBeCloseTo(5e-3, 6);

    const ohms = circuit();
    const rx = ohms.doc.addPart("resistor", 100, 0, { value: "4.7k" });
    const om = ohms.doc.addPart("multimeter", 200, 0, { mode: "ohms" });
    ohms.wire(rx, "1", om, "p"); ohms.wire(rx, "2", om, "n"); ohms.wire(om, "n", ohms.gnd, "g");
    const volts = ohms.value(ohms.run({ type: "op" }), om, "p");
    expect(volts / 1e-3).toBeCloseTo(4700, 0);
  });

  it("transformer steps voltage by the square root of the inductance ratio", () => {
    const { doc, gnd, wire, run } = circuit();
    const v = doc.addPart("vsin", 0, 0, { amp: "10", freq: "1k" });
    const t = doc.addPart("transformer", 100, 0, { lp: "100m", ls: "1m", k: "0.9999" });
    const load = doc.addPart("resistor", 200, 0, { value: "1k" });
    wire(v, "p", t, "p1"); wire(t, "p2", gnd, "g"); wire(v, "n", gnd, "g");
    wire(t, "s1", load, "1"); wire(load, "2", gnd, "g"); wire(t, "s2", gnd, "g");
    const out = run({ type: "tran", tstop: 5e-3, tstep: 5e-6 });
    const net = out.netlist.pinNets.get(load.id)!.get("1")!;
    const vec = findVector(out.result, `v(${net})`)!;
    expect(Math.abs(rms(vec.re, out.result.axis!.re) - 10 / Math.SQRT2 / 10)).toBeLessThan(0.05);
  });

  it("every simulating part in the library produces valid netlist text", () => {
    for (const part of PARTS) {
      // A model block needs a subcircuit from the user; features.test.ts covers it.
      if (part.instrument || !part.spice || part.kind === "subcircuit") continue;
      const { doc, gnd, wire, run } = circuit();
      const comp = doc.addPart(part.kind, 200, 0);
      const load = doc.addPart("resistor", 400, 0, { value: "1k" });
      wire(load, "2", gnd, "g");
      comp.pins.forEach((pin, i) => {
        if (i === 0) wire(comp, pin.name, load, "1");
        else wire(comp, pin.name, gnd, "g");
      });
      // Sources get no second supply: two voltage sources in parallel are correctly singular.
      if (part.category !== "Sources") {
        const supply = doc.addPart("vdc", 0, 0, { value: "1" });
        wire(supply, "p", load, "1");
        wire(supply, "n", gnd, "g");
      }
      expect(() => run({ type: "op" }), part.kind).not.toThrow();
    }
  });
});
