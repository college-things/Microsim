// Turns a stored SPICE template into Ohmlet's {ref}/{pin:NAME}/{param:NAME} form.
//
// Stored tokens, worked out by comparing templates, parameter lists and displayed values:
//   %p             reference designator
//   %m             name of the component's model
//   %tPIN          net on a pin
//   %tPIN?a:b;PIN  net on a pin with a digital prefix choice; both branches name the same net here
//   #N             entry N of the "parameters" list (not "doubles", which can hold unscaled values)
//   %vN?a%v:b%v;   a when parameter N is non-zero, otherwise b
//   %SN            entry N of the "strings" list, verbatim
//   %fA:C:S        parameters[A], [A+S], ... while the offset stays below parameters[C]
//   <expr>, {expr} with #N inside: computed when numeric, otherwise left to the simulator
//   %%             a literal percent sign, as in the XSPICE port type %vd(

import { evaluate, parseSpiceNumber, singleLine, spiceValue } from "./values";

export interface TemplateInput {
  template: string;
  parameters: string[];
  strings: string[];
  modelName?: string;
  /** Pin names as the component knows them, used to find where a %t pin name ends. */
  pinNames: string[];
  /** Renames a stored pin in the output, for parts whose pins Ohmlet names differently. */
  pinAlias?: (name: string) => string;
  /** Rewrites a stored string, for behavioural expressions that name sheet-level nets and parts. */
  mapString?: (text: string) => string;
}

export interface TemplateResult {
  spice: string;
  params: Record<string, string>;
  /** Pin names the template asked for that the component does not have. */
  unknownPins: string[];
  /** Other things that could not be expanded faithfully. */
  problems: string[];
  /** Stored initial conditions whose enable flag is off, so they were left out. */
  ignoredInitialConditions: string[];
}

const PIN_BOUNDARY = /[\s\])?;:,(%]/;

/** Removes interactive script blocks, keeping whatever follows them. */
export function stripInteractive(text: string): { text: string; unterminated: boolean } {
  if (text.indexOf("!!!BEGIN-INTERACT") < 0) return { text, unterminated: false };
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (inside) {
      if (line.indexOf("!!!END-INTERACT") >= 0) inside = false;
    } else if (line.indexOf("!!!BEGIN-INTERACT") >= 0) {
      inside = line.indexOf("!!!END-INTERACT") < 0;
    } else {
      out.push(line);
    }
  }
  return { text: out.join("\n"), unterminated: inside };
}

/** Rewrites the .mergenodes directive, which SPICE lacks, as a very small resistor. */
export function rewriteMergeNodes(text: string): string {
  if (!/\.mergenodes/i.test(text)) return text;
  let n = 0;
  return text.replace(/^[ \t]*\.mergenodes[ \t]+(\S+)[ \t]+(\S+)[ \t]*$/gim, (_, a: string, b: string) => `Rmerge_${++n} ${a} ${b} 1u`);
}

const NAMED_LABELS: Record<string, string> = {
  TEMP: "Temperature", TC1: "Temperature coefficient 1", TC2: "Temperature coefficient 2",
  TNOM: "Nominal temperature", IC: "Initial condition",
};
const SIN_LABELS = ["Offset", "Amplitude", "Frequency", "Delay", "Damping", "Phase"];
const PULSE_LABELS = ["Initial value", "Pulsed value", "Delay", "Rise time", "Fall time", "Pulse width", "Period"];
const FIRST_VALUE_LABELS: Record<string, string> = { r: "Resistance", c: "Capacitance", l: "Inductance", e: "Voltage gain" };

/** Names for stored parameters, as far as the template's own text establishes them. */
export function labelParameters(template: string): Record<string, string> {
  const text = stripInteractive(template.replace(/\r\n?/g, "\n")).text;
  const labels: Record<string, string> = {};
  const set = (index: string, label: string) => {
    if (labels[`p${index}`] === undefined) labels[`p${index}`] = label;
  };
  for (const m of text.matchAll(/([A-Za-z_]\w*)\s*=\s*#(\d+)/g)) set(m[2], NAMED_LABELS[m[1].toUpperCase()] ?? m[1]);
  for (const m of text.matchAll(/\bdc\s+#(\d+)/gi)) set(m[1], "DC value");
  for (const m of text.matchAll(/\bac\s+#(\d+)(?:\s+#(\d+))?/gi)) {
    set(m[1], "AC magnitude");
    if (m[2]) set(m[2], "AC phase");
  }
  for (const m of text.matchAll(/\b(sin|pulse)\s*\(([^)]*)\)/gi)) {
    const names = m[1].toLowerCase() === "sin" ? SIN_LABELS : PULSE_LABELS;
    m[2].replace(/\+/g, " ").trim().split(/\s+/).forEach((token, i) => {
      const direct = /^#(\d+)$/.exec(token);
      if (direct && names[i]) set(direct[1], names[i]);
    });
  }
  const first = /^\s*([rcle])%p\s+(?:%t\S+\s+){2,4}#(\d+)/im.exec(text);
  if (first) set(first[2], FIRST_VALUE_LABELS[first[1].toLowerCase()]);
  return labels;
}

const OPTION_DEFAULTS: Record<string, number> = { TEMP: 27, TNOM: 27, TC1: 0, TC2: 0 };

/**
 * Old files switch every resistor option on with its default value. Stated on a part, TEMP=27 would
 * pin that part against any temperature the analysis asks for, which the default does not do.
 */
function isDefaultOption(branch: string, parameters: string[]): boolean {
  const match = /^\s*(TEMP|TNOM|TC1|TC2)\s*=\s*#(\d+)\s*$/i.exec(branch);
  if (!match) return false;
  return parseSpiceNumber(parameters[parseInt(match[2], 10)] ?? "") === OPTION_DEFAULTS[match[1].toUpperCase()];
}

/** Sources store unused distortion terms as zeros; they add nothing and few parsers accept them. */
function isZeroDistortion(line: string, params: Record<string, string>): boolean {
  const match = /^\+?\s*distof[12]\s+\{param:(p\d+)\}\s+\{param:(p\d+)\}\s*$/i.exec(line);
  if (!match || parseSpiceNumber(params[match[1]] ?? "0") !== 0 || parseSpiceNumber(params[match[2]] ?? "0") !== 0) return false;
  delete params[match[1]];
  delete params[match[2]];
  return true;
}

/** A model with no parameters changes nothing, so the part can do without it. */
function dropEmptyModel(spice: string): string {
  const match = /^(\S+)((?:[ \t]+\S+)*?)[ \t]+(\S+\{ref\})((?:[ \t]+\S+)*)\n[ \t]*\.model[ \t]+\3[ \t]+\w+\([\s+]*\)[ \t]*$/i.exec(spice);
  return match ? `${match[1]}${match[2]}${match[4]}` : spice;
}

export function expandTemplate(input: TemplateInput): TemplateResult {
  const { parameters, strings } = input;
  const result: TemplateResult = { spice: "", params: {}, unknownPins: [], problems: [], ignoredInitialConditions: [] };
  const alias = input.pinAlias ?? ((name: string) => name);
  const sortedPins = [...input.pinNames].sort((a, b) => b.length - a.length);

  const stripped = stripInteractive(input.template.replace(/\r\n?/g, "\n"));
  if (stripped.unterminated) result.problems.push("Interactive script block has no end marker; the rest of the template was dropped.");
  const text = stripped.text;

  const param = (index: number, raw: boolean): string => {
    if (index >= parameters.length) {
      result.problems.push(`Template refers to parameter ${index}, but the part has ${parameters.length}.`);
      return "0";
    }
    const value = parameters[index];
    if (raw) return value.trim() || "0";
    const name = `p${index}`;
    result.params[name] = spiceValue(value);
    return `{param:${name}}`;
  };

  const readInt = (s: string, at: number): { value: number; next: number } | null => {
    let j = at;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    return j === at ? null : { value: parseInt(s.slice(at, j), 10), next: j };
  };

  const readPin = (s: string, at: number): { name: string; next: number } => {
    for (const pin of sortedPins) {
      if (pin && s.startsWith(pin, at)) {
        const after = s[at + pin.length];
        if (after === undefined || PIN_BOUNDARY.test(after)) return { name: pin, next: at + pin.length };
      }
    }
    let j = at;
    while (j < s.length && !PIN_BOUNDARY.test(s[j])) j++;
    const name = s.slice(at, j);
    if (name && !result.unknownPins.includes(name)) result.unknownPins.push(name);
    return { name, next: j };
  };

  /** Substitutes raw values into an expression and computes it when possible. */
  const expression = (body: string): string => {
    const filled = body.replace(/#(\d+)/g, (_, n: string) => {
      const value = param(parseInt(n, 10), true);
      return /^[\d.]/.test(value) ? value : `(${value})`;
    });
    const value = evaluate(filled);
    return value !== null ? String(value) : `{${filled}}`;
  };

  /** Finds the end of a %vN? conditional, returning the two branches. */
  const conditional = (s: string, at: number) => {
    let depth = 0;
    let colon = -1;
    for (let j = at; j < s.length; j++) {
      if (s[j] !== "%" || s[j + 1] !== "v") continue;
      const after = s[j + 2];
      if (after >= "0" && after <= "9") depth++;
      else if (after === ":" && depth === 0) colon = j;
      else if (after === ";") {
        if (depth === 0) return colon < 0 ? null : { a: s.slice(at, colon), b: s.slice(colon + 3, j), next: j + 3 };
        depth--;
      }
    }
    return null;
  };

  const expand = (s: string): string => {
    let out = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "#") {
        const n = readInt(s, i + 1);
        if (n) {
          out += param(n.value, false);
          i = n.next;
          continue;
        }
      } else if (c === "<" || c === "{") {
        const close = s.indexOf(c === "<" ? ">" : "}", i);
        const newline = s.indexOf("\n", i);
        if (close > 0 && (newline < 0 || close < newline)) {
          const body = s.slice(i + 1, close);
          if (/#\d/.test(body) && body.indexOf("%") < 0) {
            out += expression(body);
            i = close + 1;
            continue;
          }
        }
      } else if (c === "%") {
        const next = s[i + 1];
        if (next === "%") {
          out += "%";
          i += 2;
          continue;
        }
        if (next === "p") {
          out += "{ref}";
          i += 2;
          continue;
        }
        if (next === "m") {
          if (input.modelName) out += singleLine(input.modelName);
          else result.problems.push("Template refers to a model, but the part has none.");
          i += 2;
          continue;
        }
        if (next === "t") {
          const pin = readPin(s, i + 2);
          i = pin.next;
          // A few stored templates write %tPIN%t:... where the rest write %tPIN?%t:...
          if (s[i] === "?" || s.startsWith("%t:", i)) {
            const semi = s.indexOf(";", i);
            if (semi > 0) i = readPin(s, semi + 1).next;
          }
          out += `{pin:${alias(pin.name)}}`;
          continue;
        }
        if (next === "S") {
          const n = readInt(s, i + 2);
          if (n) {
            if (n.value >= strings.length) result.problems.push(`Template refers to string ${n.value}, but the part has ${strings.length}.`);
            // A whole line may be a stored subcircuit body; inside a line, a string stays on that line.
            const wholeLine = (i === 0 || s[i - 1] === "\n") && (n.next === s.length || s[n.next] === "\n");
            const body = (strings[n.value] ?? "").replace(/\r\n?/g, "\n");
            const stored = wholeLine ? rewriteMergeNodes(body) : singleLine(body);
            out += input.mapString ? input.mapString(stored) : stored;
            i = n.next;
            continue;
          }
        }
        if (next === "f") {
          const a = readInt(s, i + 2);
          const b = a && s[a.next] === ":" ? readInt(s, a.next + 1) : null;
          const step = b && s[b.next] === ":" ? readInt(s, b.next + 1) : null;
          if (a && b && step) {
            const count = parseInt(parameters[b.value] ?? "0", 10) || 0;
            const stride = Math.max(step.value, 1);
            const values: string[] = [];
            for (let k = 0; k < count && a.value + k < parameters.length; k += stride) {
              values.push(spiceValue(parameters[a.value + k]));
            }
            out += values.join(" ");
            i = step.next;
            continue;
          }
        }
        if (next === "v") {
          const n = readInt(s, i + 2);
          if (n && s[n.next] === "?") {
            const branches = conditional(s, n.next + 1);
            if (!branches) {
              // One stored template leaves its last conditional open, with the closing bracket inside.
              const flag = parseFloat(parameters[n.value] ?? "0");
              const rest = s.slice(n.next + 1);
              const bracket = rest.indexOf("]");
              if (Number.isFinite(flag) && flag !== 0) out += expand(rest);
              else if (bracket >= 0) out += expand(rest.slice(bracket));
              i = s.length;
              continue;
            }
            {
              const flag = parseFloat(parameters[n.value] ?? "0");
              const on = Number.isFinite(flag) && flag !== 0;
              if (!on && /\bIC\s*=/i.test(branches.a)) {
                const m = /#(\d+)/.exec(branches.a);
                const stored = m ? (parameters[parseInt(m[1], 10)] ?? "").trim() : "";
                if (stored && parseFloat(stored) !== 0) result.ignoredInitialConditions.push(stored);
              }
              if (on && isDefaultOption(branches.a, parameters)) {
                i = branches.next;
                continue;
              }
              out += expand(on ? branches.a : branches.b);
              i = branches.next;
              continue;
            }
          }
          // A conditional with no opening has nothing to choose between.
          if (s.startsWith("%v:%v;", i)) {
            i += 6;
            continue;
          }
        }
      }
      out += c;
      i++;
    }
    return out;
  };

  const lines = expand(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && line.trim() !== "+")
    .filter((line) => !isZeroDistortion(line, result.params));
  result.spice = dropEmptyModel(lines.join("\n"));
  return result;
}
