import { describe, expect, it } from "vitest";
import { indicatorVectors, readIndicator } from "../../src/core/indicators";
import type { IndicatorSpec, SchComponent } from "../../src/core/schematic";
import type { SimResult } from "../../src/core/sim";

const result = (values: Record<string, number>): SimResult => ({
  analysis: "op",
  vectors: Object.entries(values).map(([name, value]) => ({ name, unit: "V", re: Float64Array.of(value) })),
  warnings: [], stats: { unknowns: 0, iterations: 0, steps: 0, elapsedMs: 0 },
});

const part = (indicator: IndicatorSpec | undefined, kind = "imported"): SchComponent => ({
  id: "c", refDes: "D1", kind, x: 0, y: 0, rotation: 0, mirrored: false, params: {}, pins: [], spice: "", indicator,
});

const nets = (map: Record<string, string>) => new Map(Object.entries(map));

describe("indicators", () => {
  it('animates machine state from the latest simulation outputs with physical units',()=>{
    const tank=part({kind:'voltmeter',pins:['LEVEL','GND'],reads:'voltage'},'holding-tank');tank.params.capacity='10';
    expect(readIndicator(tank,result({'v(level)':4}),nets({LEVEL:'level',GND:'0'}),'X1')).toEqual({machine:{kind:'tank',fraction:0.4},text:'4 L'});
    const belt=part({kind:'voltmeter',pins:['POSITION','GND'],reads:'voltage'},'conveyor');belt.params.length='5';
    expect(readIndicator(belt,result({'v(position)':2}),nets({POSITION:'position',GND:'0'}),'X2')).toEqual({machine:{kind:'conveyor',fraction:0.4},text:'2 m'});
    expect(readIndicator(tank,result({}),nets({LEVEL:'level',GND:'0'}),'X1')).toBeUndefined();
  });
  it("lights a library LED only when forward biased", () => {
    const led = part(undefined, "led");
    const n = nets({ A: "a", K: "0" });
    expect(readIndicator(led, result({ "v(a)": 2 }), n, "D1")).toEqual({ glow: 1 });
    expect(readIndicator(led, result({ "v(a)": 0.5 }), n, "D1")).toEqual({ glow: 0 });
    expect(indicatorVectors(led, n, "D1")).toEqual(["v(a)"]);
  });

  it("reads an imported LED by its current", () => {
    const led = part({ kind: "led", pins: ["1", "2"], reads: "current", sense: "v", threshold: 5e-3, thresholdUnit: "A" });
    const n = nets({ "1": "a", "2": "0" });
    expect(readIndicator(led, result({ "i(xd1.v)": 6e-3, "v(a)": 2 }), n, "D1")).toEqual({ glow: 1 });
    expect(readIndicator(led, result({ "i(xd1.v)": 1e-3, "v(a)": 2 }), n, "D1")).toEqual({ glow: 0 });
    expect(indicatorVectors(led, n, "D1")).toContain("i(xd1.v)");
    // With no reading for its sense it stays unknown instead of guessing from voltage.
    expect(readIndicator(led, result({ "v(a)": 2 }), n, "D1")).toBeUndefined();
  });

  it("decodes seven-segment digits from segment currents", () => {
    const pins = ["A", "B", "C", "D", "E", "F", "G"];
    const senses = ["v1", "v2", "v3", "v4", "v5", "v6", "v7"];
    const display = part({ kind: "sevenseg", pins, senses, dpSense: "v8", reads: "current", threshold: 5e-3, thresholdUnit: "A", common: "COM", activeLow: true });
    const levels = (on: string, point = false) => ({
      ...Object.fromEntries(pins.map((p, i) => [`i(xu1.${senses[i]})`, on.includes(p) ? 8e-3 : 0])),
      "i(xu1.v8)": point ? 8e-3 : 0,
    });
    const shows = (on: string, point = false) => readIndicator(display, result(levels(on, point)), nets({}), "U1")?.text;
    expect(shows("ABCDEF")).toBe("0");
    expect(shows("BC")).toBe("1");
    expect(shows("ABDEG")).toBe("2");
    expect(shows("ABCFG")).toBe("9");
    expect(shows("ABCDFG")).toBe("9");
    expect(shows("CDEFG")).toBe("6");
    expect(shows("ACDEFG")).toBe("6");
    expect(shows("")).toBe("");
    expect(shows("BC", true)).toBe("1.");
    expect(shows("AD")).toBe("-");
    expect(indicatorVectors(display, nets({}), "U1")).toContain("i(xu1.v8)");
  });

  it("decodes a hex digit by bit weight", () => {
    const display = part({ kind: "hexdigit", pins: ["1", "2", "3", "4"], reads: "voltage", threshold: 2.5, thresholdUnit: "V" });
    const n = nets({ "1": "a", "2": "b", "3": "c", "4": "d" });
    expect(readIndicator(display, result({ "v(a)": 5, "v(b)": 0, "v(c)": 5, "v(d)": 5 }), n, "U1")).toEqual({ text: "D" });
    expect(readIndicator(display, result({ "v(a)": 0, "v(b)": 0, "v(c)": 0, "v(d)": 0 }), n, "U1")).toEqual({ text: "0" });
  });

  it("shows nothing rather than guessing when a value is missing", () => {
    expect(readIndicator(part({ kind: "hexdigit", pins: ["1"], reads: "voltage" }), result({}), nets({ "1": "a" }), "U1")).toBeUndefined();
    expect(readIndicator(part({ kind: "ammeter", pins: ["1", "2"], reads: "current" }), result({}), nets({}), "U1")).toBeUndefined();
    expect(readIndicator(part({ kind: "sevenseg", pins: [], senses: ["v1"], reads: "current" }), result({ "i(xu1.v1)": 1 }), nets({}), "U1")).toBeUndefined();
  });

  it("scales a lamp's glow by its rating and shows meter text", () => {
    const n = nets({ "1": "a", "2": "0" });
    expect(readIndicator(part({ kind: "lamp", pins: ["1", "2"], reads: "voltage", vmax: 12 }), result({ "v(a)": 6 }), n, "X1")).toEqual({ glow: 0.5 });
    expect(readIndicator(part({ kind: "voltmeter", pins: ["1", "2"], reads: "voltage" }), result({ "v(a)": 3.3333 }), n, "U1")).toEqual({ text: "3.33 V" });
  });

  it("reads an imported ammeter from its sense source, in AC or DC", () => {
    const n = 4000;
    const time = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 10e-3);
    const wave = time.map((t) => 5e-3 + 10e-3 * Math.sin(2 * Math.PI * 1000 * t));
    const run: SimResult = {
      analysis: "tran", axis: { name: "time", unit: "s", re: time },
      vectors: [{ name: "i(xu1.vsense)", unit: "A", re: wave }],
      warnings: [], stats: { unknowns: 0, iterations: 0, steps: 0, elapsedMs: 0 },
    };
    const spec = (mode: "ac" | "dc"): IndicatorSpec => ({ kind: "ammeter", pins: ["1", "2"], reads: "current", sense: "vsense", mode });
    expect(readIndicator(part(spec("dc")), run, nets({}), "U1")).toEqual({ text: "5 mA" });
    expect(readIndicator(part(spec("ac")), run, nets({}), "U1")).toEqual({ text: "7.07 mA" });
  });
});
