// Small canvas plot with log axes, per-pixel decimation and a hover readout.
export interface Series {
  label: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color?: string;
  /** Multiply y by this to show true values in the readout when y is plotted scaled. */
  readoutScale?: number;
}

export interface PlotOptions {
  xLabel?: string;
  yLabel?: string;
  logX?: boolean;
  xRange?: [number, number];
  yRange?: [number, number];
}

const COLORS = ["#d9480f", "#1864ab", "#2b8a3e", "#862e9c", "#c2255c", "#087f5b", "#5c7cfa", "#e67700"];
const SI: [number, string][] = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];

export function formatSI(value: number, unit = "", digits = 4): string {
  if (!Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  // Below this is solver residue, which reads as nonsense like -0.00002 fV.
  if (abs < 1e-15) return `0 ${unit}`.trim();
  const [scale, name] = SI.find(([s]) => abs >= s * 0.9995) ?? SI[SI.length - 1];
  return `${parseFloat((value / scale).toPrecision(digits))} ${name}${unit}`.trim();
}

/** Digits needed so neighbouring axis labels differ, even far from zero. */
function tickDigits(ticks: number[]): number {
  if (ticks.length < 2) return 4;
  const largest = Math.max(...ticks.map(Math.abs));
  const step = Math.abs(ticks[1] - ticks[0]);
  return Math.min(12, Math.max(4, Math.ceil(Math.log10((largest || 1) / (step || 1))) + 2));
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return ticks;
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
    if (x0 === x1) { x0 -= 0.5; x1 += 0.5; }
    if (y0 === y1) { const pad = Math.abs(y0) * 0.1 || 1; y0 -= pad; y1 += pad; }
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
    const yTicks = niceTicks(y0, y1, 5);
    const yDigits = tickDigits(yTicks);
    for (const t of yTicks) {
      const y = Math.round(py(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(frame.left, y); ctx.lineTo(w - frame.right, y); ctx.stroke();
      ctx.fillText(formatSI(t, "", yDigits), frame.left - 5, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xTicks = options.logX
      ? Array.from({ length: Math.floor(x1) - Math.ceil(x0) + 1 }, (_, i) => 10 ** (Math.ceil(x0) + i))
      : niceTicks(x0, x1, 6);
    const xDigits = options.logX ? 4 : tickDigits(xTicks);
    for (const t of xTicks) {
      const x = Math.round(px(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, frame.top); ctx.lineTo(x, h - frame.bottom); ctx.stroke();
      ctx.fillText(formatSI(t, "", xDigits), x, h - frame.bottom + 4);
    }
    if (options.xLabel) ctx.fillText(options.xLabel, frame.left + pw / 2, h - 14);

    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.left, frame.top, pw, ph);
    ctx.clip();
    ctx.lineWidth = 1.4;
    this.series.forEach((s, index) => {
      ctx.strokeStyle = s.color ?? COLORS[index % COLORS.length];
      ctx.beginPath();
      // Per-pixel min and max keep long traces fast without hiding spikes.
      let column = NaN, low = 0, high = 0, started = false;
      const flush = () => {
        if (Number.isNaN(column)) return;
        ctx.lineTo(column, low);
        if (high !== low) ctx.lineTo(column, high);
      };
      for (let i = 0; i < s.x.length; i++) {
        const x = Math.round(px(s.x[i]));
        const y = py(s.y[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (!started) { ctx.moveTo(x, y); started = true; column = x; low = high = y; continue; }
        if (x === column) {
          if (y < low) low = y;
          if (y > high) high = y;
        } else {
          flush();
          column = x; low = high = y;
        }
      }
      flush();
      ctx.stroke();
    });
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
    const rows = [`x = ${formatSI(at)}`];
    series.slice(0, 8).forEach((s, index) => {
      let lo = 0, hi = s.x.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.x[mid] < at) lo = mid + 1; else hi = mid;
      }
      const y = s.y[lo];
      rows.push(`${s.label}: ${formatSI(y * (s.readoutScale ?? 1))}`);
      ctx.fillStyle = s.color ?? COLORS[index % COLORS.length];
      ctx.beginPath(); ctx.arc(px(s.x[lo]), py(y), 3, 0, 7); ctx.fill();
    });
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const boxW = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 12;
    const boxX = hover.x + boxW + 14 > w ? hover.x - boxW - 8 : hover.x + 8;
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--panel").trim() || "#fff";
    ctx.fillRect(boxX, frame.top + 4, boxW, rows.length * 15 + 6);
    ctx.fillStyle = fg;
    rows.forEach((r, i) => ctx.fillText(r, boxX + 6, frame.top + 8 + i * 15));
  }
}
