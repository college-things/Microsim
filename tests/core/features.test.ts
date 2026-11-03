// Examples, digital parts, settings-dependent parts, clipboard and exports.
import { describe, expect, it } from "vitest";
import { findVector } from "../../src/core/analyses";
import { Doc } from "../../src/core/doc";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { resultToCsv, schematicToSvg } from "../../src/core/export";
import { buildNetlist } from "../../src/core/netlist";
import { simulate } from "../../src/engine/index";

const voltage = (doc: Doc, comp: { id: string }, pin: string, netlist = buildNetlist(doc.schematic)) => {
  const result = simulate(netlist.text, { type: "op" });
  return findVector(result, `v(${netlist.pinNets.get(comp.id)!.get(pin)})`)!.re[0];
};

describe("examples", () => {
  for (const example of EXAMPLES) {
    it(`${example.name} is fully wired and simulates`, () => {
      const schematic = buildExample(example);
      const netlist = buildNetlist(schematic);
      const open = netlist.warnings.filter((w) => !w.includes("logic-analyzer"));
      expect(open).toEqual([]);
      const result = simulate(netlist.text, { type: "tran", tstop: 3e-3, tstep: 3e-6 });
      expect(result.warnings.filter((w) => /unsupported|ignored/i.test(w))).toEqual([]);
      expect(result.axis!.re.length).toBeGreaterThan(10);
    });
  }

  it("common-emitter example amplifies with phase inversion", () => {
    const schematic = buildExample(EXAMPLES.find((e) => e.name.startsWith("Common-emitter"))!);
    const netlist = buildNetlist(schematic);
    const q = schematic.components.find((c) => c.kind === "npn")!;
    const gen = schematic.components.find((c) => c.kind === "vsin")!;
    const nets = netlist.pinNets;
    const result = simulate(netlist.text, { type: "tran", tstop: 20e-3, tstep: 5e-6, tmax: 10e-6 });
    const out = findVector(result, `v(${nets.get(q.id)!.get("C")})`)!.re;
    const start = Math.floor(out.length * 0.75);
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < out.length; i++) { lo = Math.min(lo, out[i]); hi = Math.max(hi, out[i]); }
    const gain = (hi - lo) / 2 / 10e-3;
    expect(gain).toBeGreaterThan(20);
    expect(lo).toBeGreaterThan(0.2);
    expect(hi).toBeLessThan(12);
    expect(nets.get(gen.id)!.get("p")).toBeTruthy();
  });

  it("full-wave rectifier example charges to peak minus two diode drops", () => {
    const schematic = buildExample(EXAMPLES.find((e) => e.name.startsWith("Full-wave"))!);
    const netlist = buildNetlist(schematic);
    const load = schematic.components.find((c) => c.kind === "resistor")!;
    const result = simulate(netlist.text, { type: "tran", tstop: 0.1, tstep: 1e-4, tmax: 1e-4 });
    const out = findVector(result, `v(${netlist.pinNets.get(load.id)!.get("1")})`)!.re;
    let hi = -Infinity;
    for (const v of out) hi = Math.max(hi, v);
    expect(hi).toBeGreaterThan(9.5);
    expect(hi).toBeLessThan(11.5);
  });

  it("flip-flop divider output runs at half the clock", () => {
    const schematic = buildExample(EXAMPLES.find((e) => e.name.startsWith("D flip-flop"))!);
    const netlist = buildNetlist(schematic);
    const ff = schematic.components.find((c) => c.kind === "dff")!;
    const result = simulate(netlist.text, { type: "tran", tstop: 10e-3, tstep: 5e-6, tmax: 20e-6 });
    const q = findVector(result, `v(${netlist.pinNets.get(ff.id)!.get("Q")})`)!.re;
    let edges = 0;
    for (let i = 1; i < q.length; i++) if (q[i - 1] < 2.5 && q[i] >= 2.5) edges++;
    // 10 clock periods give 5 output periods.
    expect(edges).toBeGreaterThanOrEqual(4);
    expect(edges).toBeLessThanOrEqual(6);
  });
});

describe("digital gates follow their truth tables", () => {
  const table: Record<string, number[]> = {
    and: [0, 0, 0, 1], or: [0, 1, 1, 1], nand: [1, 1, 1, 0], nor: [1, 0, 0, 0], xor: [0, 1, 1, 0],
  };
  for (const [kind, expected] of Object.entries(table)) {
    it(kind, () => {
      [[0, 0], [0, 5], [5, 0], [5, 5]].forEach(([a, b], row) => {
        const doc = new Doc();
        const gnd = doc.addPart("ground", -300, 300);
        const va = doc.addPart("vdc", -300, -100, { value: String(a) });
        const vb = doc.addPart("vdc", -300, 100, { value: String(b) });
        const u = doc.addPart(kind, 0, 0);
        const load = doc.addPart("resistor", 200, 0, { value: "10k" });
        doc.connectPins(va, "p", u, "a");
        doc.connectPins(vb, "p", u, "b");
        doc.connectPins(u, "y", load, "1");
        doc.connectPins(load, "2", gnd, "g");
        doc.connectPins(va, "n", gnd, "g");
        doc.connectPins(vb, "n", gnd, "g");
        const v = voltage(doc, u, "y");
        expect(v > 2.5 ? 1 : 0, `${kind} ${a} ${b}`).toBe(expected[row]);
      });
    });
  }
});

describe("settings-dependent parts", () => {
  it("switch opens and closes a circuit", () => {
    const doc = new Doc();
    const gnd = doc.addPart("ground", -200, 200);
    const v = doc.addPart("vdc", -200, 0, { value: "5" });
    const s = doc.addPart("switch", 0, -60);
    const r = doc.addPart("resistor", 200, 0, { value: "1k" });
    doc.connectPins(v, "p", s, "1");
    doc.connectPins(s, "2", r, "1");
    doc.connectPins(r, "2", gnd, "g");
    doc.connectPins(v, "n", gnd, "g");
    expect(voltage(doc, r, "1")).toBeLessThan(1e-3);
    s.params.state = "closed";
    expect(voltage(doc, r, "1")).toBeCloseTo(5, 3);
  });

  it("potentiometer divides by its setting", () => {
    const doc = new Doc();
    const gnd = doc.addPart("ground", -200, 200);
    const v = doc.addPart("vdc", -200, 0, { value: "10" });
    const p = doc.addPart("potentiometer", 100, 0, { value: "10k", percent: "25" });
    doc.connectPins(v, "p", p, "1");
    doc.connectPins(p, "2", gnd, "g");
    doc.connectPins(v, "n", gnd, "g");
    const load = doc.addPart("resistor", 300, -100, { value: "100meg" });
    doc.connectPins(p, "w", load, "1");
    doc.connectPins(load, "2", gnd, "g");
    expect(voltage(doc, p, "w")).toBeCloseTo(7.5, 2);
  });

  it("wattmeter's sense source is in series with the load", () => {
    const doc = new Doc();
    const gnd = doc.addPart("ground", -200, 200);
    const v = doc.addPart("vdc", -200, 0, { value: "10" });
    const w = doc.addPart("wattmeter", 0, -100);
    const r = doc.addPart("resistor", 200, 0, { value: "100" });
    doc.connectPins(v, "p", w, "i+");
    doc.connectPins(w, "i-", r, "1");
    doc.connectPins(r, "2", gnd, "g");
    doc.connectPins(v, "n", gnd, "g");
    doc.connectPins(v, "p", w, "v+");
    doc.connectPins(w, "v-", gnd, "g");
    const result = simulate(buildNetlist(doc.schematic).text, { type: "op" });
    expect(Math.abs(findVector(result, `i(v${w.refDes})`)!.re[0])).toBeCloseTo(0.1, 6);
  });

  it("uses a pasted vendor subcircuit through a model block", () => {
    const doc = new Doc();
    doc.schematic.definitions = ".subckt MY_MODEL a b c d\nR1 a b 1k\nR2 c d 1k\n.ends";
    const gnd = doc.addPart("ground", -200, 300);
    const v = doc.addPart("vdc", -200, 0, { value: "2" });
    const x = doc.addPart("subcircuit", 100, 0);
    doc.connectPins(v, "p", x, "1");
    doc.connectPins(x, "2", gnd, "g");
    doc.connectPins(x, "3", gnd, "g");
    doc.connectPins(x, "4", gnd, "g");
    doc.connectPins(v, "n", gnd, "g");
    const result = simulate(buildNetlist(doc.schematic).text, { type: "op" });
    expect(Math.abs(findVector(result, "i(v1)")!.re[0])).toBeCloseTo(2e-3, 6);
  });
});

describe("clipboard", () => {
  it("copies with fresh references and without joining the original's nets", () => {
    const doc = new Doc();
    const r = doc.addPart("resistor", 0, 0);
    r.pins[0].net = "fromfile";
    r.pins[1].net = "0";
    const ids = doc.paste({ components: [structuredClone(r)], wires: [] }, 40, 40);
    const copy = doc.schematic.components.find((c) => c.id === ids[0])!;
    expect(copy.refDes).toBe("R2");
    expect(copy.pins[0].net).toBeUndefined();
    expect(copy.pins[1].net).toBe("0");
    expect(copy.x).toBe(40);
  });

  it("treats a net label as a connection", () => {
    const doc = new Doc();
    const a = doc.addPart("resistor", 0, 0);
    const b = doc.addPart("resistor", 500, 500);
    doc.schematic.labels.push({ id: "l1", x: 30, y: 0, net: "OUT" }, { id: "l2", x: 470, y: 500, net: "OUT" });
    const nets = buildNetlist(doc.schematic).pinNets;
    expect(nets.get(a.id)!.get("2")).toBe("OUT");
    expect(nets.get(b.id)!.get("1")).toBe("OUT");
  });
});

describe("exports", () => {
  it("writes well-formed, escaped SVG", () => {
    const doc = new Doc();
    doc.addPart("resistor", 0, 0);
    doc.schematic.texts.push({ id: "t", x: 0, y: 40, text: `a<b & "c"` });
    const svg = schematicToSvg(doc.schematic);
    expect(svg).toContain("&lt;b &amp; &quot;c&quot;");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("NaN");
  });

  it("writes CSV with real and AC columns", () => {
    const tran = simulate("t\nV1 a 0 DC 1\nR1 a 0 1k\n.end", { type: "op" });
    expect(resultToCsv(tran).split("\n")[0]).toBe("v(a),i(v1)");
    const ac = simulate("t\nV1 a 0 AC 1\nR1 a 0 1k\n.end", { type: "ac", sweep: "lin", points: 3, fstart: 1, fstop: 3 });
    const lines = resultToCsv(ac).trim().split("\n");
    expect(lines[0]).toContain("v(a) mag");
    expect(lines).toHaveLength(4);
  });
});
