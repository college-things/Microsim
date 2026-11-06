// Original curve tracer: DC sweeps added at the IV analyzer's pins. For clean curves the device under test
// should be wired only to the analyzer, as anything else connected becomes part of the measurement.
import { findVector, type Runner } from "./analyses";

export type IvMode = "two-terminal" | "npn" | "pnp" | "nmos" | "pmos";

export interface IvCurve {
  label: string;
  volts: Float64Array;
  amps: Float64Array;
}

export interface IvSettings {
  mode: IvMode;
  /** Sweep end, in volts; the sweep runs from `start` (default 0, or -vmax for two-terminal devices). */
  vmax: number;
  start?: number;
  points?: number;
  /** Base currents (BJT) or gate voltages (MOSFET) to step, one curve each. */
  steps?: number[];
}

/** Pin roles: two-terminal uses 1 (+) and 2 (-); BJTs 1 = C, 2 = B, 3 = E; MOSFETs 1 = D, 2 = G, 3 = S. */
export async function ivCurves(netlist: string, nets: Record<"1" | "2" | "3", string | undefined>, settings: IvSettings, run: Runner): Promise<IvCurve[]> {
  const body = netlist.replace(/^\s*\.end\s*$/im, "");
  const need = settings.mode === "two-terminal" ? (["1", "2"] as const) : (["1", "2", "3"] as const);
  for (const pin of need) if (!nets[pin]) throw new Error(`Connect pin ${pin} of the IV analyzer.`);
  if (!(settings.vmax > 0)) throw new Error("The sweep end must be greater than zero.");
  const points = Math.max(10, Math.min(1000, Math.round(settings.points ?? 200)));
  const negative = settings.mode === "pnp" || settings.mode === "pmos";
  const sign = negative ? -1 : 1;
  const start = settings.start ?? (settings.mode === "two-terminal" ? -settings.vmax : 0);
  const stop = settings.vmax;
  const step = (stop - start) / points;
  const sweep = async (lines: string[], label: string): Promise<IvCurve> => {
    const result = await run(`${body}\n${lines.join("\n")}\n.end\n`, { type: "dc", source: "VIVSWEEP", start: sign * start, stop: sign * stop, step: sign * step });
    const volts = result.axis?.re;
    const current = findVector(result, "i(vivsweep)")?.re;
    if (!volts || !current) throw new Error("The sweep produced no data.");
    // SPICE reports a source's current flowing in at its + terminal; the device's current is the reverse.
    return { label, volts: Float64Array.from(volts, (v) => v * sign), amps: Float64Array.from(current, (i) => -i * sign) };
  };
  const [a, b, c] = [nets["1"]!, nets["2"]!, nets["3"]];
  if (settings.mode === "two-terminal") return [await sweep([`VIVSWEEP ${a} ${b} DC 0`], "Device")];
  const steps = settings.steps?.length ? settings.steps : settings.mode === "npn" || settings.mode === "pnp" ? [10e-6, 20e-6, 30e-6, 40e-6, 50e-6] : [2, 3, 4, 5, 6];
  const curves: IvCurve[] = [];
  for (const value of steps) {
    if (settings.mode === "npn" || settings.mode === "pnp") {
      // Base current from the emitter side into the base (out of it for PNP).
      curves.push(await sweep([`VIVSWEEP ${a} ${c} DC 0`, `IIVSTEP ${negative ? `${b} ${c}` : `${c} ${b}`} DC ${Math.abs(value)}`], `Ib = ${value * 1e6} uA`));
    } else {
      curves.push(await sweep([`VIVSWEEP ${a} ${c} DC 0`, `VIVSTEP ${b} ${c} DC ${sign * Math.abs(value)}`], `Vgs = ${sign * Math.abs(value)} V`));
    }
  }
  return curves;
}
