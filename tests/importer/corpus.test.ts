// Reads the installed sample circuits at runtime. Nothing from them is stored in this project,
// and these tests skip when the samples are not installed.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNetlist } from "../../src/core/netlist";
import type { ImportResult, SchComponent } from "../../src/core/schematic";
import { importMs14 } from "../../src/importer";
import { expandComponent, findLeaks, importBoth, issueType, listSamples, netlistOf, readSample } from "./helpers";

const samples = listSamples();
const hasSamples = samples.length > 0;

interface Row {
  name: string;
  /** The file's nets written onto the pins, to check what the file states. */
  result: ImportResult;
  /** What the app receives, with connectivity in the drawing. */
  bound: ImportResult;
  ms: number;
}

const rows: Row[] = [];
const failures: { name: string; error: string }[] = [];

function find(name: string): Row {
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`sample ${name} not imported`);
  return row;
}

function comp(row: Row, refDes: string): SchComponent {
  const c = row.result.schematic.components.find((x) => x.refDes === refDes);
  if (!c) throw new Error(`${refDes} not in ${row.name}`);
  return c;
}

const pad = (text: string | number, width: number) => String(text).padEnd(width);

/**
 * Compares net groups from the file with what the geometry-based netlister derives from the bound
 * result. A group counts as shorted when the netlister joins nets the file keeps apart, and as
 * opened when the netlister splits a net the file joins. Unconnected pins must stay alone.
 */
function compareWithNetlister(row: Row): { shorted: number; opened: number; strayed: number; example?: string } {
  const built = buildNetlist(row.bound.schematic);
  const fileToBuilt = new Map<string, Set<string>>();
  const builtToFile = new Map<string, Set<string>>();
  const fileView = new Map(row.result.schematic.components.map((c) => [c.id, c]));
  let strayed = 0;
  let example: string | undefined;
  for (const c of row.bound.schematic.components) {
    const nets = built.pinNets.get(c.id);
    for (const pin of fileView.get(c.id)!.pins) {
      const derived = nets?.get(pin.name);
      if (pin.net === undefined) {
        // Some connectors have no stored node, though a wire of the net they name reaches them.
        const namesItsNet = derived !== undefined && derived.toLowerCase() === c.refDes.toLowerCase();
        if (derived && builtToFile.has(derived) && !namesItsNet) {
          strayed++;
          example ??= `${c.refDes}.${pin.name} has no net in the file but joins ${derived}`;
        }
        continue;
      }
      const group = derived ?? `lone:${c.id}/${pin.name}`;
      (fileToBuilt.get(pin.net) ?? fileToBuilt.set(pin.net, new Set()).get(pin.net)!).add(group);
      (builtToFile.get(group) ?? builtToFile.set(group, new Set()).get(group)!).add(pin.net);
    }
  }
  let shorted = 0;
  let opened = 0;
  for (const [derived, files] of builtToFile) {
    if (files.size > 1) {
      shorted++;
      example ??= `${derived} joins ${[...files].slice(0, 4).join(", ")}`;
    }
  }
  for (const [net, deriveds] of fileToBuilt) {
    if (deriveds.size > 1) {
      opened++;
      example ??= `${net} splits into ${[...deriveds].slice(0, 4).join(", ")}`;
    }
  }
  return { shorted, opened, strayed, example };
}

describe.skipIf(!hasSamples)("sample corpus", () => {
  beforeAll(() => {
    for (const file of samples) {
      const name = basename(file, ".ms14");
      const bytes = readSample(file);
      const start = performance.now();
      try {
        importMs14(bytes);
        const ms = performance.now() - start;
        const both = importBoth(bytes);
        rows.push({ name, result: both.view, bound: both.bound, ms });
      } catch (error) {
        failures.push({ name, error: String(error) });
      }
    }
  }, 300_000);

  it("imports every sample without throwing, in reasonable time", () => {
    expect(failures).toEqual([]);
    expect(rows.length).toBe(samples.length);
    const slowest = rows.reduce((a, b) => (a.ms > b.ms ? a : b));
    console.log(`Slowest import: ${slowest.name} ${slowest.ms.toFixed(0)} ms; total ${rows.reduce((s, r) => s + r.ms, 0).toFixed(0)} ms for ${rows.length} files.`);
    expect(slowest.ms).toBeLessThan(5000);
  });

  it("prints corpus metrics and leaks no template token", () => {
    const issueCounts = new Map<string, number>();
    const severityCounts = new Map<string, number>();
    const leaks: string[] = [];
    let components = 0;
    let simulated = 0;
    let templateParts = 0;
    let noNet = 0;
    let noNetSimulated = 0;
    let wires = 0;
    let analyses = 0;
    let definitions = 0;
    const lines = [`${pad("sample", 52)}${pad("parts", 7)}${pad("spice", 7)}${pad("nonet", 7)}${pad("leaks", 7)}${pad("issues", 8)}ms`];
    for (const row of rows) {
      const { schematic, issues } = row.result;
      let lineCount = 0;
      let rowNoNet = 0;
      for (const c of schematic.components) {
        const text = expandComponent(c);
        if (text) lineCount++;
        for (const pin of c.pins) {
          if (pin.net === undefined) {
            rowNoNet++;
            if (text) noNetSimulated++;
          }
        }
      }
      const rowLeaks = findLeaks(netlistOf(schematic));
      leaks.push(...rowLeaks.map((l) => `${row.name}: ${l.slice(0, 120)}`));
      for (const issue of issues) {
        const type = issueType(issue.message);
        issueCounts.set(type, (issueCounts.get(type) ?? 0) + 1);
        severityCounts.set(issue.severity, (severityCounts.get(issue.severity) ?? 0) + 1);
      }
      components += schematic.components.length;
      simulated += lineCount;
      noNet += rowNoNet;
      wires += schematic.wires.length;
      analyses += row.result.analyses.length;
      definitions += schematic.definitions.length;
      templateParts += schematic.components.filter((c) => c.spice).length;
      lines.push(`${pad(row.name.slice(0, 50), 52)}${pad(schematic.components.length, 7)}${pad(lineCount, 7)}${pad(rowNoNet, 7)}${pad(rowLeaks.length, 7)}${pad(issues.length, 8)}${row.ms.toFixed(0)}`);
    }
    lines.push("");
    lines.push(`Files: ${rows.length}`);
    lines.push(`Components (including ground, connectors, drawing holders): ${components}`);
    lines.push(`Components with a non-empty expanded netlist line: ${simulated}`);
    lines.push(`Pins with no net: ${noNet} (on simulated parts: ${noNetSimulated})`);
    lines.push(`Unresolved template tokens: ${leaks.length}`);
    lines.push(`Wires: ${wires}; analyses recovered: ${analyses}; definition text: ${definitions} chars`);
    lines.push(`Issues by type: ${[...issueCounts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    lines.push(`Issues by severity: ${[...severityCounts].map(([k, v]) => `${k}=${v}`).join(", ")}`);
    console.log(lines.join("\n"));
    expect(leaks.slice(0, 20)).toEqual([]);
    expect(templateParts).toBe(simulated);
  });

  it("wires reach pins: the geometry netlister groups pins as the file does", () => {
    let shorted = 0;
    let opened = 0;
    let strayed = 0;
    const bad: string[] = [];
    for (const row of rows) {
      const r = compareWithNetlister(row);
      shorted += r.shorted;
      opened += r.opened;
      strayed += r.strayed;
      if (r.shorted || r.opened || r.strayed) bad.push(`${row.name}: shorted ${r.shorted}, opened ${r.opened}, strayed ${r.strayed}. ${r.example}`);
    }
    console.log(`Netlister vs file: ${shorted} shorted net groups, ${opened} opened nets, ${strayed} strayed pins, in ${bad.length} files.\n${bad.slice(0, 30).join("\n")}`);
    expect(shorted).toBe(0);
    expect(opened).toBe(0);
    expect(strayed).toBe(0);
  });

  it("keeps Pin.net only on ground parts and pins with no drawing", () => {
    for (const row of rows) {
      const stated = row.bound.schematic.components.flatMap((c) => c.pins.filter((p) => p.net !== undefined).map((p) => ({ c, p })));
      const named = row.result.schematic.components.flatMap((c) => c.pins.filter((p) => p.net !== undefined));
      if (named.length) expect(stated.length, row.name).toBeLessThanOrEqual(named.length);
      for (const { p } of stated) expect(typeof p.net, row.name).toBe("string");
    }
    const plain = find("Non-InvertingOpAmp").bound.schematic.components.flatMap((c) => c.pins.filter((p) => p.net !== undefined && p.net !== "0"));
    expect(plain.length).toBeLessThan(5);
  });

  it("deleting wires changes Non-InvertingOpAmp's netlist", () => {
    const { schematic } = find("Non-InvertingOpAmp").bound;
    expect(schematic.wires.length).toBeGreaterThan(5);
    const partition = (doc: typeof schematic) => JSON.stringify(
      doc.components.flatMap((c) => c.pins.map((p) => `${c.id}/${p.name}=${buildNetlist(doc).pinNets.get(c.id)?.get(p.name) ?? "-"}`)),
    );
    const full = partition(schematic);
    expect(buildNetlist({ ...schematic, wires: [] }).text).not.toBe(buildNetlist(schematic).text);
    expect(partition({ ...schematic, wires: [] })).not.toBe(full);
    const changing = schematic.wires.filter((w) => partition({ ...schematic, wires: schematic.wires.filter((x) => x !== w) }) !== full);
    expect(changing.length).toBeGreaterThan(0);
    console.log(`Non-InvertingOpAmp: ${changing.length} of ${schematic.wires.length} wires change the partition when deleted alone.`);
  });

  it("reports nets held by hidden links as an info issue where there are any", () => {
    const quiz = find("QuizShowVariants").result.issues.find((i) => /hidden links hold them/.test(i.message));
    expect(quiz?.severity).toBe("info");
  });

  it("marks plain resistors, capacitors and inductors, and their values substitute", () => {
    let marked = 0;
    for (const row of rows) {
      for (const c of row.bound.schematic.components) {
        if (/^[rcl]\{ref\} /i.test(c.spice)) expect(c.family, `${row.name} ${c.refDes}`).toBeDefined();
        if (!c.valueKey) continue;
        marked++;
        expect(c.params[c.valueKey], `${row.name} ${c.refDes}`).toBeDefined();
        const before = expandComponent(c);
        const after = expandComponent({ ...c, params: { ...c.params, [c.valueKey]: "12.3456" } });
        expect(after, `${row.name} ${c.refDes}`).not.toBe(before);
        expect(c.paramLabels?.[c.valueKey], `${row.name} ${c.refDes}`).toBeDefined();
      }
    }
    expect(marked).toBeGreaterThan(400);
    const pot = find("WienBridgeOscillator").bound.schematic.components.find((c) => c.spice.includes("Potentiometer"))!;
    expect(pot.family).toBeUndefined();
  });

  it("never labels a parameter with its internal key", () => {
    for (const row of rows) {
      for (const c of row.bound.schematic.components) {
        for (const label of Object.values(c.paramLabels ?? {})) expect(label, `${row.name} ${c.refDes}`).not.toMatch(/^p\d+$/);
      }
    }
    const r = find("OscillatorRC").bound.schematic.components.find((c) => c.refDes === "R1")!;
    expect(r.paramLabels).toMatchObject({ p1: "Resistance" });
    const v = find("AdjFreqAmp").bound.schematic.components.find((c) => c.refDes === "V1")!;
    expect(v.paramLabels?.p1).toBe("DC value");
  });

  it("shows only names the file shows", () => {
    const refs = (name: string) => find(name).bound.schematic.components.map((c) => c.refDes).filter((r) => r);
    for (const row of rows) {
      for (const c of row.bound.schematic.components) expect(c.refDes, row.name).not.toMatch(/^(GND_\d+|DRAWING.*)$/);
      for (const label of row.bound.schematic.labels) {
        if (!label.hidden) expect(label.net, row.name).not.toMatch(/^IO\d/);
      }
    }
    // These read directly from the file's preview image.
    expect(refs("QuizShowVariants")).toEqual(expect.arrayContaining(["U1A", "U1B", "U2A", "U3A", "U3B", "U3C", "U4A", "U4B", "U4C"]));
    expect(refs("QuizShowVariants")).not.toEqual(expect.arrayContaining(["U2B"]));
    expect(refs("DecadeCounterUserLoad")).toEqual(expect.arrayContaining(["U1", "U2", "V1", "V2", "VCC"]));
    expect(refs("DecadeCounterUserLoad")).not.toContain("J1");
    expect(refs("RLC Values")).toContain("U1A");
    expect(find("RLC Values").bound.schematic.components.find((c) => c.refDes === "U1A")?.displayValue).toBe("LM258AD");
    // FullWaveVoltageConverter shows its net numbers; AdjFreqAmp does not.
    expect(find("FullWaveVoltageConverter").bound.schematic.labels.filter((l) => !l.hidden).length).toBeGreaterThan(5);
    expect(find("AdjFreqAmp").bound.schematic.labels.filter((l) => !l.hidden)).toEqual([]);
  });

  it("keeps pinned notes with their line breaks and leaves out hover-only ones", () => {
    let notes = 0;
    for (const row of rows) notes += row.result.issues.filter((i) => /hover-only/.test(i.message)).length;
    expect(notes).toBeGreaterThan(10);
    const multi = rows.flatMap((r) => r.bound.schematic.texts).filter((t) => t.text.includes("\n"));
    expect(multi.length).toBeGreaterThan(0);
    for (const t of multi) expect(t.text).not.toContain("\r");
  });

  it("gives every simulating part a unique reference and every pin a finite position", () => {
    for (const row of rows) {
      const refs = row.result.schematic.components.filter((c) => c.spice.includes("{ref}") && c.refDes).map((c) => c.refDes.toLowerCase());
      expect(new Set(refs).size, row.name).toBe(refs.length);
      for (const c of row.result.schematic.components) {
        expect(Number.isFinite(c.x) && Number.isFinite(c.y), `${row.name} ${c.refDes}`).toBe(true);
        for (const pin of c.pins) expect(Number.isFinite(pin.x) && Number.isFinite(pin.y)).toBe(true);
        expect(new Set(c.pins.map((p) => p.name)).size, `${row.name} ${c.refDes}`).toBe(c.pins.length);
      }
    }
  });

  it("emits each model definition once", () => {
    for (const row of rows) {
      const heads: string[] = [];
      let depth = 0;
      for (const line of row.result.schematic.definitions.split("\n")) {
        const text = line.trim();
        if (/^\.subckt\s/i.test(text)) {
          if (depth === 0) heads.push(text.split(/\s+/)[1].toLowerCase());
          depth++;
        } else if (/^\.ends\b/i.test(text)) {
          depth--;
        }
      }
      expect(new Set(heads).size, row.name).toBe(heads.length);
    }
  });

  it("reports the samples with no components", () => {
    for (const name of ["Rc_ac", "Getting Started with the API"]) {
      const row = find(name);
      expect(row.result.issues.some((i) => /no components/.test(i.message)), name).toBe(true);
    }
  });

  describe("spot checks against the decoded XML", () => {
    it("OscillatorRC: virtual resistor value and net", () => {
      const row = find("OscillatorRC");
      const r6 = comp(row, "R1");
      expect(r6.params.p1).toBe("10");
      // All its model options are switched off, so the empty .model is gone.
      expect(r6.spice).toBe("r{ref} {pin:1} {pin:2} {param:p1}");
      const u1 = comp(row, "U1");
      expect(u1.spice).toMatch(/^a\{ref\} \{pin:A\} \{pin:Y\} NOT__TIL__\d+$/);
      expect(row.result.schematic.definitions).toMatch(/\.MODEL NOT__TIL__\d+/i);
      expect(comp(row, "XSC1").instrument).toBe("oscilloscope");
      expect(comp(row, "XSC1").pins.map((p) => p.name)).toEqual(expect.arrayContaining(["A", "B"]));
    });

    it("AdjFreqAmp: power supply, capacitor and function generator settings", () => {
      const row = find("AdjFreqAmp");
      expect(comp(row, "V1").params.p1).toBe("12");
      expect(comp(row, "R4").params.p1).toBe("1k");
      expect(comp(row, "C1").params.p1).toBe("4.7n");
      const xfg = comp(row, "XFG1");
      expect(xfg.instrument).toBe("function-generator");
      expect(xfg.params).toMatchObject({ shape: "sine", freq: "1000", amp: "10", offset: "0" });
      expect(xfg.spice).toMatch(/^XFG1?\{ref\}|^\{ref\}/);
    });

    it("SpeechFilterSubcircuit: the block is flattened through its ports", () => {
      const row = find("SpeechFilterSubcircuit");
      const netlist = netlistOf(row.result.schematic);
      // C1's pin 1 sits on the block's INPUT port, which is net 1 on the main sheet.
      const c1 = comp(row, "C7");
      expect(c1.pins.find((p) => p.name === "1")?.net).toBe("1");
      expect(c1.pins.find((p) => p.name === "2")?.net).toBe("1_X1");
      const r1 = comp(row, "R6");
      expect(r1.pins.find((p) => p.name === "1")?.net).toBe("14");
      expect(netlist).toContain("rR7 ");
      const u1 = comp(row, "U3");
      expect(u1.pins.find((p) => p.name === "BAL1")?.net).toBeUndefined();
      expect(row.result.schematic.definitions.length).toBeGreaterThan(0);
    });

    it("Transient - Frequency Divider: pulse expression is computed, sections stay apart", () => {
      const row = find("Transient - Frequency Divider");
      const v2 = comp(row, "V2");
      expect(v2.spice).toContain("0.0005");
      expect(v2.spice).toContain("0.001)");
      const sections = row.result.schematic.components.filter((c) => /^U1[ABC]$/.test(c.refDes)).map((c) => c.refDes);
      expect(sections.length).toBeGreaterThanOrEqual(2);
    });

    it("Circuit Parameters: parameters reach the definitions", () => {
      const row = find("CircuitParameterApplications1");
      expect(row.result.schematic.definitions).toMatch(/\.param freq=1meg/);
      expect(row.result.schematic.definitions).toMatch(/\.param period=\{1\/freq\}/);
    });

    it("AC Sweep - Bandpass Filter: the AC settings are recovered", () => {
      const row = find("AC Sweep - Bandpass Filter");
      const ac = row.result.analyses.find((a) => a.type === "ac");
      expect(ac).toBeDefined();
      expect(row.result.issues.some((i) => /active analysis is AC sweep/.test(i.message))).toBe(true);
    });

    it("digital ground parts collapse into net 0", () => {
      const row = find("Getting Started 1");
      const grounds = row.result.schematic.components.filter((c) => c.pins.length === 1 && c.pins[0].net === "0");
      expect(grounds.length).toBeGreaterThan(0);
      expect(findLeaks(netlistOf(row.result.schematic))).toEqual([]);
      expect(netlistOf(row.result.schematic)).not.toMatch(/\.mergenodes/i);
    });

    it("Up-DownCounter: nets stored as empty_name stay separate", () => {
      const row = find("Up-DownCounter");
      const q = (ref: string, pin: string) => comp(row, ref).pins.find((p) => p.name === pin)?.net;
      const outputs = ["U1", "U2", "U3", "U4"].map((u) => q(u, "Q"));
      expect(new Set(outputs).size).toBe(4);
      expect(outputs.every((n) => n !== undefined)).toBe(true);
    });

    it("references follow the file's reference table, not the stale stored name", () => {
      const row = find("AmplitudeModulator");
      const refs = row.result.schematic.components.map((c) => c.refDes);
      expect(refs).toEqual(expect.arrayContaining(["R6", "R8", "U3", "U4", "V9", "XSC1", "A3", "J2", "C2"]));
      expect(refs).not.toContain("U1");
      expect(comp(row, "R6").displayValue).toContain("10k");
    });

    it("capital M in a stored value is mega", () => {
      const r = comp(find("SpeechFilter"), "R3");
      expect(expandComponent(r)).toMatch(/\b2Meg\b/);
      const netlist = netlistOf(find("DC Motor - Ideal H Bridge").result.schematic);
      expect(netlist).toMatch(/TranRoff=1Meg/);
      expect(netlist).not.toMatch(/=\d+M\b/);
    });

    it("potentiometers apply the value and setting shown on the sheet", () => {
      const wien = comp(find("WienBridgeOscillator"), "R1");
      expect(wien.displayValue).toContain("50k");
      expect(wien.params).toMatchObject({ r1: "25000", r2: "25000" });
      expect(expandComponent(wien)).toContain("R1 1 2  25000");
      expect(wien.spice).not.toContain("1e-3");
      expect(comp(find("FrequencyDivider"), "R1").params).toMatchObject({ r1: "500000", r2: "500000" });
      expect(comp(find("AdjFreqAmp"), "R3").params).toMatchObject({ r1: "50000", r2: "50000" });
    });

    it("variable capacitors and sources apply what the sheet shows", () => {
      // Shown as 40 %, of 10u.
      expect(comp(find("OscillatorRC"), "C2").params.value).toBe("0.000004");
      expect(comp(find("OscillatorRC"), "C2").spice).not.toContain("50e-12");
      // These show the output directly: 30V, 0.7V and 45V.
      expect(comp(find("BrushlessDCDriveSixStep"), "V1").params.value).toBe("30");
      expect(comp(find("CoupledShaftMachines"), "Vcontrol").params.value).toBe("0.7");
      expect(comp(find("ControlledRectifier"), "Valpha").params.value).toBe("45");
    });

    it("switches, digital constants and lamps use the saved state", () => {
      // The file hides these switches' names, so they are told apart by the saved state alone.
      const switches = find("BlinkingLights").result.schematic.components.filter((c) => /^V2 5 0 DC /m.test(c.spice));
      expect(switches.filter((c) => c.params.level === "2").length).toBe(1);
      expect(switches.filter((c) => c.params.level === "0").length).toBe(switches.length - 1);
      expect(expandComponent(comp(find("StepperMotorPulloutTorque"), "DIR"))).toContain("d_constsource(state=1)");
      // 5 V at 1 W, from the script's own constants.
      expect(comp(find("QuizShowVariants"), "LAMP1").spice).toMatch(/^R1 1 2 25$/m);
    });

    it("behavioural current references reach the renamed part", () => {
      const stepper = netlistOf(find("StepperMotorPulloutTorque").result.schematic).toLowerCase();
      expect(stepper).toContain("i(vsensor1)");
      expect(stepper).toMatch(/^vsensor1 /m);
      const buck = netlistOf(find("BuckConverterInteractive").result.schematic).toLowerCase();
      expect(buck).toContain("i(vvl_sense)");
      expect(buck).toMatch(/^vvl_sense /m);
      const transformer = netlistOf(find("TransformerModels").result.schematic).toLowerCase();
      expect(transformer).toContain("i(bvsec)");
      expect(transformer).toMatch(/^bvsec /m);
    });

    it("instrument settings come from the file", () => {
      const scope = comp(find("AdjFreqAmp"), "XSC2");
      expect(scope.params).toMatchObject({ timePerDiv: "0.005", voltsPerDivA: "5", voltsPerDivB: "5" });
      const bode = comp(find("SpeechFilterSubcircuit"), "XBP2");
      expect(bode.params).toMatchObject({ fstart: "0.001", fstop: "1000000000" });
      expect(comp(find("WienBridgeOscillator"), "XMM1").params.mode).toBe("ohms");
    });

    it("the active DC sweep is recovered, with its source under the shown reference", () => {
      const dc = find("DC Sweep - CMOS Inverter").result.analyses.find((a) => a.type === "dc");
      expect(dc).toMatchObject({ start: 0, stop: 3.3, step: 0.001 });
      expect(dc?.type === "dc" && dc.source.toLowerCase()).toBe("vvpulse1");
      expect(netlistOf(find("DC Sweep - CMOS Inverter").result.schematic).toLowerCase()).toMatch(/^vvpulse1 /m);
      for (const name of ["DCMotorTorqueSpeed", "ArbitrarySpiceBlock", "DigitalComponentPinModels"]) {
        const sweep = find(name).result.analyses.find((a) => a.type === "dc");
        expect(sweep?.type === "dc" && sweep.source.toLowerCase(), name).toBe("vv2");
      }
    });

    it("no net name is empty or a placeholder", () => {
      const placeholder = /^(|_*|empty_name\w*|empty|none|null|undefined|net)$/i;
      for (const row of rows) {
        for (const c of row.result.schematic.components) {
          for (const pin of c.pins) {
            if (pin.net !== undefined) expect(placeholder.test(pin.net), `${row.name} ${c.refDes}.${pin.name} on ${pin.net}`).toBe(false);
          }
        }
      }
    });

    it("interactive parts keep their circuit and lose their script", () => {
      const row = find("AdjFreqAmp");
      const r1 = comp(row, "R1");
      expect(r1.spice).not.toContain("!!!");
      expect(row.result.issues.some((i) => i.refDes === "R1" && /script/.test(i.message))).toBe(true);
    });
  });
});

const engineFile = resolve(process.cwd(), "src/engine/index.ts");

describe.skipIf(!hasSamples || !existsSync(engineFile))("headline: operating point through the engine", () => {
  it("solves imported netlists", async () => {
    const engine = await import(/* @vite-ignore */ engineFile) as {
      simulate: (netlist: string, request: { type: "op" }) => { warnings: string[]; vectors: { name: string; re: Float64Array }[] };
    };
    if (!rows.length) {
      for (const file of samples) {
        const both = importBoth(readSample(file));
        rows.push({ name: basename(file, ".ms14"), result: both.view, bound: both.bound, ms: 0 });
      }
    }
    const categories = new Map<string, string[]>();
    let solved = 0;
    let attempted = 0;
    let withWarnings = 0;
    const warningKinds = new Map<string, number>();
    const started = performance.now();
    for (const row of rows) {
      if (!row.result.schematic.components.some((c) => c.spice)) continue;
      attempted++;
      try {
        const result = engine.simulate(netlistOf(row.result.schematic), { type: "op" });
        solved++;
        if (result.warnings.some((w) => /unsupported|not supported/i.test(w))) withWarnings++;
        for (const warning of result.warnings) {
          const key = warning.replace(/\s+/g, " ").replace(/\d+(\.\d+)?/g, "#").replace(/'[^']*'/g, "*").slice(0, 80);
          warningKinds.set(key, (warningKinds.get(key) ?? 0) + 1);
        }
      } catch (error) {
        const e = error as { code?: string; message?: string };
        const message = (e.message ?? String(error)).replace(/\s+/g, " ");
        const key = `${e.code ?? "error"}: ${message.replace(/\d+(\.\d+)?/g, "#").replace(/\b[a-z]\w*\d\w*/gi, "*").slice(0, 70)}`;
        const list = categories.get(key) ?? [];
        list.push(`${row.name}: ${message.slice(0, 100)}`);
        categories.set(key, list);
      }
    }
    let solvedViaNetlister = 0;
    const netlisterFailures: string[] = [];
    for (const row of rows) {
      if (!row.result.schematic.components.some((c) => c.spice)) continue;
      try {
        await engine.simulate(buildNetlist(row.bound.schematic).text, { type: "op" });
        solvedViaNetlister++;
      } catch (error) {
        netlisterFailures.push(`${row.name}: ${String(error).slice(0, 90)}`);
      }
    }
    const lines = [
      `Operating point, from Pin.net: ${solved} of ${attempted} imported netlists solve (${(performance.now() - started).toFixed(0)} ms).`,
      `Operating point, through core/netlist.ts: ${solvedViaNetlister} of ${attempted} solve.`,
      `${withWarnings} of the solved netlists had a device or source function skipped by the engine. All warnings:`,
      ...[...warningKinds].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `  ${n} x ${k}`),
      ...netlisterFailures.slice(0, 12).map((f) => `  via netlister: ${f}`),
      "Failures from Pin.net:",
    ];
    for (const [key, list] of [...categories].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${list.length} x ${key}`);
      lines.push(`      e.g. ${list[0]}`);
    }
    console.log(lines.join("\n"));
    expect(attempted).toBeGreaterThan(0);

    // A check of the numbers themselves: the rails named +15 and -15 stay separate and have the right signs.
    const rails = engine.simulate(netlistOf(find("RLC Values").result.schematic), { type: "op" }).vectors;
    const volts = (name: string) => rails.find((v) => v.name === name)?.re[0];
    expect(volts("v(_15)")).toBeCloseTo(15, 6);
    expect(volts("v(_15_2)")).toBeCloseTo(-15, 6);
    // The file wires a 10k and 50k divider from output to ground, so its middle is one sixth of the output.
    expect(volts("v(in)")).toBeCloseTo(0, 6);
    const out = volts("v(out)") ?? 0;
    expect(Math.abs(out)).toBeGreaterThan(1);
    expect((volts("v(2)") ?? 0) / out).toBeCloseTo(1 / 6, 2);

    // The recovered DC sweep runs: a CMOS inverter's output falls as its input rises.
    const inverter = find("DC Sweep - CMOS Inverter").result;
    const sweep = inverter.analyses.find((a) => a.type === "dc")!;
    const swept = (engine.simulate as (n: string, r: unknown) => { vectors: { name: string; re: Float64Array }[] })(netlistOf(inverter.schematic), sweep);
    const output = swept.vectors.find((v) => /^v\(/.test(v.name) && v.re[0] > 3 && v.re[v.re.length - 1] < 0.3);
    expect(output, "a node that swings from high to low").toBeDefined();
  }, 600_000);
});
