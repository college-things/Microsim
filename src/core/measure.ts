// Original measurement code for the frequency counter, spectrum analyzer and word generator instruments.

export interface CounterReading {
  frequency: number;
  period: number;
  /** Fraction of each period spent above the threshold, 0 to 1. */
  duty: number;
  highTime: number;
  lowTime: number;
  peakToPeak: number;
  threshold: number;
  /** Whole periods the reading averages over. */
  cycles: number;
}

/** Crossing time between samples i-1 and i, where the signal passes `level`. */
function crossing(time: ArrayLike<number>, values: ArrayLike<number>, i: number, level: number): number {
  const v0 = values[i - 1], v1 = values[i];
  return v1 === v0 ? time[i] : time[i - 1] + ((level - v0) / (v1 - v0)) * (time[i] - time[i - 1]);
}

/**
 * Counts rising edges through the middle of the signal's swing, with 10% hysteresis so noise near the
 * threshold can't add edges. Only the second half of the data is used, past any start-up. Returns
 * undefined until there are two whole periods.
 */
export function countFrequency(time: ArrayLike<number>, values: ArrayLike<number>, threshold?: number): CounterReading | undefined {
  const n = Math.min(time.length, values.length);
  if (n < 4) return undefined;
  const from = Math.floor(n / 2);
  let low = Infinity, high = -Infinity;
  for (let i = from; i < n; i++) { low = Math.min(low, values[i]); high = Math.max(high, values[i]); }
  const swing = high - low;
  if (!(swing > 1e-9 * Math.max(1, Math.abs(high)))) return undefined;
  const level = threshold ?? (high + low) / 2;
  const band = 0.1 * swing;
  // An edge is timed where it last crossed the threshold, and counted once it clears the hysteresis band.
  const r: number[] = [], f: number[] = [];
  let state = values[from] > level ? 1 : 0;
  let lastUp = NaN, lastDown = NaN;
  for (let i = from + 1; i < n; i++) {
    const a = values[i - 1], b = values[i];
    if (a <= level && b > level) lastUp = crossing(time, values, i, level);
    if (a >= level && b < level) lastDown = crossing(time, values, i, level);
    if (state === 0 && b > level + band / 2 && Number.isFinite(lastUp)) { state = 1; r.push(lastUp); }
    else if (state === 1 && b < level - band / 2 && Number.isFinite(lastDown)) { state = 0; f.push(lastDown); }
  }
  if (r.length < 3) return undefined;
  const cycles = r.length - 1;
  const period = (r[r.length - 1] - r[0]) / cycles;
  // High time: from each counted rise to the next fall.
  let high_ = 0, counted = 0;
  for (let k = 0; k < cycles; k++) {
    const fall = f.find((t) => t > r[k] && t < r[k + 1]);
    if (fall !== undefined) { high_ += fall - r[k]; counted++; }
  }
  const highTime = counted ? high_ / counted : NaN;
  return { frequency: 1 / period, period, duty: highTime / period, highTime, lowTime: period - highTime, peakToPeak: swing, threshold: level, cycles };
}

/** In-place radix-2 FFT. `re` and `im` must have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n & (n - 1)) throw new Error("FFT length must be a power of two.");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k), wi = Math.sin(step * k);
        const a = start + k, b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

export interface Spectrum {
  frequency: Float64Array;
  /** Amplitude of each bin in volts (peak), corrected for the window. */
  amplitude: Float64Array;
  /** Bin spacing in hertz. */
  resolution: number;
  peak: { frequency: number; amplitude: number };
}

/**
 * Amplitude spectrum of the last `span` seconds (all the data when omitted), resampled uniformly to `points`
 * samples (a power of two) and Hann-windowed. The mean is removed, so bin 0 shows only drift.
 */
export function spectrum(time: ArrayLike<number>, values: ArrayLike<number>, points = 4096, span?: number): Spectrum | undefined {
  const n = Math.min(time.length, values.length);
  if (n < 8) return undefined;
  const end = time[n - 1];
  const start = Math.max(time[0], span ? end - span : time[0]);
  if (!(end > start)) return undefined;
  const re = new Float64Array(points), im = new Float64Array(points);
  let j = 0, mean = 0;
  for (let i = 0; i < points; i++) {
    const t = start + ((end - start) * i) / points;
    while (j < n - 2 && time[j + 1] < t) j++;
    const dt = time[j + 1] - time[j] || 1;
    re[i] = values[j] + ((values[j + 1] - values[j]) * (t - time[j])) / dt;
    mean += re[i];
  }
  mean /= points;
  // Hann window; its coherent gain is 0.5, so amplitudes are scaled by 2 / (N * 0.5).
  for (let i = 0; i < points; i++) re[i] = (re[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / points));
  fft(re, im);
  const bins = points / 2;
  const resolution = 1 / (end - start);
  const frequency = new Float64Array(bins), amplitude = new Float64Array(bins);
  let peak = { frequency: 0, amplitude: 0 };
  for (let k = 0; k < bins; k++) {
    frequency[k] = k * resolution;
    amplitude[k] = (Math.hypot(re[k], im[k]) * 4) / points;
    if (k > 0 && amplitude[k] > peak.amplitude) peak = { frequency: frequency[k], amplitude: amplitude[k] };
  }
  return { frequency, amplitude, resolution, peak };
}

/** Reads words such as "00 FF 0x55 1010b" (hex unless marked). Throws on anything else. */
export function parseWords(text: string): number[] {
  const words = text.trim().split(/[\s,;]+/).filter(Boolean).map((token) => {
    const binary = /^([01]+)b$/i.exec(token);
    const value = binary ? parseInt(binary[1], 2) : parseInt(token.replace(/^0x/i, ""), 16);
    if (!/^(0x)?[0-9a-f]+$/i.test(token) && !binary) throw new Error(`"${token}" is not a word. Use hex such as 3F, or binary such as 00111111b.`);
    if (!(value >= 0 && value <= 255)) throw new Error(`"${token}" is more than 8 bits.`);
    return value;
  });
  if (!words.length) throw new Error("Enter at least one word.");
  if (words.length > 1024) throw new Error("The word generator holds up to 1024 words.");
  return words;
}

/**
 * Eight piecewise-linear sources, one per output bit, stepping through the words at `rate` words per second.
 * Edges take 1% of a word time. Repeating patterns loop; a single pass holds the last word.
 */
export function wordGeneratorSources(words: number[], rate: number, high: number, repeat: boolean): string[] {
  const word = 1 / rate, edge = word / 100;
  const lines: string[] = [];
  for (let bit = 0; bit < 8; bit++) {
    const level = (w: number) => ((w >> bit) & 1 ? high : 0);
    const points: string[] = [`0 ${level(words[0])}`];
    for (let i = 1; i < words.length; i++) {
      if (level(words[i]) === level(words[i - 1])) continue;
      points.push(`${i * word - edge} ${level(words[i - 1])}`, `${i * word} ${level(words[i])}`);
    }
    // Close the loop back to the first word so the repeat has an edge where it wraps.
    if (repeat && words.length > 1) points.push(`${words.length * word - edge} ${level(words[words.length - 1])}`, `${words.length * word} ${level(words[0])}`);
    else points.push(`${words.length * word} ${level(words[words.length - 1])}`);
    lines.push(`V{ref}_${bit} {pin:D${bit}} 0 PWL(${points.join(" ")})${repeat && words.length > 1 ? " R=0" : ""}`);
  }
  return lines;
}
