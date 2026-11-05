// NI 8051 microcontrollers convert to the built-in core, and the programs beside NI's samples assemble and run.
// Samples and their .asm files are read from the local install at test time, skipped when absent, and never printed.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNetlist } from "../../src/core/netlist";
import { unsimulatedParts } from "../../src/core/limits";
import type { SchComponent } from "../../src/core/schematic";
import { assemble51 } from "../../src/engine/asm51";
import { programHex } from "../../src/engine/ihex";
import { simulate } from "../../src/engine";
import { importMs14 } from "../../src/importer/index";
import { convertNiMcus, readMcuWorkspace } from "../../src/importer/mcu";
import { serializeMs14 } from "../../src/importer/writer";

const ROOT = "C:/Users/Public/Documents/National Instruments/Circuit Design Suite 14.2/samples/MCU/805x samples";
const present = existsSync(ROOT);

const PORTS = Array.from({ length: 32 }, (_, i) => `P${i >> 3}B${i & 7}${["AD", "T", "A", "X"][i >> 3]}${i & 7}`);
function fakeNiMcu(): SchComponent {
  const pins = [...PORTS, "RST", "XTAL1", "XTAL2", "GND", "VCC"].map((name, i) => ({ name, x: i, y: 0 }));
  return {
    id: "c1", refDes: "U1", kind: "imported", x: 0, y: 0, rotation: 0, mirrored: false, params: {}, pins, graphics: [], displayValue: "8052",
    spice: `a{ref} [${PORTS.map((p) => `{pin:${p}}`).join(" ")}] [] 8051_CPU{ref}\n.model 8051_CPU{ref} d_cpu ( hex_file = romfile.hex cpu_part_id = "mcs51_8052" clock_freq = 11059200 )`,
  } as SchComponent;
}

describe("converting NI microcontrollers", () => {
  it("maps an NI 8052 onto the core by its P<port>B<bit> pin names, keeping its clock", () => {
    const comp = fakeNiMcu(), issues: { severity: string; message: string }[] = [];
    convertNiMcus([comp], '<Item Value="&amp;ASCC:\\build\\Demo.mcuws"/><Item Value="&amp;ASCDemo\\Demo.mcuws"/><SWsTreeItem Class="SWsTreeItem" Name="&amp;ASCdemo.asm">', issues as never);
    expect(comp.params).toMatchObject({ mcu: "8051", frequency: "11059200", code: "", workspace: "Demo\\Demo.mcuws", sources: "demo.asm" });
    expect(comp.spice).toContain("{pin:P0B0AD0}");
    expect(comp.spice).toContain("] {pin:RST} MCU_{ref}");
    expect(comp.spice).toContain("d_mcu8051");
    expect(issues[0].message).toMatch(/converted to Microsim's 8051 core/);
  });
  it("leaves PIC parts alone", () => {
    const comp = fakeNiMcu();
    comp.spice = comp.spice.replace("mcs51_8052", "pic16f84");
    convertNiMcus([comp], "", []);
    expect(comp.spice).toContain("d_cpu");
  });
  it("prefers the workspace path relative to the circuit", () => {
    expect(readMcuWorkspace('Value="&amp;ASCC:\\x\\A.mcuws" Value="&amp;ASCA\\A.mcuws"').workspace).toBe("A\\A.mcuws");
  });
});

/** The program a converted part names, found inside its workspace folder, assembly before C. */
function sourceFor(sample: string, comp: SchComponent): string | undefined {
  if (!comp.params.workspace) return undefined;
  const workspace = join(dirname(sample), comp.params.workspace.replace(/\\/g, "/"));
  if (!existsSync(workspace)) return undefined;
  const find = (dir: string, name: string): string | undefined => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { const hit = find(full, name); if (hit) return hit; }
      else if (entry.toLowerCase() === name.toLowerCase()) return full;
    }
  };
  const names = (comp.params.sources ?? "").split(";").filter((n) => /\.(asm|a51)$/i.test(n));
  return names.map((n) => find(dirname(workspace), n)).find(Boolean);
}

describe.skipIf(!present)("NI 8051 samples on the built-in core", () => {
  const files = present ? readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith(".ms14")).map((f) => join(ROOT, f)) : [];
  for (const file of files) {
    it(`${file.slice(ROOT.length + 1)}: converts, assembles its program and drives the chip's pins`, () => {
      const { schematic } = importMs14(new Uint8Array(readFileSync(file)), { retainSource: true });
      const mcus = schematic.components.filter((c) => c.params.mcu === "8051");
      expect(mcus.length).toBeGreaterThan(0);
      expect(unsimulatedParts(schematic).some((n) => /has no program loaded/.test(n))).toBe(true);
      for (const mcu of mcus) {
        const source = sourceFor(file, mcu);
        expect(source, "the workspace's assembly source").toBeDefined();
        mcu.params.code = programHex(assemble51(readFileSync(source!, "latin1")).code);
      }
      expect(unsimulatedParts(schematic).some((n) => /has no program loaded/.test(n))).toBe(false);
      const netlist = buildNetlist(schematic);
      const slow = /Blinking/i.test(file);
      const result = simulate(netlist.text, { type: "tran", tstep: 1e-5, tstop: slow ? 0.3 : 5e-3, tmax: slow ? 1e-4 : 1e-5 });
      // The serial terminal sample only echoes typed characters, so its chip stays quiet without input.
      if (/SerialTerminal/i.test(file)) return;
      const nets = netlist.pinNets.get(mcus[0].id)!;
      const changing = [...nets].filter(([pin, net]) => {
        if (!/^P\dB/.test(pin) || net === "0") return false;
        const v = result.vectors.find((x) => x.name.toLowerCase() === `v(${net})`.toLowerCase());
        if (!v) return false;
        let low = Infinity, high = -Infinity;
        for (const x of v.re) { low = Math.min(low, x); high = Math.max(high, x); }
        return high - low > 2;
      });
      expect(changing.length).toBeGreaterThan(0);
      // A loaded program saves with the original native records and reopens in place.
      const reopened = importMs14(serializeMs14({ schematic, analyses: [], issues: [] }));
      expect(reopened.schematic.components.find((c) => c.id === mcus[0].id)?.params.code).toBe(mcus[0].params.code);
    }, 120000);
  }
  it("turns NI's virtual terminal into a serial terminal at its baud rate", () => {
    const { schematic } = importMs14(new Uint8Array(readFileSync(join(ROOT, "SerialTerminal.ms14"))));
    const terminal = schematic.components.find((c) => c.instrument === "serial-terminal");
    expect(terminal?.params.baud).toBe("1.2k");
    expect(unsimulatedParts(schematic).some((n) => /serial port/.test(n))).toBe(false);
  });
});

// Independent check, with SDCC's separately installed uCsim: its disassembler must agree with every instruction
// the assembler emitted for the samples, in mnemonic and length. Set MICROSIM_TEST_TOOLS=1 to run it.
const UCSIM = "C:/Program Files/SDCC/bin/ucsim_51.exe";
describe.skipIf(!present || process.env.MICROSIM_TEST_TOOLS !== "1" || !existsSync(UCSIM))("assembler against uCsim", () => {
  it("agrees on every sample instruction", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((e) => statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : /\.asm$/i.test(e) ? [join(d, e)] : []);
    let compared = 0;
    for (const file of walk(ROOT)) {
      const { code, listing } = assemble51(readFileSync(file, "latin1"));
      const records: string[] = [];
      for (let a = 0; a < code.length; a += 16) {
        const b = [Math.min(16, code.length - a), a >> 8, a & 255, 0, ...code.slice(a, a + 16)];
        b.push(-b.reduce((x, y) => x + y, 0) & 255);
        records.push(":" + b.map((v) => v.toString(16).padStart(2, "0")).join(""));
      }
      const hexFile = join(process.env.TEMP ?? ".", `microsim-asm-${process.pid}.hex`);
      writeFileSync(hexFile, records.join("\n") + "\n:00000001FF\n");
      const seen = new Map<number, string>();
      // uCsim drops output when given many commands; ask in small batches, after a throwaway command.
      for (let i = 0; i < listing.length; i += 30) {
        const commands = [`file "${hexFile}"`, "dc 0 0", ...listing.slice(i, i + 30).map((l) => `dc 0x${l.address.toString(16)} 0x${l.address.toString(16)}`), "quit"];
        const out = spawnSync(UCSIM, ["-q", "-t", "C52", "-c", "-"], { input: commands.join("\r\n") + "\r\n", encoding: "utf8", windowsHide: true }).stdout;
        for (const m of out.matchAll(/^0x([0-9a-f]{4})\s+\S?\s+((?:[0-9a-f]{2} )+)\s*(\S+)/gim)) seen.set(parseInt(m[1], 16), `${m[3].toUpperCase()}/${m[2].trim().split(" ").length}`);
      }
      for (const l of listing) {
        expect(seen.get(l.address), `${file.slice(ROOT.length)} at ${l.address.toString(16)}`).toBe(`${l.mnemonic}/${l.size}`);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000);
  }, 600000);
});
