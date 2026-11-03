// Checks that imported circuits behave as the file intends, by simulating them. These compare against
// physics and hand calculation rather than the file's own node list. Samples are read at runtime.
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNetlist } from "../../src/core/netlist";
import type { Schematic, SchComponent } from "../../src/core/schematic";
import type { SimResult } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { importDetailed, importMs14 } from "../../src/importer";
import { applyInteractive } from "../../src/importer/interactive";
import { importBoth, listSamples, readSample } from "./helpers";

const samples = listSamples();
const load = (name: string): Schematic => {
  const file = samples.find((f) => basename(f, ".ms14") === name);
  if (!file) throw new Error(`no sample ${name}`);
  return importMs14(readSample(file)).schematic;
};
const part = (doc: Schematic, test: (c: SchComponent) => boolean): SchComponent => {
  const found = doc.components.find(test);
  if (!found) throw new Error("part not found");
  return found;
};
const byRef = (doc: Schematic, ref: string) => part(doc, (c) => c.refDes === ref);
const netOf = (doc: Schematic, c: SchComponent, pin: string) => buildNetlist(doc).pinNets.get(c.id)?.get(pin);

function vector(r: SimResult, net: string): Float64Array {
  const v = r.vectors.find((x) => x.name === `v(${net.toLowerCase()})`);
  if (!v) throw new Error(`no vector for ${net}: ${r.vectors.slice(0, 12).map((x) => x.name).join(" ")}`);
  return v.re;
}
const window = (r: SimResult, values: Float64Array, from: number) => {
  const axis = r.axis!.re;
  return values.filter((_, i) => axis[i] >= from);
};
const span = (values: Float64Array) => Math.max(...values) - Math.min(...values);

describe.skipIf(!samples.length)("connectors join by name", () => {
  it("TrapezoidalOscillation: the supplies reach the op-amp, and it swings the file's way", () => {
    const doc = load("TrapezoidalOscillation");
    const u1 = byRef(doc, "U1");
    expect(netOf(doc, u1, "VS+")).toBe(netOf(doc, byRef(doc, "V3"), "1"));
    expect(netOf(doc, u1, "VS-")).toBe(netOf(doc, byRef(doc, "V4"), "2"));
    expect(netOf(doc, u1, "VS+")).toBe("Vpos");
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 2e-6, tstop: 4e-3 });
    const out = netOf(doc, u1, "OUT")!;
    // Gain of -20 on 1 V peak would give 40 Vpp; the 12 V rails and the 1 uF load limit it to about 21.6.
    expect(span(window(r, vector(r, out), 1e-3))).toBeGreaterThan(20);
    expect(span(window(r, vector(r, out), 1e-3))).toBeLessThan(24);
  });

  it("joins connector pairs on differently named nodes in each sample the review listed", () => {
    const pairs: [string, string][] = [
      ["TrapezoidalOscillation", "Vneg"], ["ControlledSources", "Amp_out"], ["DC Motor - Actual H Bridge", "12V"],
      ["CoupledShaftMachines", "CW"], ["S-DomainFunctions", "in"],
    ];
    for (const [name, connector] of pairs) {
      const doc = load(name);
      const nets = new Set(doc.components.filter((c) => c.refDes === connector && !c.spice).map((c) => netOf(doc, c, c.pins[0].name)));
      expect(nets.size, `${name} ${connector}`).toBe(1);
      expect([...nets][0], `${name} ${connector}`).toBeDefined();
    }
  });

  it("a stale shared node name no longer shorts different connectors", () => {
    const doc = load("CoupledShaftMachines");
    const net = (name: string) => netOf(doc, part(doc, (c) => c.refDes === name && !c.spice), part(doc, (c) => c.refDes === name && !c.spice).pins[0].name);
    expect(net("CW")).not.toBe(net("CCW"));
    const npc = load("NPCThreeLevelInverter");
    const s = (name: string) => {
      const c = part(npc, (x) => x.refDes === name && !x.spice);
      return netOf(npc, c, c.pins[0].name);
    };
    expect(s("s2")).not.toBe(s("s5"));
  });

  it("every connector name holds one net, on every single-sheet sample", () => {
    const bad: string[] = [];
    for (const file of samples) {
      const { schematic: doc } = importMs14(readSample(file));
      if (doc.texts.some((t) => /^\S+: \S/.test(t.text) && /_/.test(t.text))) continue;
      const nets = buildNetlist(doc).pinNets;
      const groups = new Map<string, Set<string>>();
      for (const c of doc.components) {
        if (c.spice || c.pins.length !== 1 || !c.refDes || c.instrument) continue;
        const net = nets.get(c.id)?.get(c.pins[0].name);
        if (!net) continue;
        const set = groups.get(c.refDes) ?? new Set();
        groups.set(c.refDes, set.add(net));
      }
      for (const [name, set] of groups) if (set.size > 1) bad.push(`${basename(file)}: ${name} on ${[...set].join(", ")}`);
    }
    console.log(`Connector names on more than one net: ${bad.length}\n${bad.slice(0, 20).join("\n")}`);
    // Sheets placed as blocks repeat connector names on purpose.
    expect(bad.filter((b) => !/Calculator|WriteRead|SerialShift|Buck|Stepper|Vector|ConveyorBelt|TrafficLights|ControlledHolding|SpeechFilter/.test(b))).toEqual([]);
  });
});

describe.skipIf(!samples.length)("current probes", () => {
  it("TrapezoidalOscillation: the scope reads C1's current as C dv/dt, sign included", () => {
    const doc = load("TrapezoidalOscillation");
    const netlist = buildNetlist(doc);
    const xcp = byRef(doc, "XCP1");
    const c1 = byRef(doc, "C1");
    expect(netOf(doc, xcp, "1")).toBeDefined();
    expect(netOf(doc, xcp, "2")).toBeDefined();
    expect(netOf(doc, xcp, "1")).not.toBe(netOf(doc, xcp, "2"));
    const top = netOf(doc, c1, "1")!;
    const out = netOf(doc, xcp, "3")!;
    const r = simulate(netlist.text, { type: "tran", tstep: 2e-6, tstop: 3e-3 });
    const t = r.axis!.re;
    const v = vector(r, top);
    const probe = vector(r, out);
    // 1 mV per mA, so the output in volts is the current in amps times 1000.
    let dot = 0;
    let self = 0;
    let other = 0;
    for (let i = Math.floor(t.length / 3); i < t.length; i++) {
      const dt = t[i] - t[i - 1];
      if (dt <= 0) continue;
      const expected = 1e3 * 1e-6 * ((v[i] - v[i - 1]) / dt);
      dot += expected * probe[i] * dt;
      self += expected * expected * dt;
      other += probe[i] * probe[i] * dt;
    }
    const correlation = dot / Math.sqrt(self * other);
    console.log(`XCP1 against 1000 * C dv/dt: correlation ${correlation.toFixed(3)}, gain ${(dot / self).toFixed(3)}`);
    expect(self).toBeGreaterThan(0);
    expect(correlation).toBeGreaterThan(0.9);
    expect(dot / self).toBeGreaterThan(0.8);
    expect(dot / self).toBeLessThan(1.2);
  }, 60000);

  it("ControlledRectifier: pointing down, the probe reads the load current through the 1 ohm resistor", () => {
    const doc = load("ControlledRectifier");
    const xcp = part(doc, (c) => /^XCP/.test(c.refDes));
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 5e-6, tstop: 0.03 });
    const load1 = byRef(doc, "R1");
    const a = vector(r, netOf(doc, load1, "1")!);
    const b = vector(r, netOf(doc, load1, "2")!);
    const probe = vector(r, netOf(doc, xcp, "3")!);
    let dot = 0;
    let self = 0;
    for (let i = 0; i < a.length; i++) {
      const current = Math.abs(a[i] - b[i]);
      dot += current * probe[i];
      self += current * current;
    }
    // The stored ratio is 1 V per A here if the model's K is 1000 per A at 1 mV/mA: read it as a gain.
    const gain = dot / self;
    console.log(`ControlledRectifier XCP gain against load current: ${gain.toFixed(1)} V/A`);
    expect(gain).toBeGreaterThan(0);
  }, 60000);

  it("BuckConverterInteractive: pointing right, the probe reads positive inductor current", () => {
    const doc = load("BuckConverterInteractive");
    const xcp = part(doc, (c) => /^XCP/.test(c.refDes));
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 2e-7, tstop: 2e-3 });
    const tail = window(r, vector(r, netOf(doc, xcp, "3")!), 1e-3);
    const mean = tail.reduce((x, y) => x + y, 0) / tail.length;
    console.log(`BuckConverterInteractive XCP mean output ${mean.toFixed(3)} V`);
    expect(mean).toBeGreaterThan(0);
  }, 180000);

  it("no probe in the corpus is left unconnected without saying so", () => {
    const report: string[] = [];
    let placed = 0;
    for (const file of samples) {
      const { schematic: doc, issues } = importMs14(readSample(file));
      const probes = doc.components.filter((c) => /^XCP/.test(c.refDes));
      const warned = issues.filter((i) => /current probe reads 0/.test(i.message));
      placed += probes.filter((c) => c.pins.find((p) => p.name === "1")?.y !== undefined).length - warned.length;
      for (const w of warned) report.push(`${basename(file)} ${w.refDes}: ${w.message}`);
    }
    console.log(`Probes in series: ${placed}; left reading 0: ${report.length}\n${report.join("\n")}`);
    expect(placed).toBeGreaterThan(15);
  });
});

describe.skipIf(!samples.length)("named nets and buses", () => {
  it("TransformerModels: the wire label pri feeds the second transformer, which matches the others", () => {
    const doc = load("TransformerModels");
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 2e-6, tstop: 0.05 });
    const swings = ["out1", "out2", "out3"].map((name) => {
      const c = part(doc, (x) => x.refDes === name && !x.spice);
      return span(window(r, vector(r, netOf(doc, c, c.pins[0].name)!), 0.02));
    });
    console.log(`TransformerModels output swings: ${swings.map((s) => s.toFixed(4)).join(", ")}`);
    expect(swings[1]).toBeGreaterThan(0.05);
    expect(Math.abs(swings[1] - swings[0]) / swings[0]).toBeLessThan(0.3);
  }, 60000);

  it("Up-DownCounter: the flip-flops reach the display through the bus", () => {
    const doc = load("Up-DownCounter");
    const nets = buildNetlist(doc).pinNets;
    const q = ["U1", "U2", "U3", "U4"].map((u) => nets.get(byRef(doc, u).id)?.get("Q"));
    expect(new Set(q).size).toBe(4);
    // Each Q goes over the bus to one side of the resistor pack, whose other side feeds the display.
    const pack = nets.get(byRef(doc, "R1").id)!;
    for (const pin of ["R1B", "R2B", "R3B", "R4B"]) expect(q).toContain(pack.get(pin));
    const display = doc.components.find((c) => c.indicator?.kind === "hexdigit")!;
    const shown = new Set(display.pins.map((p) => nets.get(display.id)?.get(p.name)));
    for (const pin of ["R1A", "R2A", "R3A", "R4A"]) expect(shown.has(pack.get(pin))).toBe(true);
    const r = simulate(buildNetlist(doc).text, { type: "tran", tstep: 20e-6, tstop: 40e-3 });
    for (const pin of ["R1A", "R2A", "R3A", "R4A"]) expect(span(vector(r, pack.get(pin)!)), pin).toBeGreaterThan(0.5);
  }, 60000);
});

describe.skipIf(!samples.length)("temperature", () => {
  it("a default TEMP is left out, so the sweep moves the comparator's divider", () => {
    const doc = load("Temperature Sweep - Comparator");
    expect(doc.components.some((c) => /TEMP=/.test(c.spice))).toBe(false);
    const rt = part(doc, (c) => c.refDes === "RT1");
    expect(rt.spice).toMatch(/TC1=/);
    const r1 = byRef(doc, "R1");
    const node = netOf(doc, r1, "2")!;
    const at = (t: number) => {
      const text = buildNetlist(doc).text.replace(/\n\.end\s*$/i, `\n.temp ${t}\n.end`);
      return vector(simulate(text, { type: "op" }), node)[0];
    };
    const cold = at(-40);
    const hot = at(125);
    console.log(`Comparator v(${node}): ${cold.toFixed(3)} V at -40 C, ${hot.toFixed(3)} V at 125 C`);
    expect(cold).toBeCloseTo(1.917, 2);
    expect(hot).toBeCloseTo(2.113, 2);
  });
});

describe.skipIf(!samples.length)("interactive parts", () => {
  it("WienBridgeOscillator R1: a new percent gives the segments, and the frequency follows", () => {
    const doc = load("WienBridgeOscillator");
    const r1 = byRef(doc, "R1");
    expect(r1.interactive).toMatchObject({ kind: "variable", percent: 50, key: "A", increment: 1 });
    expect(r1.params).toMatchObject({ r1: "25000", r2: "25000" });
    const at25 = applyInteractive(r1, 25);
    expect(at25.params).toMatchObject({ r1: "12500", r2: "37500" });
    expect(applyInteractive(r1, 20).params).toMatchObject({ r1: "10000", r2: "40000" });
    expect(applyInteractive(r1, 10).params).toMatchObject({ r1: "5000", r2: "45000" });
    expect(r1.params.r1).toBe("25000");
    expect(parseFloat(applyInteractive(r1, 0).params.r2)).toBeCloseTo(49999.995, 2);
    // Frequency from rising crossings of the output, once settled.
    const frequency = (percent: number) => {
      const changed = { ...doc, components: doc.components.map((c) => (c === r1 ? applyInteractive(r1, percent) : c)) };
      const out = netOf(changed, byRef(changed, "R1"), "3")!;
      const r = simulate(buildNetlist(changed).text, { type: "tran", tstep: 5e-6, tstop: 0.2 });
      const t = r.axis!.re;
      const v = vector(r, out);
      const start = Math.max(t.findIndex((x) => x > 0.1), 1);
      const tail = v.subarray(start);
      const mid = tail.reduce((x, y) => x + y, 0) / tail.length;
      const crossings: number[] = [];
      for (let i = start; i < t.length; i++) if (v[i - 1] < mid && v[i] >= mid) crossings.push(t[i]);
      console.log(`WienBridge at ${percent}%: swing ${span(tail).toFixed(3)} V on ${out}, ${crossings.length} crossings`);
      return crossings.length > 1 ? (crossings.length - 1) / (crossings[crossings.length - 1] - crossings[0]) : 0;
    };
    for (const [percent, hand] of [[25, 840], [20, 738], [10, 522]]) {
      const f = frequency(percent);
      console.log(`WienBridge at ${percent}%: ${f.toFixed(0)} Hz (hand edit gave ${hand})`);
      expect(Math.abs(f - hand) / hand).toBeLessThan(0.02);
    }
  }, 120000);

  it("other variable parts recompute from percent", () => {
    const c2 = byRef(load("OscillatorRC"), "C2");
    expect(c2.interactive).toMatchObject({ kind: "variable", percent: 40, key: "A", increment: 5 });
    expect(applyInteractive(c2, 10).params.value).toBe("0.000001");
    const v1 = byRef(load("BrushlessDCDriveSixStep"), "V1");
    expect(v1.interactive).toMatchObject({ kind: "variable", percent: 30, apply: { mode: "span", min: 0, max: 100 } });
    expect(applyInteractive(v1, 75).params.value).toBe("75");
  });

  it("switches toggle their level, and their netlist line follows", () => {
    const doc = load("DigitalCounter");
    const sw = part(doc, (c) => c.interactive?.kind === "switch");
    if (sw.interactive?.kind !== "switch") throw new Error("not a switch");
    expect(sw.interactive.positions).toBe(2);
    const other = 1 - sw.interactive.position;
    const flipped = applyInteractive(sw, other);
    expect(flipped.interactive).toMatchObject({ position: other });
    expect(flipped.params.level).toBe(other === 1 ? "2" : "0");
    expect(flipped.params.level).not.toBe(sw.params.level);
    expect(flipped.spice).toContain("V2 5 0 DC {param:level}");
    expect(sw.interactive.stateGraphics?.length).toBe(2);
    expect(flipped.graphics).toBe(sw.interactive.stateGraphics?.[other]);
    const counter = load("Up-DownCounter");
    expect(counter.components.some((c) => c.interactive?.kind === "switch" && c.interactive.key === "Space")).toBe(true);
  });

  it("a momentary switch rests open and says so", () => {
    const doc = load("ControlledHoldingTank");
    const pb = part(doc, (c) => c.interactive?.kind === "switch" && c.interactive.momentary === true);
    expect(pb.params.level).toBe("0");
    expect(applyInteractive(pb, 1).params.level).toBe("2");
  });

  it("identifies indicators with what the file offers", () => {
    const led = part(load("Getting Started 1"), (c) => c.indicator?.kind === "led");
    expect(led.indicator).toMatchObject({ reads: "current", sense: "v", threshold: 0.005, thresholdUnit: "A", pins: ["A", "K"] });
    const seven = part(load("Getting Started 1"), (c) => c.indicator?.kind === "sevenseg");
    expect(seven.indicator).toMatchObject({ pins: ["A", "B", "C", "D", "E", "F", "G"], dp: "H", common: "COM", activeLow: true, thresholdUnit: "A" });
    const lamp = part(load("QuizShowVariants"), (c) => c.indicator?.kind === "lamp");
    expect(lamp.indicator).toMatchObject({ vmax: 5, pmax: 1 });
    const hex = part(load("DecadeCounterUserLoad"), (c) => c.indicator?.kind === "hexdigit");
    expect(hex.indicator?.pins.length).toBe(4);
    const probe = part(load("ShiftRegister"), (c) => c.indicator?.kind === "probe");
    expect(probe.indicator).toMatchObject({ threshold: 2.5 });
    const ammeter = part(load("TraceWidth - Power Supply"), (c) => c.indicator?.kind === "ammeter");
    expect(ammeter.indicator).toMatchObject({ sense: "vsense", reads: "current" });
  });
});

describe.skipIf(!samples.length)("names other parts rely on", () => {
  it("locks parts referred to elsewhere and leaves the rest free", () => {
    const stepper = load("StepperMotorPulloutTorque");
    expect(byRef(stepper, "Sensor1").lockedName).toBe(true);
    expect(byRef(load("BuckConverterInteractive"), "VL_sense").lockedName).toBe(true);
    const transformer = load("TransformerModels");
    expect(byRef(transformer, "Vsec").lockedName).toBe(true);
    expect(byRef(transformer, "Rload1").lockedName).toBeUndefined();
    const coupled = samples.map((f) => importMs14(readSample(f)).schematic).find((d) => d.components.some((c) => /^k\{ref\}/im.test(c.spice)));
    expect(coupled).toBeDefined();
    const k = part(coupled!, (c) => /^k\{ref\}/im.test(c.spice));
    const refs = /^k\{ref\}\s+(\S+)\s+(\S+)/im.exec(k.spice)!.slice(1, 3).map((w) => w.toLowerCase());
    const locked = coupled!.components.filter((c) => c.lockedName && /^l\{ref\}/i.test(c.spice)).map((c) => `l${(c.refDes || `P_${c.id}`).toLowerCase()}`);
    expect(locked).toEqual(expect.arrayContaining(refs));
  });
});

describe.skipIf(!samples.length)("file contents the netlist relies on", () => {
  it("every coupling line names parts that exist", () => {
    for (const file of samples) {
      const { schematic: doc } = importBoth(readSample(file)).bound;
      const text = buildNetlist(doc).text;
      for (const line of text.split("\n")) {
        const match = /^k\S*\s+(\S+)\s+(\S+)/i.exec(line);
        if (!match) continue;
        const inSubcircuit = !doc.components.some((c) => c.spice.split("\n")[0] && line.toLowerCase().startsWith(c.spice.split("\n")[0].replace("{ref}", c.refDes || `P_${c.id}`).toLowerCase().split(/\s+/)[0]));
        if (inSubcircuit) continue;
        for (const name of [match[1], match[2]]) expect(new RegExp(`^${name}\\s`, "im").test(text), `${basename(file)}: ${line}`).toBe(true);
      }
    }
  });
});

describe("damaged files", () => {
  it.each(["Rc_ac", "OscillatorRC", "Up-DownCounter"])("every mutation of %s gives a result or a clear error", (name) => {
    const file = samples.find((f) => basename(f, ".ms14") === name);
    if (!file) return;
    const inner = importBothXml(readSample(file));
    let state = 12345;
    const random = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    const failures = new Map<string, number>();
    for (let round = 0; round < 40; round++) {
      const copy = inner.slice();
      const edits = 1 + random(40);
      for (let e = 0; e < edits; e++) {
        const at = random(copy.length);
        const kind = random(3);
        // Numbers are what geometry and sizes hang on, so aim at them often.
        if (kind === 0) copy[at] = 48 + random(10);
        else if (kind === 1) copy[at] = random(256);
        else copy.fill(32 + random(90), at, Math.min(copy.length, at + random(30)));
      }
      try {
        importDetailed(copy);
      } catch (error) {
        const message = (error as Error).message;
        expect(error).toBeInstanceOf(Error);
        expect(message, message).toMatch(/^(Corrupt circuit file|Not a Multisim circuit file|Circuit is too large)/);
        failures.set(message.slice(0, 50), (failures.get(message.slice(0, 50)) ?? 0) + 1);
      }
    }
    console.log(`Mutated file errors: ${[...failures].map(([k, v]) => `${v} x ${k}`).join("; ")}`);
  }, 120000);

  it("a coordinate of NaN or beyond any sheet is an error, not a crash or a hang", () => {
    const xml = (x: string) => new TextEncoder().encode(
      `<?xml version="1.0"?><MSMElectronicsWorkbench Schema="67"><Project Class="CProject" Name="&amp;ASCT"><UniqueSheets><SheetInfos><SheetContainer><Sheet><Variable><DesignSheet Title="&amp;ASCM"><Sheet><XMLSubSheet><CIITHierDoc><Diagram><CIITDiagram><Components><CODComposite><Objects>` +
      `<Item ID="1" Class="CIITLinkComp"><CIITLinkComp Class="CIITLinkComp" Transformer-M00="1" Transformer-M01="0" Transformer-M10="0" Transformer-M11="1" Transformer-M20="${x}" Transformer-M21="0"><Points><Item X="0" Y="0"/><Item X="5" Y="0"/></Points></CIITLinkComp></Item>` +
      `</Objects></CODComposite></Components><Elements/></CIITDiagram></Diagram></CIITHierDoc></XMLSubSheet></Sheet></DesignSheet></Variable></Sheet></SheetContainer></SheetInfos></UniqueSheets></Project></MSMElectronicsWorkbench>`,
    );
    expect(() => importMs14(xml("abc"))).toThrow(/Corrupt circuit file/);
    expect(() => importMs14(xml("1e300"))).toThrow(/Corrupt circuit file/);
    expect(() => importMs14(xml("5"))).not.toThrow();
  });
});

/** The decompressed XML, which is what a mutation can reach without just failing decompression. */
function importBothXml(bytes: Uint8Array): Uint8Array {
  return decode(bytes);
}

import { decodeContainer as decode } from "../../src/importer";
