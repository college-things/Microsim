// Small canvas plot with log axes, per-pixel decimation and a hover readout.
import {t as translate} from './i18n';
export interface Series {
  label: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color?: string;
  line?: LineStyle;
  /** Unit for this series' value in the readout. */
  unit?: string;
  /** Multiply y by this to show true values in the readout when y is plotted scaled. */
  readoutScale?: number;
  /** True values for the readout, when y is plotted somewhere else entirely. */
  readout?: ArrayLike<number>;
}

export type LineStyle = "solid" | "dashed" | "dotted";

export interface PlotOptions {
  xLabel?: string;
  yLabel?: string;
  /** Unit for the x value in the readout. */
  xUnit?: string;
  /** Named lanes, in place of numbers up the side. */
  yLanes?: { at: number; label: string }[];
  logX?: boolean;
  xRange?: [number, number];
  yRange?: [number, number];
}

// In this order, neighbours stay apart for colour-blind readers too.
const COLORS = ["#d9480f", "#1864ab", "#087f5b", "#5c7cfa", "#c2255c", "#e67700", "#862e9c", "#2b8a3e"];
const LINES: LineStyle[] = ["solid", "dashed", "dotted"];
const DASHES: Record<LineStyle, number[]> = { solid: [], dashed: [6, 3], dotted: [2, 3] };
const SI: [number, string][] = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];

export function formatSI(value: number, unit = "", digits = 4): string {
  if (!Number.isFinite(value)) return "--";
  // Nobody reads decibels or degrees with a prefix.
  if (unit === "dB" || unit === "deg") return `${parseFloat(value.toPrecision(digits))} ${unit}`;
  const abs = Math.abs(value);
  // Below this is solver residue, which reads as nonsense like -0.00002 fV.
  if (abs < 1e-15) return `0 ${unit}`.trim();
  const [scale, name] = SI.find(([s]) => abs >= s * 0.9995) ?? SI[SI.length - 1];
  return `${parseFloat((value / scale).toPrecision(digits))} ${name}${unit}`.trim();
}

/** How the curve at this position looks. Past the colours, they repeat with another line style. */
export function seriesStyle(index: number): { color: string; line: LineStyle } {
  return { color: COLORS[index % COLORS.length], line: LINES[Math.floor(index / COLORS.length) % LINES.length] };
}

/** A sweep can end a hair short of its last decade, which still deserves its tick. */
export function logTicks(x0: number, x1: number): number[] {
  const first = Math.ceil(x0 - 1e-6);
  return Array.from({ length: Math.max(0, Math.floor(x1 + 1e-6) - first + 1) }, (_, i) => 10 ** (first + i));
}

/**
 * Reduces a trace to what each pixel column can show: its first sample, its extremes in the order
 * they came, and its last. Long traces stay fast, spikes survive, and a rising edge is drawn as
 * sharply as a falling one.
 */
export function traceColumns(
  xs: ArrayLike<number>, ys: ArrayLike<number>, toX: (v: number) => number, toY: (v: number) => number,
  moveTo: (x: number, y: number) => void, lineTo: (x: number, y: number) => void,
): void {
  let column = NaN, first = 0, last = 0, low = 0, high = 0, lowAt = 0, highAt = 0, started = false;
  const flush = () => {
    if (Number.isNaN(column)) return;
    const [early, late] = lowAt <= highAt ? [low, high] : [high, low];
    lineTo(column, first);
    if (early !== first) lineTo(column, early);
    if (late !== early) lineTo(column, late);
    if (last !== late) lineTo(column, last);
  };
  for (let i = 0; i < xs.length; i++) {
    const x = Math.round(toX(xs[i]));
    const y = toY(ys[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!started) { moveTo(x, y); started = true; }
    if (x !== column) {
      flush();
      column = x; first = low = high = y; lowAt = highAt = i;
    }
    if (y < low) { low = y; lowAt = i; }
    if (y > high) { high = y; highAt = i; }
    last = y;
  }
  flush();
}

/** Digits needed so neighbouring axis labels differ, even far from zero. */
function tickDigits(ticks: number[]): number {
  if (ticks.length < 2) return 4;
  const largest = Math.max(...ticks.map(Math.abs));
  const step = Math.abs(ticks[1] - ticks[0]);
  return Math.min(12, Math.max(4, Math.ceil(Math.log10((largest || 1) / (step || 1))) + 2));
}

export function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  const first = Math.ceil(min / step);
  // Counted, not added up. On a range a few rounding steps wide, adding the step changes nothing,
  // and the loop would never end. These steps never give more than about 1.5 ticks per count.
  for (let i = 0; i <= count * 3; i++) {
    const t = (first + i) * step;
    if (!(t <= max + step * 1e-6)) break;
    ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return ticks;
}

/** A level that holds still often still carries a few rounding steps of noise, which is no range to draw. */
export function isFlatRange(low: number, high: number): boolean {
  return high - low <= Math.max(Math.abs(low), Math.abs(high)) * 1e-12;
}

const plots = new WeakMap<HTMLCanvasElement, Plot>();

/** Plots read the theme's colours as they draw, so a change of appearance has to redraw them. */
export function redrawPlots(): void {
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas.plot")) plots.get(canvas)?.draw();
}

export class Plot {
  readonly canvas = document.createElement("canvas");
  private series: Series[] = [];
  private options: PlotOptions = {};
  private hover: { x: number; y: number } | undefined;
  private frame = { left: 56, top: 10, right: 12, bottom: 34 };
  private map = { x0: 0, x1: 1, y0: 0, y1: 1 };

  constructor(parent: HTMLElement) {
    this.canvas.className = "plot";
    parent.append(this.canvas);
    plots.set(this.canvas, this);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.canvas.addEventListener("pointermove", (e) => {
      this.hover = { x: e.offsetX, y: e.offsetY };
      this.draw();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = undefined;
      this.draw();
    });
  }

  set(series: Series[], options: PlotOptions = {}): void {
    this.series = series;
    this.options = options;
    this.draw();
  }

  private tx(v: number): number {
    return this.options.logX ? Math.log10(Math.max(v, 1e-30)) : v;
  }

  draw(): void {
    const { canvas, frame, options } = this;
    frame.left = options.yLabel || options.yLanes ? 68 : 56;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(canvas);
    const fg = style.getPropertyValue("--text").trim() || "#222";
    const grid = style.getPropertyValue("--line").trim() || "#ddd";
    ctx.clearRect(0, 0, w, h);

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of this.series) {
      for (let i = 0; i < s.x.length; i++) {
        const xv = this.tx(s.x[i]);
        const yv = s.y[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        if (xv < x0) x0 = xv;
        if (xv > x1) x1 = xv;
        if (yv < y0) y0 = yv;
        if (yv > y1) y1 = yv;
      }
    }
    if (options.xRange) [x0, x1] = [this.tx(options.xRange[0]), this.tx(options.xRange[1])];
    if (options.yRange) [y0, y1] = options.yRange;
    if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = -1; y1 = 1; }
    if (isFlatRange(x0, x1)) { const pad = Math.max(0.5, Math.abs(x0) * 0.1); x0 -= pad; x1 += pad; }
    if (isFlatRange(y0, y1)) { const pad = Math.abs(y0) * 0.1 || 1; y0 -= pad; y1 += pad; }
    if (!options.yRange) { const pad = (y1 - y0) * 0.06; y0 -= pad; y1 += pad; }
    this.map = { x0, x1, y0, y1 };

    const pw = w - frame.left - frame.right;
    const ph = h - frame.top - frame.bottom;
    const px = (v: number) => frame.left + ((this.tx(v) - x0) / (x1 - x0)) * pw;
    const py = (v: number) => frame.top + (1 - (v - y0) / (y1 - y0)) * ph;

    ctx.font = "11px -apple-system, 'Segoe UI', sans-serif";
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    ctx.fillStyle = fg;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const yTicks = options.yLanes ? [] : niceTicks(y0, y1, 5);
    const yDigits = tickDigits(yTicks);
    const rows = options.yLanes ?? yTicks.map((t) => ({ at: t, label: formatSI(t, "", yDigits) }));
    for (const row of rows) {
      const y = Math.round(py(row.at)) + 0.5;
      ctx.beginPath(); ctx.moveTo(frame.left, y); ctx.lineTo(w - frame.right, y); ctx.stroke();
      ctx.fillText(row.label, frame.left - 5, y);
    }
    if (options.yLabel) {
      ctx.save();
      ctx.translate(9, frame.top + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(translate(options.yLabel), 0, 0);
      ctx.restore();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xTicks = options.logX ? logTicks(x0, x1) : niceTicks(x0, x1, 6);
    const xDigits = options.logX ? 4 : tickDigits(xTicks);
    for (const t of xTicks) {
      const x = Math.round(px(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, frame.top); ctx.lineTo(x, h - frame.bottom); ctx.stroke();
      ctx.fillText(formatSI(t, "", xDigits), x, h - frame.bottom + 4);
    }
    if (options.xLabel) ctx.fillText(translate(options.xLabel), frame.left + pw / 2, h - 14);

    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.left, frame.top, pw, ph);
    ctx.clip();
    ctx.lineWidth = 1.4;
    this.series.forEach((s, index) => {
      const style = seriesStyle(index);
      ctx.strokeStyle = s.color ?? style.color;
      ctx.setLineDash(DASHES[s.line ?? style.line]);
      ctx.beginPath();
      traceColumns(s.x, s.y, px, py, (x, y) => ctx.moveTo(x, y), (x, y) => ctx.lineTo(x, y));
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.restore();

    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    ctx.strokeRect(frame.left + 0.5, frame.top + 0.5, pw, ph);
    this.drawReadout(ctx, w, ph, pw, px, py, fg);
  }

  private drawReadout(
    ctx: CanvasRenderingContext2D, w: number, ph: number, pw: number,
    px: (v: number) => number, py: (v: number) => number, fg: string,
  ): void {
    const { hover, frame, map, series, options } = this;
    if (!hover || hover.x < frame.left || hover.x > w - frame.right || !series.length) return;
    const raw = map.x0 + ((hover.x - frame.left) / pw) * (map.x1 - map.x0);
    const at = options.logX ? 10 ** raw : raw;
    ctx.strokeStyle = fg;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(hover.x + 0.5, frame.top); ctx.lineTo(hover.x + 0.5, frame.top + ph); ctx.stroke();
    ctx.setLineDash([]);
    const name = options.xUnit === "s" ? "t" : options.xUnit === "Hz" ? "f" : "x";
    const rows: { text: string; index?: number }[] = [{ text: `${name} = ${formatSI(at, options.xUnit)}` }];
    // A long list stops where the plot does. The key below it names every curve.
    const room = Math.max(1, Math.floor((ph - 14) / 15) - 1);
    const listed = series.length > room ? room - 1 : room;
    series.forEach((s, index) => {
      let lo = 0, hi = s.x.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.x[mid] < at) lo = mid + 1; else hi = mid;
      }
      const y = s.y[lo];
      if (index < listed) rows.push({ text: `${s.label}: ${formatSI(s.readout ? s.readout[lo] : y * (s.readoutScale ?? 1), s.unit)}`, index });
      ctx.fillStyle = s.color ?? seriesStyle(index).color;
      ctx.beginPath(); ctx.arc(px(s.x[lo]), py(y), 3, 0, 7); ctx.fill();
    });
    if (series.length > listed) rows.push({ text: `and ${series.length - listed} more` });
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const mark = 20;
    const boxW = Math.max(...rows.map((r) => ctx.measureText(r.text).width + (r.index === undefined ? 0 : mark))) + 12;
    const boxX = hover.x + boxW + 14 > w ? hover.x - boxW - 8 : hover.x + 8;
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--panel").trim() || "#fff";
    ctx.fillRect(boxX, frame.top + 4, boxW, rows.length * 15 + 6);
    rows.forEach((r, i) => {
      const y = frame.top + 8 + i * 15;
      let textX = boxX + 6;
      if (r.index !== undefined) {
        const s = series[r.index];
        const style = seriesStyle(r.index);
        ctx.strokeStyle = s.color ?? style.color;
        ctx.setLineDash(DASHES[s.line ?? style.line]);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(textX, y + 6); ctx.lineTo(textX + mark - 5, y + 6); ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        textX += mark;
      }
      ctx.fillStyle = fg;
      ctx.fillText(r.text, textX, y);
    });
  }
}
