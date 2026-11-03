// Time functions for independent sources.

export interface Waveform {
  at(t: number): number;
  /** First corner strictly after t + eps, Infinity if none. */
  nextBreak(t: number, eps: number): number;
  /** Fill defaults that depend on the transient request. */
  setDefaults(tstep: number, tstop: number): void;
  /** Corners a run to tstop will meet, for rejecting absurd waveforms early. */
  corners(tstop: number): number;
  /** The largest step that still lets error control see this waveform move. */
  maxStep(): number;
}

/** A sinusoid needs a few samples per cycle before truncation error can react to it. */
const SAMPLES_PER_CYCLE = 8;

export class Pulse implements Waveform {
  private tr: number;
  private tf: number;
  private pw: number;
  private per: number;

  constructor(
    private readonly v1: number,
    private readonly v2: number,
    private readonly td: number,
    private readonly trIn: number,
    private readonly tfIn: number,
    private readonly pwIn: number,
    private readonly perIn: number,
  ) {
    this.tr = trIn;
    this.tf = tfIn;
    this.pw = pwIn;
    this.per = perIn;
  }

  setDefaults(tstep: number, tstop: number): void {
    this.tr = this.trIn > 0 ? this.trIn : tstep;
    this.tf = this.tfIn > 0 ? this.tfIn : tstep;
    this.pw = this.pwIn > 0 ? this.pwIn : tstop;
    this.per = this.perIn > 0 ? this.perIn : tstop;
  }

  corners(tstop: number): number {
    return this.per > 0 ? (4 * tstop) / this.per : 4;
  }

  maxStep(): number {
    return Infinity;
  }

  at(t: number): number {
    const { v1, v2, tr, tf, pw, per } = this;
    let u = t - this.td;
    if (u < 0) return v1;
    if (per > 0 && u >= per) u -= Math.floor(u / per) * per;
    if (u < tr) return tr > 0 ? v1 + ((v2 - v1) * u) / tr : v2;
    if (u < tr + pw) return v2;
    if (u < tr + pw + tf) return tf > 0 ? v2 + ((v1 - v2) * (u - tr - pw)) / tf : v1;
    return v1;
  }

  nextBreak(t: number, eps: number): number {
    const { td, tr, pw, tf, per } = this;
    const limit = t + eps;
    if (td > limit) return td;
    let k = per > 0 ? Math.floor((t - td) / per) : 0;
    if (k < 0) k = 0;
    for (let n = 0; n < 3; n++) {
      const base = td + (k + n) * per;
      const c1 = base;
      const c2 = base + tr;
      const c3 = c2 + pw;
      const c4 = c3 + tf;
      if (c1 > limit) return c1;
      if (c2 > limit) return c2;
      if (c3 > limit) return c3;
      if (c4 > limit) return c4;
      if (per <= 0) break;
    }
    return Infinity;
  }
}

export class Sin implements Waveform {
  private freq: number;
  private readonly phaseRad: number;

  constructor(
    private readonly vo: number,
    private readonly va: number,
    private readonly freqIn: number,
    private readonly td: number,
    private readonly theta: number,
    phaseDeg: number,
  ) {
    this.freq = freqIn;
    this.phaseRad = (phaseDeg * Math.PI) / 180;
  }

  setDefaults(_tstep: number, tstop: number): void {
    this.freq = this.freqIn > 0 ? this.freqIn : 1 / tstop;
  }

  corners(): number {
    return 1;
  }

  maxStep(): number {
    return this.va !== 0 && this.freq > 0 ? 1 / (SAMPLES_PER_CYCLE * this.freq) : Infinity;
  }

  at(t: number): number {
    const u = t - this.td;
    if (u <= 0) return this.vo + this.va * Math.sin(this.phaseRad);
    const damp = this.theta !== 0 ? Math.exp(-this.theta * u) : 1;
    return this.vo + this.va * damp * Math.sin(2 * Math.PI * this.freq * u + this.phaseRad);
  }

  nextBreak(t: number, eps: number): number {
    return this.td > t + eps ? this.td : Infinity;
  }
}

export class Exp implements Waveform {
  private tau1: number;
  private td2: number;
  private tau2: number;

  constructor(
    private readonly v1: number,
    private readonly v2: number,
    private readonly td1: number,
    private readonly tau1In: number,
    private readonly td2In: number,
    private readonly tau2In: number,
  ) {
    this.tau1 = tau1In > 0 ? tau1In : 1;
    this.td2 = td2In > 0 ? td2In : Infinity;
    this.tau2 = tau2In > 0 ? tau2In : 1;
  }

  setDefaults(tstep: number, _tstop: number): void {
    this.tau1 = this.tau1In > 0 ? this.tau1In : tstep;
    this.td2 = this.td2In > 0 ? this.td2In : this.td1 + tstep;
    this.tau2 = this.tau2In > 0 ? this.tau2In : tstep;
  }

  corners(): number {
    return 2;
  }

  maxStep(): number {
    return Infinity;
  }

  at(t: number): number {
    const { v1, v2, td1, tau1, td2, tau2 } = this;
    if (t <= td1) return v1;
    let v = v1 + (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1));
    if (t > td2) v += (v1 - v2) * (1 - Math.exp(-(t - td2) / tau2));
    return v;
  }

  nextBreak(t: number, eps: number): number {
    if (this.td1 > t + eps) return this.td1;
    if (this.td2 > t + eps) return this.td2;
    return Infinity;
  }
}

/** SFFM(VO VA FC MDI FS): VO + VA sin(2 pi FC t + MDI sin(2 pi FS t)). */
export class Sffm implements Waveform {
  private fc: number;
  private fs: number;
  constructor(
    private readonly vo: number,
    private readonly va: number,
    private readonly fcIn: number,
    private readonly mdi: number,
    private readonly fsIn: number,
  ) {
    this.fc = fcIn;
    this.fs = fsIn;
  }
  setDefaults(_tstep: number, tstop: number): void {
    this.fc = this.fcIn > 0 ? this.fcIn : 1 / tstop;
    this.fs = this.fsIn > 0 ? this.fsIn : 1 / tstop;
  }

  corners(): number {
    return 0;
  }

  maxStep(): number {
    return 1 / (SAMPLES_PER_CYCLE * (this.fc + this.mdi * this.fs));
  }
  at(t: number): number {
    const w = 2 * Math.PI;
    return this.vo + this.va * Math.sin(w * this.fc * t + this.mdi * Math.sin(w * this.fs * t));
  }
  nextBreak(): number {
    return Infinity;
  }
}

/** AM(SA OC FM FC TD): SA (OC + sin(2 pi FM (t-TD))) sin(2 pi FC (t-TD)), silent before TD. */
export class Am implements Waveform {
  private fm: number;
  private fc: number;
  constructor(
    private readonly sa: number,
    private readonly oc: number,
    private readonly fmIn: number,
    private readonly fcIn: number,
    private readonly td: number,
  ) {
    this.fm = fmIn;
    this.fc = fcIn;
  }
  setDefaults(_tstep: number, tstop: number): void {
    this.fm = this.fmIn > 0 ? this.fmIn : 5 / tstop;
    this.fc = this.fcIn > 0 ? this.fcIn : 500 / tstop;
  }

  corners(): number {
    return 1;
  }

  maxStep(): number {
    return 1 / (SAMPLES_PER_CYCLE * (this.fc + this.fm));
  }
  at(t: number): number {
    const u = t - this.td;
    if (u <= 0) return 0;
    const w = 2 * Math.PI;
    return this.sa * (this.oc + Math.sin(w * this.fm * u)) * Math.sin(w * this.fc * u);
  }
  nextBreak(t: number, eps: number): number {
    return this.td > t + eps ? this.td : Infinity;
  }
}

export class Pwl implements Waveform {
  /** times and values have the same length; times are non-decreasing. */
  constructor(
    private readonly times: Float64Array,
    private readonly values: Float64Array,
    private readonly delay = 0,
    private readonly repeatFrom = -1,
  ) {}

  setDefaults(): void {}

  maxStep(): number {
    return Infinity;
  }

  corners(tstop: number): number {
    const end = this.times[this.times.length - 1] ?? 0;
    const n = this.times.length;
    if (this.repeatFrom >= 0 && end > this.repeatFrom) return n + (n * Math.max(0, tstop - this.delay - end)) / (end - this.repeatFrom);
    return n;
  }

  /** Map time onto the table, applying TD= and looping from R= when given. */
  private local(t: number): number {
    const u = t - this.delay;
    const { times, repeatFrom } = this;
    const end = times[times.length - 1] ?? 0;
    if (repeatFrom >= 0 && u > end && end > repeatFrom) {
      return repeatFrom + ((u - repeatFrom) % (end - repeatFrom));
    }
    return u;
  }

  at(tIn: number): number {
    const t = this.local(tIn);
    const { times, values } = this;
    const n = times.length;
    if (n === 0) return 0;
    if (t <= times[0]!) return values[0]!;
    if (t >= times[n - 1]!) return values[n - 1]!;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid;
      else hi = mid;
    }
    const dt = times[hi]! - times[lo]!;
    if (dt <= 0) return values[hi]!;
    return values[lo]! + ((values[hi]! - values[lo]!) * (t - times[lo]!)) / dt;
  }

  nextBreak(tIn: number, eps: number): number {
    const { times, repeatFrom } = this;
    const t = tIn - this.delay;
    const end = times[times.length - 1] ?? 0;
    if (repeatFrom >= 0 && t + eps >= end && end > repeatFrom) {
      const period = end - repeatFrom;
      const base = end + Math.floor((t + eps - end) / period) * period;
      for (let k = 0; k < 2; k++) {
        for (let i = 0; i < times.length; i++) {
          if (times[i]! < repeatFrom) continue;
          const tc = base + k * period + (times[i]! - repeatFrom);
          if (tc > t + eps) return tc + this.delay;
        }
      }
      return Infinity;
    }
    const limit = t + eps;
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! > limit) hi = mid;
      else lo = mid + 1;
    }
    return lo < times.length ? times[lo]! + this.delay : Infinity;
  }
}
