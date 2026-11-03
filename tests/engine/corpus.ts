// Corpus tally: imports every sample at runtime and counts each engine warning and failure by
// category. Nothing from the samples is stored in the project. Run directly for a full report:
//   CORPUS_OUT=<dir> CORPUS_REQUEST=tran npx vitest run tests/engine/corpus.test --reporter=dot -t nosuchtest
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildNetlist } from "../../src/core/netlist";
import { SimError, type AnalysisRequest, type SimResult } from "../../src/core/sim";
import { simulate } from "../../src/engine";
import { importMs14 } from "../../src/importer";

export const SAMPLE_ROOT = "C:\\Users\\Public\\Documents\\National Instruments\\Circuit Design Suite 14.2\\samples";

export function listSamples(root = SAMPLE_ROOT): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry.toLowerCase().endsWith(".ms14")) found.push(full);
    }
  };
  visit(root);
  return found.sort();
}

export function loadNetlist(file: string): string {
  return buildNetlist(importMs14(new Uint8Array(readFileSync(file))).schematic).text;
}

/** Sample whose file name contains the text, or null when samples are absent. */
export function findSample(part: string): string | null {
  const needle = part.toLowerCase();
  const all = listSamples();
  return all.find((f) => basename(f).toLowerCase() === `${needle}.ms14`) ?? all.find((f) => basename(f).toLowerCase().includes(needle)) ?? null;
}

export interface CorpusRow {
  file: string;
  netlist: string | null;
  importError?: string;
  ok: boolean;
  skipped: number;
  failure?: string;
  failureCode?: string;
  warnings: string[];
  ms: number;
  unknowns: number;
}

/** Group a warning into a stable category, naming device letters, functions and XSPICE models. */
export function categorize(w: string, netlist: string): string {
  let m = /unsupported device ignored: (\S+)(.*)$/.exec(w);
  if (m) {
    const head = m[1]!;
    if (head[0] === "a") {
      const model = m[2]!.trim().split(/\s+/).pop()!;
      const def = new RegExp(`^\\.model\\s+${escapeRe(model)}\\s+(\\w+)`, "im").exec(netlist);
      return `device a: ${def ? def[1]!.toLowerCase() : "no model"}`;
    }
    return `device ${head[0]}`;
  }
  m = /unsupported directive ignored: (\.\w+)/.exec(w);
  if (m) return `directive ${m[1]}`;
  m = /source option '(\w+)'/.exec(w);
  if (m) return `source option ${m[1]}`;
  m = /source function '(\w+)'/.exec(w);
  if (m) return `source function ${m[1]}`;
  m = /ignored unsupported parameters: (.*)$/.exec(w);
  if (m) return "model parameters ignored";
  if (/only one device connection/.test(w)) return "note: single-connection node";
  if (/probably floating/.test(w)) return "note: floating voltage";
  if (/ideal inductor/.test(w)) return "note: source across inductor";
  if (/duplicate/.test(w)) return "note: duplicate definition";
  if (/level \d+ is simulated/.test(w)) return "note: MOS level approximated";
  if (/partial/.test(w)) return "note: run stopped by time limit";
  return w.replace(/Line \d+: /, "").replace(/'[^']*'/g, "'…'").slice(0, 70);
}

export function failureCategory(msg: string): string {
  let m = /unknown function '(\w+)'/.exec(msg);
  if (m) return `unknown function ${m[1]}`;
  m = /unknown name '(\w+)'/.exec(msg);
  if (m) return "unknown name in expression";
  m = /Unknown model/.exec(msg);
  if (m) return "unknown model";
  m = /Unknown subcircuit/.exec(msg);
  if (m) return "unknown subcircuit";
  return msg.replace(/Line \d+: /, "").replace(/'[^']*'/g, "'…'").replace(/[-+]?\d[\d.e+-]*/g, "#").slice(0, 70);
}

/** Warnings that mean part of the circuit was not simulated faithfully. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isSkip(w: string): boolean {
  return /unsupported device|unsupported directive|source function|source option/.test(w);
}

export function runSample(file: string, request: AnalysisRequest, budgetMs: number): CorpusRow {
  const row: CorpusRow = { file: basename(file), netlist: null, ok: false, skipped: 0, warnings: [], ms: 0, unknowns: 0 };
  try {
    row.netlist = loadNetlist(file);
  } catch (e) {
    row.importError = String(e);
    return row;
  }
  const start = Date.now();
  try {
    const stop = (): boolean => Date.now() - start > budgetMs;
    const r: SimResult = simulate(row.netlist, request, { shouldStop: stop });
    row.warnings = r.warnings;
    row.ok = true;
    row.unknowns = r.stats.unknowns;
  } catch (e) {
    if (e instanceof SimError) {
      row.failure = e.message;
      row.failureCode = e.code;
    } else {
      row.failure = `INTERNAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
      row.failureCode = "internal";
    }
  }
  row.ms = Date.now() - start;
  row.skipped = row.warnings.filter(isSkip).length;
  return row;
}

export interface Tally {
  rows: CorpusRow[];
  warnings: Map<string, { count: number; circuits: Set<string> }>;
  failures: Map<string, string[]>;
  modelParams: Map<string, number>;
}

export function tally(rows: CorpusRow[]): Tally {
  const warnings = new Map<string, { count: number; circuits: Set<string> }>();
  const failures = new Map<string, string[]>();
  const modelParams = new Map<string, number>();
  for (const row of rows) {
    for (const w of row.warnings) {
      const key = categorize(w, row.netlist ?? "");
      const entry = warnings.get(key) ?? { count: 0, circuits: new Set<string>() };
      entry.count++;
      entry.circuits.add(row.file);
      warnings.set(key, entry);
      const m = /ignored unsupported parameters: (.*)$/.exec(w);
      if (m) for (const p of m[1]!.split(", ")) modelParams.set(p, (modelParams.get(p) ?? 0) + 1);
    }
    if (row.failure) {
      const key = failureCategory(row.failure);
      failures.set(key, [...(failures.get(key) ?? []), row.file]);
    }
  }
  return { rows, warnings, failures, modelParams };
}

export function report(t: Tally): string {
  const lines: string[] = [];
  const solved = t.rows.filter((r) => r.ok).length;
  const clean = t.rows.filter((r) => r.ok && r.skipped === 0).length;
  lines.push(`samples ${t.rows.length}, imported ${t.rows.filter((r) => r.netlist).length}, solved ${solved}, solved with nothing skipped ${clean}`);
  lines.push("", "failures:");
  for (const [k, v] of [...t.failures].sort((a, b) => b[1].length - a[1].length)) lines.push(`  ${v.length}  ${k}   [${v.slice(0, 4).join("; ")}]`);
  lines.push("", "warnings (occurrences / circuits):");
  for (const [k, v] of [...t.warnings].sort((a, b) => b[1].circuits.size - a[1].circuits.size || b[1].count - a[1].count)) {
    lines.push(`  ${v.count} / ${v.circuits.size}  ${k}`);
  }
  lines.push("", "ignored model parameters (models):");
  lines.push("  " + [...t.modelParams].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, v]) => `${k}:${v}`).join(" "));
  return lines.join("\n");
}

// Set CORPUS_OUT to a directory to run the tally when this file is loaded.
const out = typeof process !== "undefined" ? process.env.CORPUS_OUT : undefined;
if (out) {
  const request: AnalysisRequest =
    process.env.CORPUS_REQUEST === "tran"
      ? { type: "tran", tstep: 1e-6, tstop: 1e-3 }
      : process.env.CORPUS_REQUEST === "coarse"
        ? { type: "tran", tstep: 1e-4, tstop: 20e-3, tmax: 1e-4 }
        : { type: "op" };
  const rows = listSamples().map((f) => {
    const row = runSample(f, request, 5000);
    console.error(`${row.ms}ms ${row.ok ? "ok" : "FAIL"} skipped=${row.skipped} ${row.file}`);
    return row;
  });
  console.log(report(tally(rows)));
  mkdirSync(out, { recursive: true });
  for (const row of rows) {
    if (row.netlist) writeFileSync(join(out, row.file + ".cir"), row.netlist);
  }
  writeFileSync(join(out, "rows.json"), JSON.stringify(rows.map((r) => ({ ...r, netlist: undefined })), null, 1));
}
