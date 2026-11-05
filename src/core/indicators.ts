// Turns simulated values into what a part on the sheet should show: a glow or a digit.
import { acRms, settledMean } from "./analyses";
import type { IndicatorSpec, SchComponent } from "./schematic";
import type { SimResult, SimVector } from "./sim";
import {parseSpiceNumber} from '../importer/values';

export interface PartDisplay {
  machine?:{kind:'tank'|'conveyor';fraction:number};
  /** Brightness from 0 to 1. */
  glow?: number;
  /** A digit or reading drawn over the part. */
  text?: string;
}

/** Library parts that behave as indicators. */
function specFor(comp: SchComponent): IndicatorSpec | undefined {
  if (comp.indicator) return comp.indicator;
  if (comp.kind === "led") return { kind: "led", pins: ["A", "K"], reads: "voltage", threshold: 1.5, thresholdUnit: "V" };
  return undefined;
}

export function indicatorParts(components: SchComponent[]): SchComponent[] {
  return components.filter((c) => specFor(c));
}

const senseName = (ref: string, sense: string) => `i(x${ref}.${sense})`.toLowerCase();

/** The vectors a part's display needs, lower case, for keeping during a continuous run. */
export function indicatorVectors(comp: SchComponent, nets: Map<string, string> | undefined, ref: string | undefined): string[] {
  const spec = specFor(comp);
  if (!spec) return [];
  const names: string[] = [];
  if (ref) {
    for (const sense of [spec.sense, ...(spec.senses ?? []), spec.dpSense]) if (sense) names.push(senseName(ref, sense));
  }
  for (const pin of [...spec.pins, ...(spec.common ? [spec.common] : [])]) {
    const net = nets?.get(pin);
    if (net && net !== "0") names.push(`v(${net})`.toLowerCase());
  }
  return names;
}

const SEGMENTS: Record<string, string> = {
  "1111110": "0", "0110000": "1", "1101101": "2", "1111001": "3", "0110011": "4", "1011011": "5",
  "1011111": "6", "0011111": "6", "1110000": "7", "1111111": "8", "1111011": "9", "1110011": "9",
  "1110111": "A", "1001110": "C", "0111101": "d", "1001111": "E", "1000111": "F", "0000000": "",
};

const find = (result: SimResult, name: string): SimVector | undefined => result.vectors.find((v) => v.name.toLowerCase() === name);

function latest(result: SimResult, name: string): number | undefined {
  const vector = find(result, name);
  return vector ? vector.re[vector.re.length - 1] : undefined;
}

/**
 * What the part shows at the newest sample. Returns undefined when the run doesn't include
 * what it needs, so an unread part looks unlit rather than giving a made-up answer.
 */
export function readIndicator(comp: SchComponent, result: SimResult, nets: Map<string, string> | undefined, ref: string | undefined): PartDisplay | undefined {
  const spec = specFor(comp);
  if (!spec) return undefined;
  const volts = (pin: string): number | undefined => {
    const net = nets?.get(pin);
    if (!net) return undefined;
    return net === "0" ? 0 : latest(result, `v(${net})`.toLowerCase());
  };
  const across = () => {
    const a = volts(spec.pins[0]);
    if (a === undefined) return undefined;
    const b = spec.pins[1] === undefined ? 0 : volts(spec.pins[1]);
    return b === undefined ? undefined : a - b;
  };
  const current = (sense: string | undefined) => (sense && ref ? latest(result, senseName(ref, sense)) : undefined);
  const threshold = spec.threshold ?? (spec.thresholdUnit === "A" ? 5e-3 : 2.5);
  if(comp.kind==='holding-tank'||comp.kind==='conveyor'){
    const value=across();if(value===undefined||!Number.isFinite(value))return undefined;
    const tank=comp.kind==='holding-tank',extent=parseSpiceNumber(comp.params[tank?'capacity':'length'])??(tank?100:10);
    return {machine:{kind:tank?'tank':'conveyor',fraction:Math.max(0,Math.min(1,value/Math.max(extent,1e-6)))},text:`${Number(value.toPrecision(3))} ${tank?'L':'m'}`};
  }
  switch (spec.kind) {
    case "led":
    case "probe": {
      const amps = current(spec.sense);
      if (spec.reads === "current" && amps !== undefined) return { glow: amps >= threshold ? 1 : 0 };
      if (spec.reads === "current") return undefined;
      const v = across();
      return v === undefined ? undefined : { glow: v >= threshold ? 1 : 0 };
    }
    case "lamp": {
      const v = across();
      if (v === undefined) return undefined;
      return { glow: Math.min(1, Math.abs(v) / (spec.vmax || 12)) };
    }
    case "sevenseg": {
      let pattern = "";
      for (const sense of spec.senses?.slice(0, 7) ?? []) {
        const amps = current(sense);
        if (amps === undefined) return undefined;
        pattern += amps >= threshold ? "1" : "0";
      }
      if (pattern.length !== 7) return undefined;
      const point = current(spec.dpSense);
      return { text: `${SEGMENTS[pattern] ?? "-"}${point !== undefined && point >= threshold ? "." : ""}` };
    }
    case "hexdigit": {
      let value = 0;
      for (let i = 0; i < spec.pins.length; i++) {
        const v = volts(spec.pins[i]);
        if (v === undefined) return undefined;
        if (v >= threshold) value += 2 ** i;
      }
      return { text: value.toString(16).toUpperCase() };
    }
    case "bargraph": {
      let on = 0;
      const senses = spec.senses ?? [];
      for (let i = 0; i < spec.pins.length; i++) {
        const amps = current(senses[i]);
        const level = amps ?? volts(spec.pins[i]);
        if (level !== undefined && level >= threshold) on++;
      }
      return { glow: spec.pins.length ? on / spec.pins.length : 0 };
    }
    case "voltmeter": {
      const axis = result.axis?.re;
      if (spec.mode === "ac" && axis) {
        const a = nets?.get(spec.pins[0]);
        const b = nets?.get(spec.pins[1]);
        const va = a && a !== "0" ? find(result, `v(${a})`.toLowerCase()) : undefined;
        const vb = b && b !== "0" ? find(result, `v(${b})`.toLowerCase()) : undefined;
        if (!va && !vb) return undefined;
        const wave = Float64Array.from(axis, (_, i) => (va?.re[i] ?? 0) - (vb?.re[i] ?? 0));
        return { text: meter(acRms(wave, axis), "V") };
      }
      const v = across();
      return v === undefined ? undefined : { text: meter(v, "V") };
    }
    case "ammeter": {
      if (!spec.sense || !ref) return undefined;
      const wave = find(result, senseName(ref, spec.sense));
      if (!wave) return undefined;
      const axis = result.axis?.re;
      if (axis && axis.length > 1) return { text: meter(spec.mode === "ac" ? acRms(wave.re, axis) : settledMean(wave.re, axis), "A") };
      return { text: meter(wave.re[wave.re.length - 1], "A") };
    }
  }
}

function meter(value: number, unit: string): string {
  const abs = Math.abs(value);
  if (abs < 1e-12) return `0 ${unit}`;
  if (abs < 1e-3) return `${parseFloat((value * 1e6).toPrecision(3))} u${unit}`;
  if (abs < 1) return `${parseFloat((value * 1e3).toPrecision(3))} m${unit}`;
  return `${parseFloat(value.toPrecision(3))} ${unit}`;
}
