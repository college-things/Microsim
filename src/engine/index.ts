// Ohmlet simulation engine entry point. Synchronous and free of DOM and Node APIs,
// so it can run inside a Web Worker.

import { SimError, type AnalysisRequest, type LiveChunk, type LiveSession, type SimOptions, type SimResult } from "../core/sim";
import { Analysis, currentTime } from "./analysis";
import { elaborate, parseDeck } from "./netlist";

export function simulate(netlist: string, request: AnalysisRequest, options: SimOptions = {}): SimResult {
  try {
    return run(netlist, request, options);
  } catch (e) {
    // Runaway recursion or an impossible allocation, from a deeply nested or enormous netlist.
    if (e instanceof RangeError) {
      throw new SimError(`The netlist is too large or too deeply nested to simulate (${e.message})`, "unsupported");
    }
    throw e;
  }
}

/**
 * Start a transient that continues across calls. The operating point, or the uic start, is solved
 * here; advance() then integrates on, and returns only the samples it made.
 */
export function createLiveSession(netlist: string, options: { tmax?: number; uic?: boolean } = {}): LiveSession {
  const guarded = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof RangeError) {
        throw new SimError(`The netlist is too large or too deeply nested to simulate (${e.message})`, "unsupported");
      }
      throw e;
    }
  };
  return guarded(() => {
    let circuit = elaborate(parseDeck(netlist));
    circuit.build();
    let analysis = new Analysis(circuit, {});
    const run = analysis.startLive(options.tmax, options.uic === true);
    let first = true;
    const names = analysis.outputNames();
    return {
      names,
      get warnings(): string[] {
        return circuit.warnings;
      },
      update(text: string): boolean {
        try {
          const next = elaborate(parseDeck(text));
          next.build();
          if (!circuit.sameStructure(next)) return false;
          const nextAnalysis = new Analysis(next, {});
          nextAnalysis.resumeFrom(analysis, run);
          for (const w of circuit.warnings) next.warn(w);
          circuit = next;
          analysis = nextAnalysis;
          return true;
        } catch (e) {
          // A netlist that cannot be read goes back to the caller, whose restart reports it properly.
          if (e instanceof SimError || e instanceof RangeError) return false;
          throw e;
        }
      },
      get time(): number {
        return analysis.liveTime(run);
      },
      advance(untilTime: number, budgetMs: number): LiveChunk {
        if (!(untilTime >= 0) || !Number.isFinite(untilTime)) {
          throw new SimError("Live session time must be finite and not negative", "parse");
        }
        return guarded(() => {
          const col = analysis.liveChunk(run, first, untilTime, budgetMs);
          first = false;
          const values = col.vectors().map((v) => v.re);
          return { time: col.axisValues(), values };
        });
      },
    };
  });
}

function run(netlist: string, request: AnalysisRequest, options: SimOptions): SimResult {
  const start = currentTime();
  const circuit = elaborate(parseDeck(netlist));
  circuit.build();
  const analysis = new Analysis(circuit, options);
  switch (request.type) {
    case "op":
      return analysis.op(start);
    case "dc":
      return analysis.dc(request, start);
    case "ac":
      return analysis.ac(request, start);
    case "tran":
      return analysis.tran(request, start);
    case "noise":
      return analysis.noise(request, start);
    case "transfer":
      return analysis.transfer(request, start);
    case "sensitivity":
      return analysis.sensitivity(request, start);
    case "polezero":
      return analysis.polezero(request, start);
  }
}
