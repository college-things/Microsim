// Reads analysis settings from the SimState attribute: NAME:list{...} NAME:long{..} and so on.
import type { AnalysisRequest } from "../core/sim";
import type { ImportIssue } from "../core/schematic";
import { parseSpiceNumber } from "./values";

export type SimEntry = [string, string | SimEntry[]];

const MAX_DEPTH = 64;
const MAX_ENTRIES = 2_000_000;

/** Tolerant parser: stops quietly at the end of text and never revisits input. */
export function parseSimState(text: string): SimEntry[] {
  let i = 0;
  let entries = 0;
  const n = text.length;
  const list = (depth: number): SimEntry[] => {
    const out: SimEntry[] = [];
    for (;;) {
      while (i < n && text.charCodeAt(i) <= 32) i++;
      if (i >= n) return out;
      if (text[i] === "}") {
        i++;
        // Some files close more lists than they open; what follows at the top is still data.
        if (depth === 0) continue;
        return out;
      }
      const colon = text.indexOf(":", i);
      const brace = colon < 0 ? -1 : text.indexOf("{", colon);
      if (brace < 0) {
        i = n;
        return out;
      }
      const key = text.slice(i, colon).trim();
      const type = text.slice(colon + 1, brace);
      i = brace + 1;
      if (++entries > MAX_ENTRIES) {
        i = n;
        return out;
      }
      if (type === "list") {
        if (depth >= MAX_DEPTH) {
          i = n;
          return out;
        }
        out.push([key, list(depth + 1)]);
      } else {
        const end = text.indexOf("}", i);
        if (end < 0) {
          i = n;
          return out;
        }
        out.push([key, text.slice(i, end)]);
        i = end + 1;
      }
    }
  };
  return list(0);
}

function get(entries: SimEntry[] | undefined, key: string): string | SimEntry[] | undefined {
  if (!entries) return undefined;
  for (const [k, v] of entries) if (k === key) return v;
  return undefined;
}
const getList = (entries: SimEntry[] | undefined, key: string): SimEntry[] | undefined => {
  const value = get(entries, key);
  return Array.isArray(value) ? value : undefined;
};
const getText = (entries: SimEntry[] | undefined, key: string): string | undefined => {
  const value = get(entries, key);
  return typeof value === "string" ? value : undefined;
};
const getNumber = (entries: SimEntry[] | undefined, key: string): number | undefined => {
  const value = getText(entries, key);
  const number = value === undefined ? null : parseSpiceNumber(value);
  return number === null ? undefined : number;
};

const ACTIVE_LABEL: Record<string, string> = {
  dcOpPoint: "DC operating point", ac: "AC sweep", transient: "transient", dcSweep: "DC sweep",
};

/** Maps the settings that have an Microsim equivalent, in the order the file lists them. */
export function mapAnalyses(simState: string, active: string, issues: ImportIssue[], resolveSource?: (name: string) => string | undefined): AnalysisRequest[] {
  const out: AnalysisRequest[] = [];
  const root = parseSimState(simState);
  const listed = getList(getList(root, "SIMULATION_INFO"), "ANALYSES");
  if (!listed) {
    if (simState.trim()) issues.push({ severity: "warning", message: "Analyses: the stored simulation settings could not be read." });
    return out;
  }
  // In 30 of the samples the parameter sweep's nested settings close the list early, leaving the
  // analyses after it, DC sweep among them, at the top level.
  const seen = new Set<string>();
  for (const [name, value] of [...listed, ...root]) {
    if (!Array.isArray(value) || seen.has(name)) continue;
    seen.add(name);
    const settings = getList(value, "ANALYSIS");
    if (name === "OP") {
      out.push({ type: "op" });
    } else if (name === "AC" && settings) {
      const fstart = getNumber(settings, "FSTART");
      const fstop = getNumber(settings, "FSTOP");
      const points = getNumber(settings, "NPOINTS_PER_VARIATION");
      const variation = (getText(settings, "VARIATION") ?? "dec").toLowerCase();
      if (fstart !== undefined && fstop !== undefined && points !== undefined) {
        const sweep = variation === "lin" || variation === "oct" ? variation : "dec";
        out.push({ type: "ac", sweep, points, fstart, fstop });
      } else if (active === "ac") {
        issues.push({ severity: "warning", message: "Analyses: AC sweep settings are incomplete." });
      }
    } else if (name === "TRAN" && settings) {
      const tstop = getNumber(settings, "TSTOP");
      if (tstop === undefined || tstop <= 0) {
        if (active === "transient") issues.push({ severity: "warning", message: "Analyses: transient settings are incomplete." });
        continue;
      }
      const points = getNumber(settings, "TPOINTS");
      const tstep = getNumber(settings, "TSTEP") ?? tstop / (points && points > 0 ? points : 1000);
      const request: AnalysisRequest = { type: "tran", tstep, tstop };
      const tstart = getNumber(settings, "TSTART");
      if (tstart) request.tstart = tstart;
      const tmax = getNumber(settings, "TMAX");
      if (tmax) request.tmax = tmax;
      const ic = getText(settings, "IC");
      if (ic === "uic" || ic === "zero_ic") request.uic = true;
      if (ic === "zero_ic" && active === "transient") {
        issues.push({ severity: "info", message: "Analyses: 'set to zero' initial conditions mapped to UIC." });
      }
      out.push(request);
    } else if (name === "DC_SWEEP" && settings) {
      const source = getText(settings, "Source1");
      const start = getNumber(settings, "Start1");
      const stop = getNumber(settings, "Stop1");
      const step = getNumber(settings, "Increment1");
      // The file names the source as SPICE would; a default name may match nothing in this circuit.
      const resolved = source && resolveSource ? resolveSource(source) : source;
      if (source && !resolved) {
        if (active === "dcSweep") issues.push({ severity: "warning", message: `Analyses: DC sweep source ${source} is not in the circuit.` });
      } else if (resolved && start !== undefined && stop !== undefined && step) {
        out.push({ type: "dc", source: resolved, start, stop, step });
        if (getNumber(settings, "UseSource2")) {
          issues.push({ severity: "warning", message: `Analyses: the second DC sweep source (${getText(settings, "Source2")}) was dropped.` });
        }
      } else if (active === "dcSweep") {
        issues.push({ severity: "warning", message: "Analyses: DC sweep has no source or step." });
      }
    }
  }
  if (active && active !== "interactive") {
    if (ACTIVE_LABEL[active]) {
      issues.push({ severity: "info", message: `Analyses: the file's active analysis is ${ACTIVE_LABEL[active]}.` });
    } else {
      issues.push({ severity: "warning", message: `Analyses: the file's active analysis (${active}) has no Microsim equivalent and was not imported.` });
    }
  }
  return out;
}
