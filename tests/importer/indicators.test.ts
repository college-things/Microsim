// Displays and meters, decoded from real sample simulations using only what IndicatorSpec promises.
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNetlist } from "../../src/core/netlist";
import type { IndicatorSpec, SchComponent, Schematic } from "../../src/core/schematic";
import type { SimResult } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { importMs14 } from "../../src/importer";
import { applyInteractive, normalizeKey, validateImportedParam } from "../../src/importer/interactive";
import { listSamples, readSample } from "./helpers";

const samples = listSamples();
const load = (name: string): Schematic => {
  const file = samples.find((f) => basename(f, ".ms14") === name);
  if (!file) throw new Error(`no sample ${name}`);
  return importMs14(readSample(file)).schematic;
};
const allDocs = () => samples.map((f) => ({ name: basename(f, ".ms14"), doc: importMs14(readSample(f)).schematic }));

function reader(doc: Schematic, r: SimResult) {
  const built = buildNetlist(doc);
  const named = new Map(r.vectors.map((v) => [v.name, v.re]));
  return {
    volts(c: SchComponent, pin: string): Float64Array | number {
      const net = built.pinNets.get(c.id)?.get(pin);
      if (!net || net === "0") return 0;
      const v = named.get(`v(${net.toLowerCase()})`);
      if (!v) throw new Error(`no v(${net})`);
      return v;
    },
    current(c: SchComponent, sense: string): Float64Array {
      const name = `i(x${built.refs.get(c.id)}.${sense})`.toLowerCase();
      const v = named.get(name);
      if (!v) throw new Error(`no ${name}: ${[...named.keys()].filter((k) => k.startsWith("i(")).slice(0, 12).join(" ")}`);
      return v;
    },
  };
}
const at = (v: Float64Array | number, i: number) => (typeof v === "number" ? v : v[i]);

/** Reads a digit using the contract alone: pins are least significant first. */
function hexTrace(doc: Schematic, r: SimResult, c: SchComponent): number[] {
  const read = reader(doc, r);
  const spec = c.indicator!;
  const bits = spec.pins.map((p) => read.volts(c, p));
  const out: number[] = [];
  for (let i = 0; i < r.axis!.re.length; i++) {
    let value = 0;
    bits.forEach((b, weight) => {
      if (at(b, i) >= spec.threshold!) value += 2 ** weight;
    });
    if (out[out.length - 1] !== value) out.push(value);
  }
  return out;
}

const DIGITS: Record<string, number> = {
  "1111110": 0, "0110000": 1, "1101101": 2, "1111001": 3, "0110011": 4, "1011011": 5, "1011111": 6, "1110000": 7, "1111111": 8, "1111011": 9, "1110011": 9, "0011111": 6,
};

function sevenTrace(doc: Schematic, r: SimResult, c: SchComponent): string[] {
  const read = reader(doc, r);
  const spec = c.indicator!;
  const senses = spec.senses!.map((s) => read.current(c, s));
  const out: string[] = [];
  for (let i = 0; i < r.axis!.re.length; i++) {
    const pattern = senses.map((s) => (s[i] >= spec.threshold! ? "1" : "0")).join("");
    if (out[out.length - 1] !== pattern) out.push(pattern);
  }
  return out;
}

const hasRun = (values: number[], run: number[]) => values.join(",").includes(run.join(","));

describe.skipIf(!samples.length)("display pins", () => {
  it("covers every display with data pins only, in order", () => {
    let hex = 0;
    let seven = 0;
    for (const { name, doc } of allDocs()) {
      for (const c of doc.components) {
        const spec = c.indicator as IndicatorSpec | undefined;
        if (spec?.kind === "hexdigit") {
          hex++;
          expect(spec.pins, `${name} ${c.id}`).toEqual(["1", "2", "3", "4"]);
          expect(spec.thresholdUnit).toBe("V");
          expect(spec.threshold).toBeGreaterThan(0);
        }
        if (spec?.kind === "sevenseg") {
          seven++;
          expect(spec.pins).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
          expect(spec.senses).toEqual(["v1", "v2", "v3", "v4", "v5", "v6", "v7"]);
          expect(spec).toMatchObject({ dp: "H", dpSense: "v8", common: "COM", activeLow: true, thresholdUnit: "A", threshold: 0.005 });
        }
        // Whatever the kind, a supply pin is never data.
        for (const pin of spec?.pins ?? []) expect(pin).not.toMatch(/^(VCC|GND|VDD|VSS|COM)$/i);
      }
    }
    expect(hex).toBe(48);
    expect(seven).toBe(3);
  });

  it("the driven resistor-load display lights a bit at 2.5 V, as 5 mA through its 500 ohms", () => {
    const c = load("DecadeCounterUserLoad").components.find((x) => x.indicator?.kind === "hexdigit")!;
    expect(c.indicator).toMatchObject({ threshold: 2.5, thresholdUnit: "V", reads: "voltage" });
  });

  it("Up-DownCounter counts 1 2 3 ... F 0 on its display", () => {
    const doc = load("Up-DownCounter");
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 20e-6, tstop: 40e-3 });
    const c = doc.components.find((x) => x.indicator?.kind === "hexdigit")!;
    const trace = hexTrace(doc, r, c);
    console.log(`Up-DownCounter display: ${trace.slice(0, 22).map((d) => d.toString(16).toUpperCase()).join(" ")}`);
    expect(hasRun(trace, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0])).toBe(true);
  }, 120000);

  it("DigitalCounter's running display counts in weight order", () => {
    const doc = load("DigitalCounter");
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 50e-6, tstop: 15e-3 });
    const traces = doc.components.filter((x) => x.indicator?.kind === "hexdigit").map((c) => hexTrace(doc, r, c));
    expect(traces.some((t) => hasRun(t, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(true);
  }, 120000);

  // The 8052 in this sample has no firmware to run here, so nothing counts: the check is the pin contract.
  it("HextoDecimal's displays leave out their supply pins, so an idle digit is at most F", () => {
    const doc = load("HextoDecimal");
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 50e-6, tstop: 20e-3 });
    const displays = doc.components.filter((x) => x.indicator?.kind === "hexdigit");
    expect(displays.length).toBeGreaterThan(0);
    const traces = displays.map((c) => hexTrace(doc, r, c));
    console.log(`HextoDecimal displays: ${traces.map((t) => t.slice(0, 18).map((d) => d.toString(16).toUpperCase()).join(" ")).join(" | ")}`);
    for (const c of displays) expect(c.pins.map((p) => p.name)).toEqual(expect.arrayContaining(["VCC", "GND"]));
    for (const t of traces) for (const d of t) expect(d).toBeLessThan(16);
  }, 120000);

  it("Getting Started Final's seven-segment display counts digit by digit once enabled", () => {
    const start = load("Getting Started Final");
    // As saved the counter is held. Key E and key L select its enable and load, as the sheet's labels say.
    const nets = buildNetlist(start).pinNets;
    const select = (key: string, net: string) => (c: SchComponent): SchComponent => {
      if (c.interactive?.kind !== "switch" || c.interactive.key !== key) return c;
      // Pin 1 is the contact that is closed at position 0, pin 3 the other.
      return applyInteractive(c, nets.get(c.id)?.get("1") === net ? 0 : 1);
    };
    const doc = { ...start, components: start.components.map((c) => select("L", "VCC")(select("E", "0")(c))) };
    expect(start.components.filter((c) => c.interactive?.kind === "switch").map((c) => c.interactive?.key).sort()).toEqual(["E", "L"]);
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 20e-6, tstop: 30e-3 });
    const c = doc.components.find((x) => x.indicator?.kind === "sevenseg")!;
    const trace = sevenTrace(doc, r, c);
    const digits = trace.map((p) => DIGITS[p]);
    const shown = `patterns ${trace.slice(0, 14).join(" ")}; digits ${digits.slice(0, 24).join(" ")}`;
    expect(digits.every((d) => d !== undefined), shown).toBe(true);
    expect(digits.length, shown).toBeGreaterThan(12);
    for (let i = 1; i < digits.length; i++) expect((digits[i]! - digits[i - 1]! + 10) % 10, shown).toBe(1);
    expect(new Set(digits).size, shown).toBe(10);
  }, 180000);
});

describe.skipIf(!samples.length)("keys", () => {
  it("every part showing a key on its sheet has it", () => {
    const missing: string[] = [];
    const forms = new Map<string, number>();
    let shown = 0;
    for (const { name, doc } of allDocs()) {
      for (const c of doc.components) {
        const key = c.interactive?.key;
        if (key) forms.set(key, (forms.get(key) ?? 0) + 1);
        const label = /\bKey\s*=\s*(\S+)/i.exec(c.displayValue ?? "");
        if (!label) continue;
        shown++;
        if (!c.interactive) missing.push(`${name} ${c.refDes || c.id}: no interactive at all`);
        else if (key !== normalizeKey(label[1])) missing.push(`${name} ${c.refDes || c.id}: shows ${label[1]}, has ${key}`);
      }
    }
    console.log(`Parts showing a key: ${shown}. Forms: ${[...forms].map(([k, v]) => `${k}=${v}`).join(" ")}\nMissing: ${missing.join("; ") || "none"}`);
    expect(shown).toBeGreaterThan(50);
    expect(missing).toEqual([]);
    for (const key of forms.keys()) expect(key).toMatch(/^([A-Z0-9]|Space)$/);
  });

  it("the space bar's forms all normalise", () => {
    expect(normalizeKey(" ")).toBe("Space");
    expect(normalizeKey("Space")).toBe("Space");
    expect(normalizeKey("space ")).toBe("Space");
    expect(normalizeKey("a")).toBe("A");
    expect(normalizeKey("Param")).toBeUndefined();
    expect(normalizeKey("")).toBeUndefined();
    const debounce = load("SwitchDebounce").components.filter((c) => c.interactive?.kind === "switch");
    expect(debounce.some((c) => c.interactive?.key === "Space")).toBe(true);
    expect(load("TrafficLights").components.some((c) => c.interactive?.kind === "switch" && c.interactive.key === "Space")).toBe(true);
  });
});

describe.skipIf(!samples.length)("momentary switches", () => {
  it("are set on push buttons, rest released, and only there", () => {
    const report: string[] = [];
    for (const { name, doc } of allDocs()) {
      for (const c of doc.components) {
        if (c.interactive?.kind !== "switch" || !c.interactive.momentary) continue;
        report.push(`${name} ${c.refDes || c.id} key ${c.interactive.key}`);
        expect(c.interactive.position).toBe(0);
        expect(c.params.level).toBe("0");
        expect(applyInteractive(c, 1).params.level).not.toBe("0");
      }
    }
    console.log(`Momentary: ${report.length}\n${report.join("\n")}`);
    for (const name of ["QuizShowVariants", "ControlledHoldingTank", "WatchdogTimerWakeup", "TrafficLights"]) {
      expect(report.some((r) => r.startsWith(`${name} `)), name).toBe(true);
    }
    // A toggle switch, by contrast.
    const toggles = load("Up-DownCounter").components.filter((c) => c.interactive?.kind === "switch");
    expect(toggles.every((c) => c.interactive?.kind === "switch" && !c.interactive.momentary)).toBe(true);
  });

  it("position 0 is the released contact: a normally closed button conducts at rest", () => {
    const doc = load("ControlledHoldingTank");
    const pb = doc.components.find((c) => c.interactive?.kind === "switch" && c.interactive.momentary && /NC_contact/.test(c.spice))!;
    expect(pb).toBeDefined();
    expect(pb.params.level).toBe("0");
    expect(pb.spice).toMatch(/^V2 5 0 DC \{param:level\}$/m);
  });
});

describe.skipIf(!samples.length)("current and voltage readings", () => {
  it("TraceWidth's ammeters read through a vector the engine has, and match the circuit", () => {
    const doc = load("TraceWidth - Power Supply");
    const meters = doc.components.filter((c) => c.indicator?.kind === "ammeter");
    expect(meters.length).toBe(2);
    expect(meters.map((c) => c.indicator!.mode).sort()).toEqual(["ac", "dc"]);
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 1e-5, tstop: 0.05 });
    const read = reader(doc, r);
    for (const c of meters) {
      const trace = read.current(c, c.indicator!.sense!);
      const tail = trace.slice(Math.floor(trace.length / 2));
      const rms = Math.sqrt(tail.reduce((s, v) => s + v * v, 0) / tail.length);
      const mean = tail.reduce((s, v) => s + v, 0) / tail.length;
      console.log(`TraceWidth ${c.refDes || c.id} ${c.indicator!.mode}: mean ${mean.toFixed(4)} A, rms ${rms.toFixed(4)} A`);
      expect(rms).toBeGreaterThan(0.001);
    }
  }, 120000);

  it("an ammeter in a known loop reads V/R with the right sign", () => {
    const doc = load("TraceWidth - Power Supply");
    const meter = doc.components.find((c) => c.indicator?.kind === "ammeter")!;
    const built = buildNetlist({ ...doc, components: [meter], wires: [], labels: [] });
    const body = built.text.split("\n").filter((l) => !/^\*/.test(l) && !/^\.end\s*$/i.test(l)).join("\n");
    const ref = built.refs.get(meter.id)!;
    const a = built.pinNets.get(meter.id)?.get(meter.indicator!.pins[0]) ?? `nc_${ref}_${meter.indicator!.pins[0]}`;
    const b = built.pinNets.get(meter.id)?.get(meter.indicator!.pins[1]) ?? `nc_${ref}_${meter.indicator!.pins[1]}`;
    const text = `* loop\n${body}\nVs ${a} 0 DC 10\nRload ${b} 0 2k\n.end\n`;
    const r = simulate(text, { type: "op" });
    const i = r.vectors.find((v) => v.name === `i(x${ref}.vsense)`.toLowerCase())!;
    expect(i).toBeDefined();
    expect(i.re[0]).toBeCloseTo(0.005, 6);
  });

  it("LED sense vectors exist on real samples, and read forward current", () => {
    const doc = load("Getting Started 1");
    const r = simulate(buildNetlist(doc).text, { type: "op" });
    const read = reader(doc, r);
    const leds = doc.components.filter((c) => c.indicator?.kind === "led");
    expect(leds.length).toBeGreaterThan(0);
    for (const c of leds) expect(Number.isFinite(read.current(c, c.indicator!.sense!)[0])).toBe(true);
    for (const c of doc.components.filter((x) => x.indicator?.kind === "sevenseg")) {
      for (const s of [...c.indicator!.senses!, c.indicator!.dpSense!]) expect(Number.isFinite(read.current(c, s)[0])).toBe(true);
    }
  });

  it("the sense vector also exists for a part whose name the file hides", () => {
    for (const { name, doc } of allDocs()) {
      const hidden = doc.components.find((c) => !c.refDes && c.indicator?.reads === "current" && (c.indicator.sense || c.indicator.senses));
      if (!hidden) continue;
      const r = simulate(buildNetlist(doc).text, { type: "op" });
      const sense = hidden.indicator!.sense ?? hidden.indicator!.senses![0];
      expect(Number.isFinite(reader(doc, r).current(hidden, sense)[0]), name).toBe(true);
      return;
    }
  });

  it("a lamp reads across its two pins", () => {
    const doc = load("QuizShowVariants");
    const lamps = doc.components.filter((c) => c.indicator?.kind === "lamp");
    expect(lamps.length).toBe(6);
    expect(lamps[0].indicator).toMatchObject({ pins: ["1", "2"], reads: "voltage" });
  });
});

describe("typed values", () => {
  const part: SchComponent = {
    id: "c1", refDes: "R1", kind: "imported", x: 0, y: 0, rotation: 0, mirrored: false, pins: [], spice: "",
    params: { p1: "1k", shape: "sine", p2: "{Rload}" },
    paramLabels: { p1: "Resistance" },
  };

  it("accepts numbers and expressions", () => {
    for (const value of ["1k", "4.7n", "2Meg", "1e-3", "-5", "10mil", "{2*R}"]) {
      expect(validateImportedParam(part, "p1", value), value).toBeUndefined();
    }
    expect(validateImportedParam(part, "p2", "22")).toBeUndefined();
  });

  it("explains what is wrong", () => {
    expect(validateImportedParam(part, "p1", "abc")).toMatch(/Resistance: "abc" is not a number/);
    expect(validateImportedParam(part, "p1", "")).toMatch(/needs a value/);
    expect(validateImportedParam(part, "p1", "{}")).toMatch(/braces are empty/);
    expect(validateImportedParam(part, "p1", "1k\nV1 a 0 1")).toMatch(/line breaks/);
    expect(validateImportedParam(part, "p1", "2M")).toMatch(/2Meg for mega/);
    expect(validateImportedParam(part, "p2", "abc")).toMatch(/not a number/);
  });

  it("leaves non-numeric settings alone", () => {
    expect(validateImportedParam(part, "shape", "square")).toBeUndefined();
  });
});
