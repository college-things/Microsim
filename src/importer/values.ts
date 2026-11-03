// Numbers and small expressions as they appear in stored parameter values.

const SCALE: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, g: 1e9, t: 1e12 };
const NUMBER = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(meg|mil|[fpnumkgt])?([a-z]*)$/i;

/** Reads a SPICE number such as 1k, 4.7n or 1e+007. Returns null when the text is not one. */
export function parseSpiceNumber(text: string): number | null {
  const match = NUMBER.exec(text.trim());
  if (!match) return null;
  const suffix = (match[2] ?? "").toLowerCase();
  const scale = suffix === "meg" ? 1e6 : suffix === "mil" ? 25.4e-6 : suffix ? SCALE[suffix] : 1;
  return parseFloat(match[1]) * scale;
}

/** Evaluates + - * / and parentheses over SPICE numbers. Returns null for anything else. */
export function evaluate(text: string): number | null {
  const s = text.replace(/\s+/g, "");
  if (s.length > 400) return null;
  let i = 0;
  const factor = (): number | null => {
    const c = s[i];
    if (c === "-" || c === "+") {
      i++;
      const v = factor();
      return v === null ? null : c === "-" ? -v : v;
    }
    if (c === "(") {
      i++;
      const v = sum();
      if (v === null || s[i] !== ")") return null;
      i++;
      return v;
    }
    const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?(?:meg|mil|[fpnumkgt])?/i.exec(s.slice(i, i + 40));
    if (!match) return null;
    i += match[0].length;
    return parseSpiceNumber(match[0]);
  };
  const product = (): number | null => {
    let v = factor();
    while (v !== null && (s[i] === "*" || s[i] === "/")) {
      const op = s[i++];
      const r = factor();
      if (r === null) return null;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = product();
    while (v !== null && (s[i] === "+" || s[i] === "-")) {
      const op = s[i++];
      const r = product();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const value = sum();
  return value !== null && i === s.length && Number.isFinite(value) ? value : null;
}

/** A value that is not a plain number is an expression and needs braces in SPICE. */
export function spiceValue(raw: string): string {
  const value = raw.trim();
  if (!value) return "0";
  if (parseSpiceNumber(value) !== null) return value;
  if (value.startsWith("{") && value.endsWith("}")) return value;
  return `{${value}}`;
}

/**
 * Stored part values write mega as a capital M: 2M sits beside 2000000 in the doubles list. SPICE
 * ignores case, so left alone it would read as milli.
 */
export function normalizeStoredValue(raw: string): string {
  return raw.replace(/^(\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)M(?![iI][lL]|[eE][gG])/, "$1Meg");
}

/** Drops binary noise such as 0.0000049999999999999996. */
export function tidyNumber(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/** For anything substituted into one netlist line: without control characters it cannot start another. */
export function singleLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/** Display text keeps its line breaks and nothing else unprintable. */
export function displayText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}
