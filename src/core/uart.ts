// Decodes asynchronous serial frames (start bit, LSB-first data, optional parity, stop bit) from a sampled waveform.

export interface UartSettings {
  baud: number;
  /** Logic threshold in volts; the idle line is high. */
  threshold: number;
  dataBits?: number;
  parity?: "none" | "even" | "odd";
  /** Idle-low (inverted, RS-232 level) lines. */
  inverted?: boolean;
}

export interface UartByte {
  /** Time of the start bit's falling edge. */
  time: number;
  value: number;
  /** Set when the stop bit was low or parity failed. */
  error?: "framing" | "parity";
}

/** Linear interpolation of a sampled waveform. */
function sample(time: ArrayLike<number>, volts: ArrayLike<number>, t: number, hint: { i: number }): number {
  let i = hint.i;
  while (i + 1 < time.length && time[i + 1] < t) i++;
  hint.i = i;
  if (i + 1 >= time.length) return volts[time.length - 1];
  const t0 = time[i], t1 = time[i + 1];
  return t1 > t0 ? volts[i] + ((volts[i + 1] - volts[i]) * (t - t0)) / (t1 - t0) : volts[i + 1];
}

/**
 * Finds frames whose start edge lies after `after`. A frame that runs past the end of the data is left for
 * the next call, so the returned `resume` time can be passed back as `after` when more samples arrive.
 */
export function decodeUart(time: ArrayLike<number>, volts: ArrayLike<number>, settings: UartSettings, after = -Infinity): { bytes: UartByte[]; resume: number; gap: boolean } {
  const bytes: UartByte[] = [];
  const bit = 1 / settings.baud, dataBits = settings.dataBits ?? 8, parity = settings.parity ?? "none";
  const frameBits = 1 + dataBits + (parity === "none" ? 0 : 1) + 1;
  const level = (v: number) => (settings.inverted ? v < settings.threshold : v >= settings.threshold) ? 1 : 0;
  const end = time.length ? time[time.length - 1] : -Infinity;
  let resume = after;
  // Samples between `after` and the first one given were lost, so the decoder must find frame alignment again.
  const gap = Number.isFinite(after) && time.length > 0 && time[0] > after;
  let resync = gap;
  let i = 0;
  while (i < time.length && time[i] <= after) i++;
  const hint = { i: Math.max(0, i - 1) };
  // Everything up to here has been scanned; an unfinished frame moves it back to just before its start edge.
  let scanned = end;
  for (i = Math.max(1, i); i < time.length; i++) {
    if (!(level(volts[i - 1]) === 1 && level(volts[i]) === 0)) continue;
    // Interpolate the crossing for the edge time.
    const v0 = volts[i - 1], v1 = volts[i];
    const edge = v1 !== v0 ? time[i - 1] + ((settings.threshold - v0) / (v1 - v0)) * (time[i] - time[i - 1]) : time[i];
    if (edge <= after) continue;
    // After a gap, accept only an edge that follows at least one bit time of idle line (a stop bit or idle).
    if (resync) {
      const idleFrom = edge - bit;
      if (idleFrom < time[0]) continue;
      let idle = true;
      for (let k = i - 1; k >= 0 && time[k] >= idleFrom; k--) if (!level(volts[k])) { idle = false; break; }
      if (!idle) continue;
    }
    if (edge + (frameBits - 0.5) * bit > end) { scanned = edge - bit / 64; break; }
    hint.i = Math.max(0, i - 1);
    const bits: number[] = [];
    for (let n = 0; n < frameBits; n++) bits.push(level(sample(time, volts, edge + (n + 0.5) * bit, hint)));
    if (bits[0] !== 0) continue; // a glitch, not a start bit
    const value = bits.slice(1, 1 + dataBits).reduce((v, b, n) => v | (b << n), 0);
    const byte: UartByte = { time: edge, value };
    if (parity !== "none") {
      const ones = bits.slice(1, 2 + dataBits).reduce((a, b) => a + b, 0);
      if ((ones % 2 === 0) !== (parity === "even")) byte.error = "parity";
    }
    if (!bits[frameBits - 1]) byte.error = "framing";
    // While searching for alignment a bad frame is a wrong guess: drop it and try the next edge.
    if (resync && byte.error) continue;
    resync = false;
    bytes.push(byte);
    // The next start edge can come no sooner than the middle of this stop bit.
    resume = edge + (frameBits - 0.5) * bit;
    while (i + 1 < time.length && time[i + 1] < resume) i++;
  }
  return { bytes, resume: Math.max(resume, scanned), gap };
}

/** Printable terminal text; carriage returns are dropped and other control bytes shown as hex. */
export function terminalText(bytes: UartByte[]): string {
  let out = "";
  for (const b of bytes) {
    if (b.error) out += "�";
    else if (b.value === 10 || b.value === 9 || (b.value >= 32 && b.value < 127)) out += String.fromCharCode(b.value);
    else if (b.value !== 13) out += `<${b.value.toString(16).padStart(2, "0")}>`;
  }
  return out;
}
