// Original logic converter: drives a circuit's inputs through every combination, reads one output, and
// minimizes the result to a sum of products with the Quine-McCluskey method.
import type { Runner } from "./analyses";
import { findVector } from "./analyses";

export interface TruthTable {
  inputs: string[];
  /** One entry per combination, input A as the most significant bit: 1, 0, or undefined when undecided. */
  outputs: (0 | 1 | undefined)[];
  /** Output voltage for each combination. */
  volts: number[];
}

/**
 * Runs an operating point for each combination of the input nets, driven to 0 V or `high` through 1 ohm, and reads the
 * output net against `threshold`. Outputs between 0.8 V and 2 V (for 5 V logic) count as undecided.
 */
export async function truthTable(netlist: string, inputs: { name: string; net: string }[], output: string, run: Runner, high = 5, onProgress?: (done: number, total: number) => void): Promise<TruthTable> {
  if (!inputs.length) throw new Error("Connect at least one input, A to H.");
  if (inputs.length > 8) throw new Error("The logic converter takes up to eight inputs.");
  const total = 1 << inputs.length;
  const outputs: (0 | 1 | undefined)[] = [], volts: number[] = [];
  const body = netlist.replace(/^\s*\.end\s*$/im, "");
  for (let row = 0; row < total; row++) {
    const drives = inputs.map((input, i) => {
      const level = (row >> (inputs.length - 1 - i)) & 1 ? high : 0;
      return `VLCDRIVE_${input.name} lcdrive_${input.name} 0 DC ${level}\nRLCDRIVE_${input.name} lcdrive_${input.name} ${input.net} 1`;
    });
    const result = await run(`${body}\n${drives.join("\n")}\n.end\n`, { type: "op" });
    const v = output === "0" ? 0 : findVector(result, `v(${output})`)?.re[0];
    if (v === undefined) throw new Error("The output isn't connected to anything the simulator solves.");
    volts.push(v);
    outputs.push(v >= 0.4 * high ? 1 : v <= 0.16 * high ? 0 : undefined);
    onProgress?.(row + 1, total);
  }
  return { inputs: inputs.map((i) => i.name), outputs, volts };
}

/** A product term: for each input, 1, 0, or -1 when the input doesn't matter. */
type Implicant = { bits: number[]; covers: Set<number> };

/** Minimal sum of products for the rows that are 1, treating undecided rows as don't-cares. */
export function minimize(inputs: string[], outputs: (0 | 1 | undefined)[]): string {
  const n = inputs.length;
  const ones = outputs.flatMap((v, i) => (v === 1 ? [i] : []));
  const dontCares = outputs.flatMap((v, i) => (v === undefined ? [i] : []));
  if (!ones.length) return "0";
  if (ones.length + dontCares.length === outputs.length) return "1";
  const bitsOf = (m: number) => Array.from({ length: n }, (_, i) => (m >> (n - 1 - i)) & 1);
  // Combine terms that differ in one position until nothing combines; what never combined is prime.
  let current: Implicant[] = [...ones, ...dontCares].map((m) => ({ bits: bitsOf(m), covers: new Set([m]) }));
  const primes: Implicant[] = [];
  const key = (b: number[]) => b.join(",");
  while (current.length) {
    const next = new Map<string, Implicant>();
    const used = new Set<Implicant>();
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const a = current[i].bits, b = current[j].bits;
        let diff = -1, count = 0;
        for (let k = 0; k < n && count < 2; k++) if (a[k] !== b[k]) { diff = k; count++; }
        if (count !== 1 || a[diff] === -1 || b[diff] === -1) continue;
        const bits = [...a];
        bits[diff] = -1;
        used.add(current[i]).add(current[j]);
        const existing = next.get(key(bits));
        const covers = new Set([...current[i].covers, ...current[j].covers]);
        if (existing) for (const c of covers) existing.covers.add(c);
        else next.set(key(bits), { bits, covers });
      }
    }
    for (const term of current) if (!used.has(term) && !primes.some((p) => key(p.bits) === key(term.bits))) primes.push(term);
    current = [...next.values()];
  }
  // Essential primes first, then the cheapest cover of what is left (greedy, which is exact for most small tables).
  const chosen: Implicant[] = [];
  const remaining = new Set(ones);
  for (const m of ones) {
    const covering = primes.filter((p) => p.covers.has(m));
    if (covering.length === 1 && !chosen.includes(covering[0])) chosen.push(covering[0]);
  }
  for (const p of chosen) for (const m of p.covers) remaining.delete(m);
  while (remaining.size) {
    const best = primes.filter((p) => !chosen.includes(p)).sort((a, b) =>
      [...b.covers].filter((m) => remaining.has(m)).length - [...a.covers].filter((m) => remaining.has(m)).length
      || a.bits.filter((x) => x !== -1).length - b.bits.filter((x) => x !== -1).length)[0];
    chosen.push(best);
    for (const m of best.covers) remaining.delete(m);
  }
  const term = (p: Implicant) => p.bits.map((b, i) => (b === -1 ? "" : b ? inputs[i] : `${inputs[i]}'`)).join("") || "1";
  return chosen.map(term).sort().join(" + ");
}

/** Evaluates a sum-of-products expression such as "A'B + C" for one input combination. */
export function evaluate(expression: string, inputs: string[], row: number): 0 | 1 {
  if (expression === "0" || expression === "1") return expression === "1" ? 1 : 0;
  const value = (name: string) => (row >> (inputs.length - 1 - inputs.indexOf(name))) & 1;
  return expression.split("+").some((term) => [...term.trim().matchAll(/([A-H])('?)/g)].every(([, name, not]) => (not ? !value(name) : value(name)))) ? 1 : 0;
}
