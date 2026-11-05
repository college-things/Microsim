// Circuit tools the assistant can call. They use the same document API as the canvas.
import { newId, type Doc } from "../core/doc";
import { PART_BY_KIND, PARTS } from "../core/library";
import { acRms, fourier, settledMean } from "../core/analyses";
import { buildNetlist, listSources, looseNames, pinWorld, readValue, resolveSource } from "../core/netlist";
import type { AnalysisRequest, SimResult } from "../core/sim";

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)): ToolSpec["input_schema"] => ({
  type: "object", properties, required, additionalProperties: false,
});

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_parts",
    description: "List the parts that can be placed, with pin names and parameters.",
    input_schema: object({}),
  },
  {
    name: "get_circuit",
    description: "Read the current circuit: components, parameters, pin nets, and the generated SPICE netlist.",
    input_schema: object({}),
  },
  {
    name: "add_component",
    description: "Place a part. Coordinates snap to multiples of 10; leave about 120 units between parts. Returns its reference designator.",
    input_schema: object({
      kind: { type: "string", description: "Part kind from list_parts, e.g. resistor." },
      x: { type: "number" },
      y: { type: "number" },
      params: { type: "object", description: "Parameter overrides such as {\"value\":\"10k\"}.", additionalProperties: { type: "string" } },
      rotation: { type: "number", enum: [0, 90, 180, 270] },
    }, ["kind", "x", "y"]),
  },
  {
    name: "connect",
    description: "Wire one pin to another.",
    input_schema: object({
      from_ref: { type: "string" }, from_pin: { type: "string" },
      to_ref: { type: "string" }, to_pin: { type: "string" },
    }),
  },
  {
    name: "set_parameter",
    description: "Change a component parameter, such as a resistor value.",
    input_schema: object({ ref: { type: "string" }, param: { type: "string" }, value: { type: "string" } }),
  },
  {
    name: "remove_component",
    description: "Delete a component and any wires ending on its pins.",
    input_schema: object({ ref: { type: "string" } }),
  },
  {
    name: "move_component",
    description: "Move a part to new coordinates, rerouting its wires. Connections are kept; the move fails if they can't be.",
    input_schema: object({ ref: { type: "string" }, x: { type: "number" }, y: { type: "number" } }),
  },
  {
    name: "rotate_component",
    description: "Set a part's rotation, rerouting its wires. Connections are kept; the turn fails if they can't be.",
    input_schema: object({ ref: { type: "string" }, rotation: { type: "number", enum: [0, 90, 180, 270] } }),
  },
  {
    name: "name_net",
    description: "Give the net on a pin a name. Pins whose nets share a name are connected, so this also connects distant parts without a wire.",
    input_schema: object({ ref: { type: "string" }, pin: { type: "string" }, net: { type: "string" } }),
  },
  {
    name: "disconnect",
    description: "Remove the wires and net names on one pin, cutting its connection.",
    input_schema: object({ ref: { type: "string" }, pin: { type: "string" } }),
  },
  {
    name: "tidy_layout",
    description: "Arrange the whole circuit left to right in signal order and reroute its wires, keeping every connection. Use after building or heavily changing a circuit, so a person can read the schematic. This reshapes the sheet, so don't use it on a layout someone drew and didn't ask you to change.",
    input_schema: object({}),
  },
  {
    name: "run_analysis",
    description: "Simulate the circuit and return a summary. Time results include each signal's frequency and RMS over the last half of the run, so run long enough to settle. For tran give tstop, and optionally tmax, the largest time step, and thd_at_hz for each signal's distortion at that fundamental. For ac give fstart and fstop, and optionally at_hz for magnitude and phase at one frequency; results also give the upper and lower -3 dB points. For dc give source, start, stop, step. For transfer give output, like v(out), and source: it returns gain and input and output resistance. For noise give output, source, fstart and fstop. Heed any warnings, which say when a result may have missed fast behaviour.",
    input_schema: object({
      type: { type: "string", enum: ["op", "dc", "ac", "tran", "transfer", "noise"] },
      tstop: { type: "number" },
      tmax: { type: "number" },
      thd_at_hz: { type: "number" },
      at_hz: { type: "number" },
      output: { type: "string" },
      fstart: { type: "number" },
      fstop: { type: "number" },
      source: { type: "string" },
      start: { type: "number" },
      stop: { type: "number" },
      step: { type: "number" },
    }, ["type"]),
  },
];

/** Tools that change the circuit, so a turn that uses none leaves no undo step. */
export const MUTATING_TOOLS = new Set(["add_component", "connect", "disconnect", "set_parameter", "remove_component", "move_component", "rotate_component", "name_net", "tidy_layout"]);

/**
 * Checks tool input against its schema. Streamed tool inputs arrive unvalidated by the API,
 * and may be truncated, so every call is checked here. Returns a problem, or undefined.
 */
export function validateToolInput(spec: ToolSpec, input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "Input must be an object.";
  const record = input as Record<string, unknown>;
  const missing = spec.input_schema.required.filter((key) => record[key] === undefined);
  if (missing.length) return `Missing required input: ${missing.join(", ")}.`;
  for (const [key, value] of Object.entries(record)) {
    const rule = spec.input_schema.properties[key] as { type?: string; enum?: unknown[]; additionalProperties?: { type?: string } } | undefined;
    if (!rule) return `Unknown input: ${key}.`;
    if (rule.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${key} must be a number.`;
    if (rule.type === "string" && typeof value !== "string") return `${key} must be a string.`;
    if (rule.type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${key} must be an object.`;
      if (rule.additionalProperties?.type === "string" && !Object.values(value).every((v) => typeof v === "string")) {
        return `Every value in ${key} must be a string.`;
      }
    }
    if (rule.enum && !rule.enum.includes(value)) return `${key} must be one of ${rule.enum.join(", ")}.`;
  }
  return undefined;
}

const fmt = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(5)) : String(v));

/** Frequency, mean and RMS of settled behaviour, across whole periods when the signal repeats. */
function settled(values: ArrayLike<number>, time: ArrayLike<number>): Record<string, unknown> {
  if (time[0] === undefined || !(time[time.length - 1] > time[0])) return {};
  const mean = settledMean(values, time);
  const ac = acRms(values, time);
  // Frequency comes from the whole last half, where more crossings give a better estimate.
  const from = (time[0] + time[time.length - 1]) / 2;
  let first = 0;
  while (first < time.length - 1 && time[first] < from) first++;
  const rising: number[] = [];
  for (let i = first + 1; i < time.length; i++) {
    if (values[i - 1] < mean && values[i] >= mean) {
      const f = (mean - values[i - 1]) / (values[i] - values[i - 1]);
      rising.push(time[i - 1] + f * (time[i] - time[i - 1]));
    }
  }
  const periods = rising.length - 1;
  return {
    settled_mean: fmt(mean),
    settled_rms: fmt(Math.sqrt(mean * mean + ac * ac)),
    settled_frequency_hz: periods >= 2 ? fmt(periods / (rising[rising.length - 1] - rising[0])) : null,
  };
}

/** Reduces a run to numbers the model can reason about without sending every sample. */
export function summarize(result: SimResult): unknown {
  const axis = result.axis?.re;
  const vectors = result.vectors.slice(0, 40).map((v) => {
    if (!axis) return { name: v.name, value: fmt(v.re[0]) };
    if (v.im) {
      const magnitude = Array.from(v.re, (re, i) => Math.hypot(re, v.im![i]));
      const peak = magnitude.reduce((best, m, i) => (m > magnitude[best] ? i : best), 0);
      const cutoff = magnitude.findIndex((m, i) => i > peak && m < magnitude[peak] / Math.SQRT2);
      let lower = -1;
      for (let i = peak - 1; i >= 0; i--) {
        if (magnitude[i] < magnitude[peak] / Math.SQRT2) {
          lower = i;
          break;
        }
      }
      return {
        name: v.name,
        peak_magnitude: fmt(magnitude[peak]), at_hz: fmt(axis[peak]),
        minus_3db_hz: cutoff >= 0 ? fmt(axis[cutoff]) : null,
        lower_minus_3db_hz: lower >= 0 ? fmt(axis[lower]) : null,
        first: fmt(magnitude[0]), last: fmt(magnitude[magnitude.length - 1]),
      };
    }
    let min = Infinity, max = -Infinity;
    for (const x of v.re) { if (x < min) min = x; if (x > max) max = x; }
    return { name: v.name, min: fmt(min), max: fmt(max), first: fmt(v.re[0]), last: fmt(v.re[v.re.length - 1]), ...settled(v.re, axis) };
  });
  return {
    analysis: result.analysis,
    axis: axis ? { name: result.axis!.name, from: fmt(axis[0]), to: fmt(axis[axis.length - 1]), points: axis.length } : undefined,
    vectors,
    truncated_vectors: Math.max(0, result.vectors.length - 40),
    warnings: result.warnings.slice(0, 10),
  };
}

export type SimulateFn = (netlist: string, request: AnalysisRequest) => Promise<SimResult>;

function toRequest(input: Record<string, any>, netlist: string): AnalysisRequest {
  const source = (typed: string): string => {
    const found = resolveSource(netlist, typed);
    if (!found) throw new Error(`No independent source called "${typed}". Sources: ${listSources(netlist).join(", ") || "none"}.`);
    return found;
  };
  switch (input.type) {
    case "op": return { type: "op" };
    case "tran": {
      if (!(input.tstop > 0)) throw new Error("tran needs a positive tstop.");
      if (input.tmax !== undefined && !(input.tmax > 0)) throw new Error("tmax must be positive.");
      return { type: "tran", tstop: input.tstop, tstep: input.tstop / 500, tmax: input.tmax };
    }
    case "ac": {
      if (!(input.fstart > 0) || !(input.fstop > input.fstart)) throw new Error("ac needs fstart > 0 and fstop > fstart.");
      return { type: "ac", sweep: "dec", points: 20, fstart: input.fstart, fstop: input.fstop };
    }
    case "dc": {
      if (typeof input.source !== "string" || !input.step) throw new Error("dc needs source, start, stop and step.");
      return { type: "dc", source: source(input.source), start: input.start, stop: input.stop, step: input.step };
    }
    case "transfer": {
      if (typeof input.output !== "string" || typeof input.source !== "string") throw new Error("transfer needs output and source.");
      return { type: "transfer", output: input.output, source: source(input.source) };
    }
    case "noise": {
      if (typeof input.output !== "string" || typeof input.source !== "string" || !(input.fstart > 0) || !(input.fstop > input.fstart)) {
        throw new Error("noise needs output, source, fstart > 0 and fstop > fstart.");
      }
      return { type: "noise", output: input.output, source: source(input.source), sweep: "dec", points: 20, fstart: input.fstart, fstop: input.fstop };
    }
    default: throw new Error(`Unknown analysis type ${input.type}.`);
  }
}

export async function runTool(doc: Doc, name: string, input: Record<string, any>, simulate: SimulateFn): Promise<unknown> {
  // A person's drag under way ends first, so a tool sees it checked and what a tool does stands.
  if (name !== "list_parts") doc.settle();
  const need = (ref: string) => {
    const comp = doc.findByRef(ref);
    if (!comp) throw new Error(`No component named ${ref}.`);
    return comp;
  };
  switch (name) {
    case "list_parts":
      return PARTS.map((p) => ({
        kind: p.kind, name: p.name, category: p.category,
        pins: p.pins.map((pin) => pin.name),
        params: Object.fromEntries(p.params.map((q) => [q.key, q.default])),
      }));
    case "get_circuit": {
      const netlist = buildNetlist(doc.schematic);
      return {
        name: doc.schematic.name,
        components: doc.schematic.components.map((c) => ({
          ref: c.refDes, kind: c.kind, x: c.x, y: c.y, params: c.params,
          nets: Object.fromEntries(netlist.pinNets.get(c.id) ?? []),
        })),
        warnings: netlist.warnings,
        netlist: netlist.text,
      };
    }
    case "add_component": {
      const part = PART_BY_KIND.get(input.kind);
      for (const [key, value] of Object.entries((input.params ?? {}) as Record<string, string>)) {
        const def = part?.params.find((p) => p.key === key);
        if (part && !def) throw new Error(`${part.name} has no parameter "${key}". It has: ${part.params.map((p) => p.key).join(", ") || "none"}.`);
        if (def?.options && !def.options.includes(value)) throw new Error(`${key} must be one of ${def.options.join(", ")}.`);
        if (def && !def.options && !def.text && readValue(value) === undefined) throw new Error(`"${value}" is not a valid ${def.label.toLowerCase()}.`);
      }
      if (Math.abs(input.x) > 1e5 || Math.abs(input.y) > 1e5) throw new Error("That position is too far from the sheet. Stay within 100000 units.");
      const comp = doc.addPart(input.kind, Math.round(input.x / 10) * 10, Math.round(input.y / 10) * 10, input.params);
      if (input.rotation) comp.rotation = input.rotation;
      doc.notify();
      return { ref: comp.refDes, pins: comp.pins.map((p) => ({ name: p.name, ...pinWorld(comp, p) })) };
    }
    case "connect": {
      const wire = doc.connectPins(need(input.from_ref), input.from_pin, need(input.to_ref), input.to_pin);
      if (!wire) return { ok: true, note: "Those pins were already connected, so nothing changed." };
      doc.notify();
      return wire.points.length ? { ok: true } : { ok: true, note: "No clear wire route, so both pins got the same net label instead. Consider tidy_layout." };
    }
    case "disconnect": {
      doc.disconnectPin(need(input.ref), input.pin);
      doc.notify();
      return { ok: true };
    }
    case "tidy_layout": {
      const done = doc.tidyLayout();
      if (!done) throw new Error("A tidy layout couldn't keep every connection and net name, so the circuit was left as it was.");
      doc.notify();
      const loose = looseNames(doc.schematic);
      return {
        ok: true,
        parts: doc.schematic.components.length,
        wires: doc.schematic.wires.length,
        ...(loose.length ? { note: `Not on any pin, so left below the circuit: ${loose.join(", ")}.` } : {}),
      };
    }
    case "set_parameter": {
      const comp = need(input.ref);
      const def = PART_BY_KIND.get(comp.kind)?.params.find((p) => p.key === input.param);
      const known = def !== undefined || (!PART_BY_KIND.has(comp.kind) && input.param in comp.params);
      if (!known) {
        throw new Error(`${comp.refDes} has no parameter "${input.param}". It has: ${Object.keys(comp.params).join(", ") || "none"}.`);
      }
      if (def?.options && !def.options.includes(input.value)) {
        throw new Error(`${input.param} must be one of ${def.options.join(", ")}.`);
      }
      if (def && !def.options && !def.text && readValue(input.value) === undefined) {
        throw new Error(`"${input.value}" is not a valid ${def.label.toLowerCase()}.`);
      }
      comp.params[input.param] = input.value;
      comp.displayValue = undefined;
      doc.notify();
      return { ok: true };
    }
    case "remove_component": {
      doc.removeComponentAndWires(need(input.ref).id);
      doc.notify();
      return { ok: true };
    }
    case "move_component":
    case "rotate_component": {
      const comp = need(input.ref);
      if (name === "move_component" && (Math.abs(input.x) > 1e5 || Math.abs(input.y) > 1e5)) {
        throw new Error("That position is too far from the sheet. Stay within 100000 units.");
      }
      const done = doc.transformParts([comp], (c) => {
        if (name === "rotate_component") {
          c.rotation = input.rotation;
        } else {
          c.x = Math.round(input.x / 10) * 10;
          c.y = Math.round(input.y / 10) * 10;
        }
      });
      if (!done) throw new Error(`That would change ${comp.refDes}'s connections, so the circuit was left as it was. Try another position.`);
      doc.notify();
      return { ok: true };
    }
    case "name_net": {
      const comp = need(input.ref);
      const pin = comp.pins.find((p) => p.name === input.pin);
      if (!pin) throw new Error(`${comp.refDes} has no pin "${input.pin}". Pins: ${comp.pins.map((p) => p.name).join(", ")}.`);
      const at = pinWorld(comp, pin);
      doc.schematic.labels.push({ id: newId("l"), x: at.x, y: at.y, net: input.net });
      doc.notify();
      return { ok: true };
    }
    case "run_analysis": {
      const netlist = buildNetlist(doc.schematic);
      if (netlist.errors.length) throw new Error(netlist.errors.join(" "));
      const result = await simulate(netlist.text, toRequest(input, netlist.text));
      const extra: Record<string, unknown> = {};
      if (result.transfer) extra.transfer = result.transfer;
      if (result.noise) extra.noise = { ...result.noise, contributions: result.noise.contributions.slice(0, 10) };
      if (typeof input.thd_at_hz === "number" && result.axis && !result.vectors[0]?.im) {
        extra.distortion = result.vectors.filter((v) => v.name.startsWith("v(")).slice(0, 20).map((v) => {
          try {
            const out = fourier(result.axis!.re, v.re, input.thd_at_hz);
            return { name: v.name, thd_percent: fmt(out.thd), fundamental: fmt(out.rows[0].magnitude), dc: fmt(out.dc) };
          } catch (error) {
            return { name: v.name, error: error instanceof Error ? error.message : String(error) };
          }
        });
      }
      if (typeof input.at_hz === "number" && result.axis && result.vectors[0]?.im) {
        const axis = result.axis.re;
        let index = 0;
        while (index < axis.length - 1 && axis[index] < input.at_hz) index++;
        extra.at_frequency = {
          hz: fmt(axis[index]),
          vectors: result.vectors.slice(0, 40).map((v) => ({
            name: v.name,
            magnitude: fmt(Math.hypot(v.re[index], v.im?.[index] ?? 0)),
            phase_deg: fmt((Math.atan2(v.im?.[index] ?? 0, v.re[index]) * 180) / Math.PI),
          })),
        };
      }
      return { connection_warnings: netlist.warnings, ...(summarize(result) as object), ...extra };
    }
    default:
      throw new Error(`Unknown tool ${name}.`);
  }
}
