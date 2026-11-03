// Interactive parts carry a behaviour script and a circuit whose values are placeholders: the script
// overwrites them when a simulation starts. This applies what the script would set at that moment,
// using the state saved in the file, so the circuit gives the same answer without running the script.
// It also records how to recompute those values, so the app can change a setting while running.
//
// In a script, ++++fN means entry N-1 of the parameter list.
//
// applyInteractive at the end has no dependency on the rest of the importer beyond number parsing.

import type { IndicatorSpec, InteractiveSpec, SchComponent } from "../core/schematic";
import { parseSpiceNumber, tidyNumber } from "./values";

export interface InteractiveInput {
  template: string;
  parameters: string[];
  /** The part's stored strings; the first holds its key. */
  strings?: string[];
  /** Text the part shows on the sheet, such as "40 %" or "30V". */
  display?: string;
  /** The part's value text, which is where a key shows: "Key = Space", "1MOhm Key=A". */
  label?: string;
  /** Saved animation state, CurIndex on the symbol. */
  state: number;
}

export interface InteractiveResult {
  template: string;
  /** Values for the {param:NAME} tokens this put into the template. */
  params: Record<string, string>;
  spec?: InteractiveSpec;
}

const END = "!!!END-INTERACT";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Finds the parameter behind a word defined as `: word ++++fN ;`. */
function scriptParameter(script: string, word: string, parameters: string[]): string | undefined {
  const match = new RegExp(`:\\s*${word}\\s+\\+\\+\\+\\+[fi](\\d+)`, "i").exec(script);
  return match ? parameters[parseInt(match[1], 10) - 1] : undefined;
}

function scriptConstant(script: string, word: string): number | undefined {
  const match = new RegExp(`([-+\\d.eE]+)\\s+(?:constant|VARIABLE)\\s+${word}\\b`, "i").exec(script);
  return match ? parseFloat(match[1]) : undefined;
}

/** The setting in percent: the sheet's text when it has one, otherwise the script's starting value. */
function settingPercent(script: string, display: string | undefined): number {
  const shown = display ? /^\s*(-?[\d.]+)\s*%/.exec(display) : null;
  if (shown) return parseFloat(shown[1]);
  return scriptConstant(script, "setting") ?? 50;
}

/** Limits the script applies to the setting, as in `0.0001 0.999999 *zeroadj f.min f.max`. */
function factorLimits(script: string): [number, number] {
  const match = /([\d.eE+-]+)\s+([\d.eE+-]+)\s+\*zeroadj\s+f\.min\s+f\.max/.exec(script);
  return match ? [parseFloat(match[1]), parseFloat(match[2])] : [0, 1];
}

/** A fraction of a stored value, which may itself be an expression over circuit parameters. */
function scaled(value: string, factor: number): string {
  const number = parseSpiceNumber(value);
  return number === null ? `{(${value.trim()})*${factor}}` : tidyNumber(number * factor);
}

/** Replaces the value on a circuit line such as `C1 1 2  50e-12`, returning null if it is absent. */
function setValue(tail: string, element: string, token: string): string | null {
  const line = new RegExp(`^([ \\t]*${element}[ \\t]+\\S+[ \\t]+\\S+[ \\t]+)(?:DC[ \\t]+)?\\S+[ \\t]*$`, "im");
  return line.test(tail) ? tail.replace(line, (_, head: string) => `${head}${token}`) : null;
}

/** A key as the app should treat it: one upper-case character, or a name such as "Space". */
export function normalizeKey(stored: string): string | undefined {
  if (stored === " ") return "Space";
  const key = stored.trim();
  if (!key || key.toLowerCase() === "param") return undefined;
  if (key.toLowerCase() === "space") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The first stored string holds the key, a literal space for the space bar. The label is the fallback. */
function keyOf(input: InteractiveInput): string | undefined {
  const stored = normalizeKey(input.strings?.[0] ?? "");
  if (stored) return stored;
  const shown = input.label ? /\bKey\s*=\s*(\S+)/i.exec(input.label) : null;
  return shown ? normalizeKey(shown[1]) : undefined;
}

function variableBase(script: string, input: InteractiveInput): { key?: string; increment?: number } {
  const base: { key?: string; increment?: number } = {};
  const key = keyOf(input);
  if (key) base.key = key;
  const increment = parseSpiceNumber(scriptParameter(script, "increment", input.parameters) ?? "");
  if (increment !== null) base.increment = increment;
  return base;
}

function applyPotentiometer(script: string, tail: string, input: InteractiveInput, out: InteractiveResult): string | null {
  const total = scriptParameter(script, "setresistance", input.parameters);
  if (total === undefined) return null;
  const limits = factorLimits(script);
  const percent = settingPercent(script, input.display);
  const lower = setValue(tail, "R1", "{param:r1}");
  const both = lower === null ? null : setValue(lower, "R2", "{param:r2}");
  if (both === null) return null;
  out.spec = { kind: "variable", percent, ...variableBase(script, input), apply: { mode: "divider", total: total.trim(), limits } };
  const factor = clamp(percent / 100, limits[0], limits[1]);
  out.params.r1 = scaled(total, factor);
  out.params.r2 = scaled(total, 1 - factor);
  return both;
}

function applyReactance(script: string, tail: string, input: InteractiveInput, out: InteractiveResult): string | null {
  const element = /^[ \t]*([CL]1)[ \t]+1[ \t]+2[ \t]/im.exec(tail)?.[1];
  const word = /:\s*(t(?:capacitance|inductance))\s+\+\+\+\+f/i.exec(script)?.[1];
  if (!element || !word) return null;
  const total = scriptParameter(script, word, input.parameters);
  if (total === undefined) return null;
  const limits = factorLimits(script);
  const percent = settingPercent(script, input.display);
  const updated = setValue(tail, element, "{param:value}");
  if (updated === null) return null;
  out.spec = { kind: "variable", percent, ...variableBase(script, input), apply: { mode: "scale", total: total.trim(), limits } };
  out.params.value = scaled(total, clamp(percent / 100, limits[0], limits[1]));
  return updated;
}

function applyVariableSource(script: string, tail: string, input: InteractiveInput, out: InteractiveResult): string | null {
  const target = /value\s+SET_INSTANCE\s+\w+\s+::[VI]\s+(\w+)\s+dc/i.exec(script)?.[1];
  if (!target) return null;
  const max = parseSpiceNumber(scriptParameter(script, "tmaxvalue", input.parameters) ?? "");
  const min = parseSpiceNumber(scriptParameter(script, "tminvalue", input.parameters) ?? "");
  // The sheet shows the output itself, not a percentage.
  const shown = input.display ? parseSpiceNumber(input.display) : null;
  const value = shown ?? (max !== null && min !== null ? min + ((max - min) * settingPercent(script, undefined)) / 100 : null);
  if (value === null) return null;
  const updated = setValue(tail, target, "{param:value}");
  if (updated === null) return null;
  out.params.value = tidyNumber(value);
  if (max !== null && min !== null && max !== min) {
    out.spec = {
      kind: "variable",
      percent: Number((((value - min) / (max - min)) * 100).toPrecision(6)),
      ...variableBase(script, input),
      apply: { mode: "span", min, max },
    };
  }
  return updated;
}

/** Switches and similar: `*animation_state max_states low high STATE volt` picks a level. */
function applyState(script: string, tail: string, input: InteractiveInput, out: InteractiveResult): string | null {
  const form = /\*animation_state\s+max_states\s+(\w+)\s+(\w+)\s+STATE\s+\w+/i.exec(script);
  const momentary = !form && /\bSW_DOWN\b/.test(script) && /\bSW_UP\b/.test(script);
  if (!form && !momentary) return null;
  const low = scriptConstant(script, form ? form[1] : "low");
  const high = scriptConstant(script, form ? form[2] : "high");
  const positions = form ? scriptConstant(script, "max_states") : 2;
  if (low === undefined || high === undefined || !positions || positions < 2) return null;
  // A momentary switch rests in its first position whatever state was saved.
  const position = momentary ? 0 : clamp(input.state, 0, positions - 1);
  const level = low + ((high - low) * position) / (positions - 1);
  let updated: string | null = null;
  const source = /value\s+SET_INSTANCE\s+\w+\s+::V\s+(\w+)\s+dc/i.exec(script)?.[1];
  if (source) {
    const line = new RegExp(`^([ \\t]*${source}[ \\t]+\\S+[ \\t]+\\S+[ \\t]+DC[ \\t]+)\\S+[ \\t]*$`, "im");
    if (line.test(tail)) updated = tail.replace(line, (_, head: string) => `${head}{param:level}`);
  } else if (/SET_MODEL_INSTANCE\s+d_constsource\s+\S+\s+\S+\s+state/i.test(script)) {
    const state = /(d_constsource\s*\(\s*state\s*=\s*)[-\d.]+/i;
    if (state.test(tail)) updated = tail.replace(state, "$1{param:level}");
  }
  if (updated === null) return null;
  out.params.level = tidyNumber(level);
  const key = keyOf(input);
  out.spec = {
    kind: "switch",
    positions,
    position,
    ...(key ? { key } : {}),
    ...(momentary ? { momentary: true } : {}),
    apply: { low, high },
  };
  return updated;
}

/** A lamp is cold until a simulation shows otherwise: `R_OFF` is vmax squared over pmax. */
function applyBulb(script: string, tail: string): string | null {
  const vmax = /:\s*vmax\s+([\d.eE+-]+)/i.exec(script);
  const pmax = /:\s*pmax\s+([\d.eE+-]+)/i.exec(script);
  if (!vmax || !pmax || parseFloat(pmax[1]) <= 0) return null;
  return setValue(tail, "R1", tidyNumber(parseFloat(vmax[1]) ** 2 / parseFloat(pmax[1])));
}

/**
 * A meter's current is readable only through a voltage source, so a zero-volt one goes in series
 * with the stored shunt. It changes nothing electrically.
 */
function applyAmmeter(tail: string): string | null {
  const line = /^([ \t]*R1[ \t]+1[ \t]+)2([ \t]+\S+)[ \t]*$/im;
  return line.test(tail) ? tail.replace(line, "$1sense$2\nVsense sense 2 DC 0") : null;
}

/** Returns the template with its placeholder values replaced. Unrecognised parts pass through unchanged. */
export function applyInteractiveState(input: InteractiveInput): InteractiveResult {
  const out: InteractiveResult = { template: input.template, params: {} };
  const text = input.template.replace(/\r\n?/g, "\n");
  const end = text.lastIndexOf(END);
  if (end < 0) return out;
  const lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) return out;
  const script = text.slice(0, lineEnd);
  const tail = text.slice(lineEnd + 1);

  let updated: string | null = null;
  if (/Potentiometer%p/.test(tail)) updated = applyPotentiometer(script, tail, input, out);
  else if (/Variable(Capacitor|Inductor)%p/i.test(tail)) updated = applyReactance(script, tail, input, out);
  else if (/Variable\w*(Voltage|Current)%p/i.test(tail)) updated = applyVariableSource(script, tail, input, out);
  else if (/\bBulb%p/.test(tail)) updated = applyBulb(script, tail);
  else if (/\bAmmeter%p/.test(tail)) updated = applyAmmeter(tail);
  else updated = applyState(script, tail, input, out);

  if (updated === null) return { template: input.template, params: {} };
  return { ...out, template: `${script}\n${updated}` };
}

/**
 * Parts that show the simulation's result. The file holds only the script, so this reads the same
 * facts the script uses: which pins carry the signal and the level at which the part responds.
 */
export function indicatorOf(input: InteractiveInput, pinNames: string[]): IndicatorSpec | undefined {
  const text = input.template.replace(/\r\n?/g, "\n");
  const end = text.lastIndexOf(END);
  if (end < 0) return undefined;
  const script = text.slice(0, end);
  const tail = text.slice(end);
  const level = (word: string) => {
    const stored = scriptParameter(script, word, input.parameters);
    const value = stored === undefined ? null : parseSpiceNumber(stored);
    return value === null ? undefined : value;
  };
  const withLevel = (spec: IndicatorSpec, value: number | undefined): IndicatorSpec =>
    value === undefined ? spec : { ...spec, threshold: value };
  const byNumber = (names: string[]) => [...names].sort((p, q) => parseFloat(p) - parseFloat(q));
  // The script's "i_on" is amps through the part's resistance or LED; each kind below states its unit.
  if (/\bLED_\w*%p/.test(tail)) {
    const anodeFirst = ["A", "K"].filter((p) => pinNames.includes(p));
    return withLevel({ kind: "led", pins: anodeFirst, reads: "current", sense: "v", thresholdUnit: "A" }, level("Ion"));
  }
  if (/\bBAR_LED%p/.test(tail)) {
    const bars = [...tail.matchAll(/^[ \t]*(V\d+)[ \t]+\S+[ \t]+(\d+)[ \t]+DC[ \t]+0/gim)];
    return withLevel({
      kind: "bargraph",
      pins: bars.map((m) => m[2]),
      senses: bars.map((m) => m[1].toLowerCase()),
      reads: "current",
      thresholdUnit: "A",
    }, level("Ion"));
  }
  if (/\bseven_segment\w*%p/i.test(tail)) {
    // Each segment has a sense source in the template's pin order: V1 for A through V8 for the point.
    const order = ["A", "B", "C", "D", "E", "F", "G"];
    return withLevel({
      kind: "sevenseg",
      pins: order,
      senses: order.map((_, i) => `v${i + 1}`),
      dp: "H",
      dpSense: "v8",
      common: "COM",
      // The diodes run from the common pin to the segment pins on a common-anode part.
      activeLow: /^[ \t]*D1[ \t]+10[ \t]+1a/im.test(tail),
      reads: "current",
      thresholdUnit: "A",
    }, level("i_on"));
  }
  if (/\bhex_display%p/.test(tail)) {
    // The script lights a bit at i_on through the part's stored 500 ohms to ground.
    const on = /:\s*i_on\s+([\d.eE+-]+)/i.exec(script);
    const resistance = /^[ \t]*R1[ \t]+1[ \t]+0[ \t]+(\S+)/im.exec(tail);
    const volts = on && resistance ? parseFloat(on[1]) * (parseSpiceNumber(resistance[1]) ?? 500) : 2.5;
    return { kind: "hexdigit", pins: byNumber(pinNames.filter((p) => /^\d+$/.test(p))), reads: "voltage", threshold: volts, thresholdUnit: "V" };
  }
  // The script reads the pin's node voltage and compares it with 0.9.
  if (/\bdig7seg%p/.test(tail)) return { kind: "hexdigit", pins: byNumber(pinNames.filter((p) => /^\d+$/.test(p))), reads: "voltage", threshold: 0.9, thresholdUnit: "V" };
  if (/\bBulb%p/.test(tail)) {
    const vmax = /:\s*vmax\s+([\d.eE+-]+)/i.exec(script);
    const pmax = /:\s*pmax\s+([\d.eE+-]+)/i.exec(script);
    return { kind: "lamp", pins: byNumber(pinNames), reads: "voltage", ...(vmax ? { vmax: parseFloat(vmax[1]) } : {}), ...(pmax ? { pmax: parseFloat(pmax[1]) } : {}) };
  }
  if (/\bProbe_dig%p/.test(tail)) return { kind: "probe", pins: pinNames, reads: "voltage", threshold: 0.9, thresholdUnit: "V" };
  if (/\bProbe%p/.test(tail)) {
    const spec = withLevel({ kind: "probe", pins: pinNames, reads: "voltage" }, level("v_level"));
    return spec.threshold === undefined ? spec : { ...spec, thresholdUnit: "V" };
  }
  const acMode = (input.strings ?? []).some((v) => /^\s*AC\s*$/i.test(v)) ? "ac" : "dc";
  if (/\bAmmeter%p/.test(tail)) return { kind: "ammeter", pins: byNumber(pinNames), reads: "current", sense: "vsense", mode: acMode };
  if (/\bVoltmeter%p/.test(tail)) return { kind: "voltmeter", pins: byNumber(pinNames), reads: "voltage", mode: acMode };
  return undefined;
}

function fractionOf(percent: number, limits: [number, number] | undefined): number {
  const [lo, hi] = limits ?? [0, 1];
  return clamp(percent / 100, lo, hi);
}

/**
 * Returns a copy of an imported part at a new setting: the position of a switch, or the percent of
 * a variable part. Parts that are not interactive come back unchanged. Pure, so the app can call it.
 */
export function applyInteractive(comp: SchComponent, value: number): SchComponent {
  const spec = comp.interactive;
  if (!spec || !Number.isFinite(value)) return comp;
  const params = { ...comp.params };
  if (spec.kind === "switch") {
    const position = clamp(Math.round(value), 0, spec.positions - 1);
    params.level = tidyNumber(spec.apply.low + ((spec.apply.high - spec.apply.low) * position) / (spec.positions - 1));
    const graphics = spec.stateGraphics?.[position];
    return { ...comp, params, interactive: { ...spec, position }, ...(graphics ? { graphics } : {}) };
  }
  const percent = clamp(value, 0, 100);
  const apply = spec.apply;
  if (apply.mode === "span") {
    params.value = tidyNumber(apply.min + ((apply.max - apply.min) * percent) / 100);
  } else if (apply.mode === "divider") {
    const factor = fractionOf(percent, apply.limits);
    params.r1 = scaled(apply.total, factor);
    params.r2 = scaled(apply.total, 1 - factor);
  } else {
    params.value = scaled(apply.total, fractionOf(percent, apply.limits));
  }
  return { ...comp, params, interactive: { ...spec, percent } };
}

/**
 * Checks text typed into one of an imported part's parameters. Returns a message when the value
 * would break the netlist, otherwise undefined. Settings that are not numbers are left alone.
 */
export function validateImportedParam(comp: SchComponent, key: string, value: string): string | undefined {
  const label = comp.paramLabels?.[key] ?? key;
  const current = comp.params[key];
  const numeric = current === undefined || parseSpiceNumber(current) !== null || /^\{.*\}$/.test(current.trim());
  if (!numeric) return undefined;
  const text = value.trim();
  if (!text) return `${label} needs a value.`;
  // Control characters would start a new netlist line.
  if (/[\x00-\x1f\x7f]/.test(value)) return `${label} cannot contain line breaks or control characters.`;
  if (/^\{.*\}$/.test(text)) return text.length > 2 ? undefined : `${label}: the braces are empty. Put an expression inside, such as {2*R1}.`;
  if (parseSpiceNumber(text) === null) return `${label}: "${text}" is not a number. Use a value such as 4.7k, or {name} for a circuit parameter.`;
  // SPICE ignores case, so a capital M silently means milli.
  if (/^[-+]?[\d.]+(?:e[-+]?\d+)?M$/.test(text)) return `${label}: "${text}" would mean milli. Write ${text}eg for mega, or ${text.slice(0, -1)}m for milli.`;
  return undefined;
}
