// Imported NI 8051-family microcontrollers run on Microsim's own 8051 core. Only the circuit file is read:
// the part's model line gives its clock, and the file names the workspace whose source supplies the program.
import type { ImportIssue, SchComponent } from "../core/schematic";

/** Template of a converted part: the 32 port pins and reset, in the core's order. */
export function mcuTemplate(ports: string[], reset: string): string {
  return `a{ref} [${ports.map((p) => `{pin:${p}}`).join(" ")}] {pin:${reset}} MCU_{ref}\n.model MCU_{ref} d_mcu8051(program="{param:code}" frequency={param:frequency})`;
}

/** True for a part whose program can be loaded: the built-in core or a converted NI 8051. */
export function isMcu8051(comp: SchComponent): boolean {
  return comp.kind === "mcu8051" || comp.params.mcu === "8051";
}

const NI_MODEL = /\.model\s+\S+\s+d_cpu\s*\(([\s\S]*?)\)/i;

/** Where the file says its MCU workspace and sources are. Paths are as written by NI, relative to the circuit. */
export interface McuWorkspace {
  workspace?: string;
  sources: string[];
}

export function readMcuWorkspace(xml: string): McuWorkspace {
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/^&ASC/, "");
  const paths = [...xml.matchAll(/Value="(&amp;ASC[^"]*\.mcuws)"/gi)].map((m) => decode(m[1]));
  // Prefer a path relative to the circuit over the absolute one recorded on NI's build machine.
  const workspace = paths.find((p) => !/^[a-z]:\\|^\\\\/i.test(p)) ?? paths[0];
  const sources = [...new Set([...xml.matchAll(/<SWsTreeItem[^>]*Name="&amp;ASC([^"]*\.(?:asm|a51|c|hex|ihx))"/gi)].map((m) => decode(m[1])))];
  return { workspace, sources };
}

/**
 * Rewrites NI `d_cpu` 8051/8052 parts to the built-in core, keeping their NI pins and symbol.
 * PIC parts stay as they are. The program starts empty: it is loaded from the workspace source.
 */
export function convertNiMcus(components: SchComponent[], xml: string, issues: ImportIssue[]): void {
  let workspace: McuWorkspace | undefined;
  for (const comp of components) {
    // NI's virtual terminal becomes the receive-only serial terminal instrument, reading its RXD pin.
    const serial = /\.model\s+\S+\s+d_serialport\s*\(([\s\S]*?)\)/i.exec(comp.spice);
    if (serial && comp.pins.some((p) => /^RXD?$/i.test(p.name))) {
      const rate = /baud_rate\s*=\s*\{param:(\w+)\}/i.exec(serial[1]);
      const baud = rate ? comp.params[rate[1]] : /baud_rate\s*=\s*([\w.]+)/i.exec(serial[1])?.[1];
      comp.spice = "";
      comp.instrument = "serial-terminal";
      // Handshake lines are not modelled, and either data line may be left open.
      for (const pin of comp.pins) pin.optional = true;
      comp.params = { ...comp.params, baud: baud ?? "9600", parity: "none", threshold: "2.5" };
      issues.push({ severity: "info", message: `${comp.refDes}: NI virtual terminal converted to Microsim's serial terminal. It shows what arrives on RXD and sends what you type on TXD, at ${comp.params.baud} baud; RTS and CTS are not modelled.` });
      continue;
    }
    const model = NI_MODEL.exec(comp.spice);
    if (!model) continue;
    const args = model[1];
    const part = /cpu_part_id\s*=\s*"?([\w]+)/i.exec(args)?.[1] ?? "";
    const named = /\.model\s+(\S+)/i.exec(model[0])?.[1] ?? "";
    if (/pic/i.test(part + named)) continue;
    if (!/mcs51|805|8051/i.test(part + named + (comp.displayValue ?? ""))) continue;
    const ports: string[] = [];
    for (let port = 0; port < 4; port++) for (let bit = 0; bit < 8; bit++) {
      const pin = comp.pins.find((p) => new RegExp(`^P${port}B${bit}(?![0-9])`, "i").test(p.name));
      if (pin) ports.push(pin.name);
    }
    const reset = comp.pins.find((p) => /^(RST|RESET)$/i.test(p.name))?.name;
    if (ports.length !== 32 || !reset) {
      issues.push({ severity: "warning", message: `${comp.refDes}: this microcontroller's pins could not be matched to an 8051, so it is not simulated.` });
      continue;
    }
    const clock = Number(/clock_freq\s*=\s*([\d.eE+-]+)/.exec(args)?.[1]);
    workspace ??= readMcuWorkspace(xml);
    comp.spice = mcuTemplate(ports, reset);
    comp.params = {
      ...comp.params,
      mcu: "8051",
      frequency: String(Number.isFinite(clock) && clock > 0 ? clock : 12e6),
      code: "",
      ...(workspace.workspace ? { workspace: workspace.workspace } : {}),
      ...(workspace.sources.length ? { sources: workspace.sources.join(";") } : {}),
    };
    const expect = workspace.sources.length ? ` Load ${workspace.sources.join(" or ")} from its workspace` : " Load its assembly source or Intel HEX";
    issues.push({ severity: "info", message: `${comp.refDes}: NI ${part || "8051"} microcontroller converted to Microsim's 8051 core.${expect} with Design > Microcontroller program to run it.` });
  }
}
