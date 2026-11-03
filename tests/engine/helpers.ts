import type { SimResult, SimVector } from "../../src/core/sim";

export function vec(r: SimResult, name: string): SimVector {
  const v = r.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`no vector ${name}; have ${r.vectors.map((x) => x.name).join(", ")}`);
  return v;
}

/** Scalar value of an operating point vector. */
export function op(r: SimResult, name: string): number {
  return vec(r, name).re[0]!;
}

/** Linear interpolation of a vector on the result axis. */
export function at(r: SimResult, name: string, x: number): number {
  const axis = r.axis!.re;
  const y = vec(r, name).re;
  if (x <= axis[0]!) return y[0]!;
  for (let i = 1; i < axis.length; i++) {
    if (axis[i]! >= x) {
      const f = (x - axis[i - 1]!) / (axis[i]! - axis[i - 1]!);
      return y[i - 1]! + f * (y[i]! - y[i - 1]!);
    }
  }
  return y[y.length - 1]!;
}

export function mag(v: SimVector, i: number): number {
  return Math.hypot(v.re[i]!, v.im![i]!);
}

export function phaseDeg(v: SimVector, i: number): number {
  return (Math.atan2(v.im![i]!, v.re[i]!) * 180) / Math.PI;
}

/** Index of the axis point nearest x. */
export function nearest(axis: Float64Array, x: number): number {
  let best = 0;
  for (let i = 1; i < axis.length; i++) {
    if (Math.abs(axis[i]! - x) < Math.abs(axis[best]! - x)) best = i;
  }
  return best;
}

export const VT = (1.380649e-23 * 300.15) / 1.602176634e-19;
