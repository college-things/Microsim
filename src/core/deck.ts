// Plain SPICE files, which open as one block on the sheet.
import { readValue } from "./netlist";
import type { AnalysisRequest } from "./sim";

export interface Deck {
  title: string;
  /** The lines after the title, up to .end. They keep their places, so errors name the file's own lines. */
  body: string;
  analyses: AnalysisRequest[];
}

function readAnalysis(line: string): AnalysisRequest | undefined {
  const words = line.trim().split(/\s+/);
  const numbers = (from: number, count: number) => {
    const values = words.slice(from, from + count).map(readValue);
    return values.length === count && values.every((value) => value !== undefined) ? (values as number[]) : undefined;
  };
  switch (words[0].toLowerCase()) {
    case ".op": return { type: "op" };
    case ".tran": {
      const times = numbers(1, 2);
      return times && times[1] > 0 ? { type: "tran", tstep: times[0] || times[1] / 1000, tstop: times[1] } : undefined;
    }
    case ".ac": {
      const sweep = words[1]?.toLowerCase();
      const values = numbers(2, 3);
      if (!values || (sweep !== "dec" && sweep !== "oct" && sweep !== "lin")) return undefined;
      return { type: "ac", sweep, points: values[0], fstart: values[1], fstop: values[2] };
    }
    case ".dc": {
      const range = numbers(2, 3);
      return range && words[1] ? { type: "dc", source: words[1], start: range[0], stop: range[1], step: range[2] } : undefined;
    }
    default: return undefined;
  }
}

/** Reads a SPICE file, throwing a readable error for anything that isn't one. */
export function parseDeck(text: string): Deck {
  // Tabs, line ends and the end-of-file mark of old DOS editors are all that text files need.
  if (/[\0-\x08\x0e-\x19\x1b-\x1f]/.test(text)) throw new Error("This file isn't a SPICE netlist.");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // A SPICE deck's first line is always its title, and reading stops at .end.
  const end = lines.findIndex((line, i) => i > 0 && /^\s*\.end\s*$/i.test(line));
  const body = lines.slice(1, end < 0 ? undefined : end);
  const parts = body.filter((line) => /^\s*[^\s*.+;\x1a]/.test(line));
  if (!parts.length) throw new Error(lines.join("").trim() ? "This file has no circuit lines after its title." : "This file is empty.");
  const analyses = body.flatMap((line) => readAnalysis(line) ?? []);
  return { title: lines[0], body: body.join("\n"), analyses };
}
