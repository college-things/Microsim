import { flattenCircuit } from "./hierarchy";
// Circuit reports share the simulator's connectivity and value validation.
import { PART_BY_KIND } from "./library";
import { buildNetlist, componentTemplate, shownValue } from "./netlist";
import type { SchComponent, Schematic } from "./schematic";

export interface BomRow {
  kind: string;
  model: string;
  quantity: number;
  references: string[];
  description: string;
  value: string;
  footprint: string;
}

const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
// Ground and supply-rail symbols name a net; they are not parts anyone buys.
const physicalPart = (c: SchComponent) => c.kind !== "ground" && c.kind !== "vcc" && c.kind !== "hierarchy-block" && c.kind !== "hierarchy-port" && !c.instrument
  && !PART_BY_KIND.get(c.kind)?.instrument && c.pins.length > 0;
const valueOf = (c: SchComponent) => c.params[c.valueKey ?? PART_BY_KIND.get(c.kind)?.valueParam ?? "value"] ?? shownValue(c) ?? "";
// Custom model blocks can share a display value while using different SPICE models.
const modelOf = (c: SchComponent) => c.params.model ?? c.spice;

export function billOfMaterials(schematic: Schematic): BomRow[] {
  schematic = flattenCircuit(schematic);
  const groups = new Map<string, BomRow>();
  for (const comp of schematic.components.filter(physicalPart)) {
    const value = valueOf(comp), model = modelOf(comp), footprint = comp.params.footprint ?? "";
    // Different known packages must remain separate purchasing rows.
    const key = JSON.stringify([comp.kind, value, model, footprint]);
    let row = groups.get(key);
    if (!row) groups.set(key, row = {
      kind: comp.kind, model, quantity: 0, references: [],
      description: PART_BY_KIND.get(comp.kind)?.name ?? comp.displayValue ?? comp.kind,
      value, footprint,
    });
    row.quantity++;
    row.references.push(comp.refDes);
  }
  for (const row of groups.values()) row.references.sort(natural);
  return [...groups.values()].sort((a, b) => natural(a.references[0], b.references[0]));
}

const headings = ["Quantity", "References", "Description", "Value", "Footprint"];
const cells = (row: BomRow) => [String(row.quantity), row.references.join(", "), row.description, row.value, row.footprint];
const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export function bomToCsv(rows: BomRow[]): string {
  return [headings, ...rows.map(cells)].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const html = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function bomToHtml(rows: BomRow[]): string {
  return `<table><caption>Bill of materials</caption><thead><tr>${headings.map((s) => `<th scope="col">${s}</th>`).join("")}</tr></thead><tbody>\n`
    + rows.map((row) => `<tr>${cells(row).map((s) => `<td>${html(s)}</td>`).join("")}</tr>`).join("\n") + "\n</tbody></table>";
}

export interface ErcFinding {
  severity: "error" | "warning";
  message: string;
  componentIds: string[];
  nets: string[];
}

// Electrical direction is not stored on Pin. Only known, fixed digital outputs
// are checked; MCU GPIO can be inputs or outputs depending on its running program.
function digitalOutputs(c: SchComponent): string[] {
  if (["and", "or", "nand", "nor", "xor", "not"].includes(c.kind)) return ["y"];
  if (c.kind === "dff") return ["Q", "QN"];
  if (c.instrument === "clock") return ["p"];
  if (c.instrument === "serial-terminal") return c.pins.filter((p) => /^TXD?$/i.test(p.name)).map((p) => p.name);
  return [];
}

export function electricalRulesCheck(schematic: Schematic): ErcFinding[] {
  schematic = flattenCircuit(schematic);
  const netlist = buildNetlist(schematic);
  const findings: ErcFinding[] = [];
  const handled = new Set<string>();
  const add = (severity: ErcFinding["severity"], message: string, componentIds: string[] = [], nets: string[] = []) => {
    findings.push({ severity, message, componentIds: [...new Set(componentIds)], nets });
    handled.add(message);
  };
  const connections = new Map<string, { comp: SchComponent; pin: string }[]>();
  const references = new Map<string, SchComponent[]>();
  for (const comp of schematic.components) {
    if (comp.refDes.trim()) {
      const key = comp.refDes.trim().toUpperCase();
      references.set(key, [...(references.get(key) ?? []), comp]);
    }
    const nets = netlist.pinNets.get(comp.id);
    for (const pin of comp.pins) {
      const net = nets?.get(pin.name);
      if (net !== undefined) {
        const list = connections.get(net) ?? [];
        list.push({ comp, pin: pin.name });
        connections.set(net, list);
      } else if (!(pin.optional ?? PART_BY_KIND.get(comp.kind)?.pins.find((p) => p.name === pin.name)?.optional)) {
        add("warning", `${comp.refDes || PART_BY_KIND.get(comp.kind)?.name}: pin ${pin.name} is not connected.`, [comp.id]);
      }
    }
    // Read independent voltage sources from the same template used by SPICE,
    // including imported sources, generators and ammeters with a sense source.
    for (const line of componentTemplate(comp).split("\n")) {
      const source = /^(V\S*|\{ref\})\s+(\{pin:[^}]+\}|0)\s+(\{pin:[^}]+\}|0)(?:\s|$)/i.exec(line.trim());
      if (!source || (source[1] === "{ref}" && !/^v/i.test(netlist.refs.get(comp.id) ?? ""))) continue;
      const node = (token: string) => token === "0" ? "0" : nets?.get(token.slice(5, -1));
      const a = node(source[2]), b = node(source[3]);
      if (a !== undefined && a === b) add("error", `${comp.refDes}: both voltage source terminals are on net ${a}.`, [comp.id], [a]);
    }
  }
  for (const [net, pins] of connections) {
    if (pins.length === 1) add("warning", `Net ${net} has only one connection (${pins[0].comp.refDes}, pin ${pins[0].pin}).`, [pins[0].comp.id], [net]);
    const drivers = pins.filter(({ comp, pin }) => digitalOutputs(comp).includes(pin));
    if (drivers.length > 1) add("error", `Net ${net} is driven by more than one digital output: ${drivers.map(({ comp, pin }) => `${comp.refDes} pin ${pin}`).join(", ")}.`, drivers.map(({ comp }) => comp.id), [net]);
  }
  for (const parts of references.values()) if (parts.length > 1) {
    add("error", `Two or more parts are named ${parts[0].refDes}. Give each a different name.`, parts.map((c) => c.id));
    for (const c of parts) handled.add(`Two parts are named ${c.refDes}. Give each a different name.`);
  }
  for (const severity of ["error", "warning"] as const) {
    for (const message of severity === "error" ? netlist.errors : netlist.warnings) {
      if (handled.has(message)) continue;
      const parts = schematic.components.filter((c) => message.startsWith(`${c.refDes || PART_BY_KIND.get(c.kind)?.name}:`));
      add(severity, message, parts.map((c) => c.id));
    }
  }
  return findings;
}

// KiCad quoted atoms use backslash escapes, rather than CSV's doubled quotes.
const sexpr = (value: string) => JSON.stringify(value);

export function kicadNetlist(schematic: Schematic): string {
  schematic = flattenCircuit(schematic);
  const { pinNets } = buildNetlist(schematic);
  const parts = schematic.components.filter(physicalPart).sort((a, b) => natural(a.refDes, b.refDes));
  const nets = new Map<string, { ref: string; pin: string }[]>();
  const components = parts.map((comp) => {
    for (const [pin, net] of pinNets.get(comp.id) ?? []) {
      const nodes = nets.get(net) ?? [];
      nodes.push({ ref: comp.refDes, pin });
      nets.set(net, nodes);
    }
    return `    (comp (ref ${sexpr(comp.refDes)}) (value ${sexpr(valueOf(comp))}) (footprint ${sexpr(comp.params.footprint ?? "")}))`;
  });
  return `(export (version "E")\n  (design (source ${sexpr(schematic.name)}) (tool "Microsim"))\n  (components\n${components.join("\n")}\n  )\n  (nets\n`
    + [...nets].sort(([a], [b]) => natural(a, b)).map(([name, nodes], i) =>
      `    (net (code ${i + 1}) (name ${sexpr(name)})\n${nodes.map(({ ref, pin }) => `      (node (ref ${sexpr(ref)}) (pin ${sexpr(pin)}))`).join("\n")}\n    )`).join("\n")
    + "\n  )\n)\n";
}
