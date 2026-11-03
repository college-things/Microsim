// Floating instrument windows and how each one reads a finished simulation.
import { acRms, findVector, rms, settledMean } from "../core/analyses";

export { acRms, settledMean };
import { readValue } from "../core/netlist";
import type { SchComponent } from "../core/schematic";
import type { SimResult } from "../core/sim";
import { formatSI, Plot, type Series } from "./plot";

export interface RunData {
  op?: SimResult;
  tran?: SimResult;
  ac?: SimResult;
  pinNets: Map<string, Map<string, string>>;
  /** SPICE name per component id, used to find an instrument's sense source. */
  refs: Map<string, string>;
}

export interface ScopeSettings {
  timePerDiv: number;
  /** Zero means fit the trace automatically. */
  voltsPerDivA: number;
  voltsPerDivB: number;
  /** Trigger on channel A rising through this level. Undefined shows the latest sweep as is. */
  triggerLevel?: number;
}

let topZ = 20;

export function floatingWindow(host: HTMLElement, title: string, width: number, height: number, onClose: () => void): { root: HTMLElement; body: HTMLElement; setTitle(t: string): void } {
  const root = document.createElement("div");
  root.className = "window";
  const offset = 12 + (host.querySelectorAll(".window").length % 6) * 44;
  // Stay inside the workspace, however small the window is.
  const w = Math.min(width, Math.max(300, host.clientWidth - 24));
  const h = Math.min(height, Math.max(180, host.clientHeight - 24));
  Object.assign(root.style, {
    left: `${Math.max(0, Math.min(offset, host.clientWidth - w - 8))}px`,
    top: `${Math.max(0, Math.min(offset, host.clientHeight - h - 8))}px`,
    width: `${w}px`, height: `${h}px`, zIndex: String(++topZ),
  });
  const bar = document.createElement("div");
  bar.className = "window-title";
  const name = document.createElement("span");
  name.textContent = title;
  const close = document.createElement("button");
  close.className = "quiet";
  close.textContent = "Close";
  close.onclick = () => { root.remove(); onClose(); };
  bar.append(name, close);
  const body = document.createElement("div");
  body.className = "window-body";
  root.append(bar, body);
  host.append(root);
  root.addEventListener("pointerdown", () => { root.style.zIndex = String(++topZ); });
  bar.addEventListener("pointerdown", (e) => {
    if (e.target === close) return;
    const startX = e.clientX - root.offsetLeft;
    const startY = e.clientY - root.offsetTop;
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      root.style.left = `${Math.max(0, ev.clientX - startX)}px`;
      root.style.top = `${Math.max(0, ev.clientY - startY)}px`;
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });
  return { root, body, setTitle: (t) => { name.textContent = t; } };
}

/** Voltage between two nets, or undefined when the positive pin is unconnected. */
function differential(result: SimResult, nets: Map<string, string> | undefined, plus: string, minus?: string): Float64Array | undefined {
  const a = nets?.get(plus);
  if (!a || !result.axis) return undefined;
  const va = a === "0" ? undefined : findVector(result, `v(${a})`);
  if (a !== "0" && !va) return undefined;
  const b = minus ? nets?.get(minus) : undefined;
  const vb = b && b !== "0" ? findVector(result, `v(${b})`) : undefined;
  const out = new Float64Array(result.axis.re.length);
  for (let i = 0; i < out.length; i++) out[i] = (va?.re[i] ?? 0) - (vb?.re[i] ?? 0);
  return out;
}

export interface InstrumentView {
  update(run: RunData): void;
  /** Blanks the readings, because the circuit no longer matches them. */
  clear(): void;
  element: HTMLElement;
}

function controls(parent: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "controls";
  parent.append(row);
  return row;
}

function message(plot: HTMLElement, text: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "muted pad";
  note.textContent = text;
  plot.append(note);
  return note;
}

export function createScope(host: HTMLElement, comp: SchComponent, settings: ScopeSettings, onChange: () => void, onClose: () => void): InstrumentView {
  const win = floatingWindow(host, `Oscilloscope ${comp.refDes}`, 520, 340, onClose);
  const note = message(win.body, "Run the simulation to see traces.");
  const plot = new Plot(win.body);
  const row = controls(win.body);
  const field = (label: string, value: string, apply: (text: string) => void) => {
    const wrap = document.createElement("label");
    const input = document.createElement("input");
    input.value = value;
    input.onchange = () => apply(input.value);
    wrap.append(label, " ", input);
    row.append(wrap);
    return input;
  };
  const show = (value: number, unit: string) => (value ? formatSI(value, unit).replace(/\s/g, "") : "auto");
  const time = field("Time/div", show(settings.timePerDiv, "s"), (text) => {
    const value = readValue(text);
    if (value && value > 0) {
      settings.timePerDiv = value;
      onChange();
    }
  });
  let last: RunData | undefined;
  const scale = (text: string) => {
    const value = readValue(text);
    return value && value > 0 ? value : 0;
  };
  const voltsA = field("A V/div", show(settings.voltsPerDivA, "V"), (text) => {
    settings.voltsPerDivA = scale(text);
    if (last) draw(last);
  });
  const voltsB = field("B V/div", show(settings.voltsPerDivB, "V"), (text) => {
    settings.voltsPerDivB = scale(text);
    if (last) draw(last);
  });
  const trigger = field("Trigger", settings.triggerLevel === undefined ? "off" : formatSI(settings.triggerLevel, "V"), (text) => {
    settings.triggerLevel = readValue(text);
    if (last) draw(last);
  });
  const stats = document.createElement("span");
  stats.className = "muted";
  row.append(stats);

  // Redraws run many times a second, and must not overwrite what someone is typing.
  const setField = (input: HTMLInputElement, text: string) => {
    if (document.activeElement !== input && input.value !== text) input.value = text;
  };

  function draw(run: RunData): void {
    setField(time, show(settings.timePerDiv, "s"));
    setField(voltsA, show(settings.voltsPerDivA, "V"));
    setField(voltsB, show(settings.voltsPerDivB, "V"));
    setField(trigger, settings.triggerLevel === undefined ? "off" : formatSI(settings.triggerLevel, "V"));
    if (!run.tran?.axis) {
      note.textContent = "Connect channel A or B and run the simulation.";
      return;
    }
    const nets = run.pinNets.get(comp.id);
    const end = run.tran.axis.re[run.tran.axis.re.length - 1];
    const span = settings.timePerDiv * 10;
    // The run may hold far more than this scope shows, for slower meters. Three screens is
    // enough to find a trigger edge, and all that's worth computing on every frame.
    let from = 0;
    while (from < run.tran.axis.re.length - 1 && run.tran.axis.re[from] < end - span * 3) from++;
    const axis = run.tran.axis.re.subarray(from);
    const a = differential(run.tran, nets, "A", "G")?.subarray(from);
    const b = differential(run.tran, nets, "B", "G")?.subarray(from);
    // Show ten divisions, starting at the last trigger that leaves a full sweep on screen.
    let start = Math.max(axis[0], end - span);
    if (settings.triggerLevel !== undefined && a) {
      for (let i = 1; i < axis.length && axis[i] + span <= end; i++) {
        if (a[i - 1] < settings.triggerLevel && a[i] >= settings.triggerLevel) start = axis[i];
      }
    }
    const fixed = settings.voltsPerDivA > 0 || settings.voltsPerDivB > 0;
    const series: Series[] = [];
    const add = (label: string, wave: Float64Array | undefined, perDiv: number, color: string) => {
      if (!wave) return;
      // With a set scale, each channel plots in divisions so the two can differ, as on a bench scope.
      const unit = fixed ? perDiv || peak(wave) / 4 || 1 : 1;
      series.push({ label, x: axis, y: fixed ? wave.map((v) => v / unit) : wave, color, readoutScale: unit });
    };
    add("A", a, settings.voltsPerDivA, "#d9480f");
    add("B", b, settings.voltsPerDivB, "#1864ab");
    note.textContent = series.length ? "" : "Channels A and B are not connected to anything.";
    note.style.display = series.length ? "none" : "";
    plot.set(series, {
      xLabel: "Time (s)", xRange: [start, Math.min(end, start + span)],
      yRange: fixed ? [-5, 5] : undefined, yLabel: fixed ? "div" : undefined,
    });
    // Measure what's on screen, not the start-up that has scrolled off.
    let first = 0;
    while (first < axis.length - 1 && axis[first] < start) first++;
    const shown = axis.subarray(first);
    stats.textContent = [a && `A ${formatSI(rms(a.subarray(first), shown), "V")} rms`, b && `B ${formatSI(rms(b.subarray(first), shown), "V")} rms`].filter(Boolean).join("   ");
  }

  return {
    element: win.root,
    update(run) {
      last = run;
      draw(run);
    },
    clear() {
      last = undefined;
      plot.set([]);
      stats.textContent = "";
      note.style.display = "";
      note.textContent = "The circuit changed. Run it to see traces.";
    },
  };
}

function peak(values: ArrayLike<number>): number {
  let high = 0;
  for (let i = 0; i < values.length; i++) high = Math.max(high, Math.abs(values[i]));
  return high;
}

export function createMultimeter(host: HTMLElement, comp: SchComponent, onClose: () => void): InstrumentView {
  const win = floatingWindow(host, `Multimeter ${comp.refDes}`, 300, 180, onClose);
  const display = document.createElement("div");
  display.className = "readout";
  display.textContent = "--";
  const detail = document.createElement("div");
  detail.className = "muted pad";
  detail.textContent = "Change the mode in Properties.";
  win.body.append(display, detail);
  return {
    element: win.root,
    update(run) {
      const nets = run.pinNets.get(comp.id);
      const mode = comp.params.mode;
      const ac = comp.params.coupling === "ac" && mode !== "ohms";
      detail.textContent = `${mode === "ohms" ? "Resistance" : ac ? "AC RMS, settled part of the run" : "DC"}. Change the mode in Properties.`;
      const axis = run.tran?.axis?.re;
      if (mode === "amps") {
        const name = `i(v${run.refs.get(comp.id) ?? comp.refDes})`;
        const wave = run.tran && findVector(run.tran, name);
        if (ac) {
          display.textContent = wave && axis ? formatSI(acRms(wave.re, axis), "A") : "--";
          return;
        }
        // While a circuit runs, DC follows it. Otherwise it's the operating point.
        if (wave && axis) {
          display.textContent = formatSI(settledMean(wave.re, axis), "A");
          return;
        }
        const dc = run.op && findVector(run.op, name);
        display.textContent = formatSI(dc?.re[0] ?? NaN, "A");
        return;
      }
      if (ac) {
        const wave = run.tran && differential(run.tran, nets, "p", "n");
        display.textContent = wave && axis ? formatSI(acRms(wave, axis), "V") : "--";
        return;
      }
      if (mode !== "ohms" && run.tran && axis) {
        const wave = differential(run.tran, nets, "p", "n");
        if (wave) {
          display.textContent = formatSI(settledMean(wave, axis), "V");
          return;
        }
      }
      const reading = (name: string | undefined) => {
        if (!name) return undefined;
        if (name === "0") return 0;
        return run.op ? findVector(run.op, `v(${name})`)?.re[0] : undefined;
      };
      const plus = reading(nets?.get("p"));
      const minus = reading(nets?.get("n")) ?? 0;
      if (plus === undefined) {
        display.textContent = "--";
        return;
      }
      const volts = plus - minus;
      display.textContent = mode === "ohms" ? formatSI(volts / 1e-3, "Ohm") : formatSI(volts, "V");
    },
    clear() {
      display.textContent = "--";
      detail.textContent = "The circuit changed. Run it to measure.";
    },
  };
}

export function createWattmeter(host: HTMLElement, comp: SchComponent, onClose: () => void): InstrumentView {
  const win = floatingWindow(host, `Wattmeter ${comp.refDes}`, 300, 180, onClose);
  const display = document.createElement("div");
  display.className = "readout";
  display.textContent = "--";
  const detail = document.createElement("div");
  detail.className = "muted pad";
  detail.textContent = "Measures v+ to v-, with current flowing from i+ to i-.";
  win.body.append(display, detail);
  return {
    element: win.root,
    update(run) {
      const nets = run.pinNets.get(comp.id);
      const name = `i(v${run.refs.get(comp.id) ?? comp.refDes})`;
      const source = run.tran ?? run.op;
      const current = source && findVector(source, name);
      if (!source || !current || !nets?.get("v+")) {
        display.textContent = "--";
        return;
      }
      if (run.tran?.axis) {
        const volts = differential(run.tran, nets, "v+", "v-");
        const time = run.tran.axis.re;
        if (volts) {
          let energy = 0;
          for (let i = 1; i < time.length; i++) {
            const a = volts[i - 1] * current.re[i - 1];
            const b = volts[i] * current.re[i];
            energy += ((a + b) / 2) * (time[i] - time[i - 1]);
          }
          display.textContent = formatSI(energy / (time[time.length - 1] - time[0] || 1), "W");
          detail.textContent = "Average power over the run.";
        }
        return;
      }
      const read = (net: string | undefined) => (net && net !== "0" ? findVector(source, `v(${net})`)?.re[0] ?? 0 : 0);
      display.textContent = formatSI((read(nets.get("v+")) - read(nets.get("v-"))) * current.re[0], "W");
    },
    clear() {
      display.textContent = "--";
      detail.textContent = "The circuit changed. Run it to measure.";
    },
  };
}

export function createLogicAnalyzer(host: HTMLElement, comp: SchComponent, onClose: () => void): InstrumentView {
  const win = floatingWindow(host, `Logic analyzer ${comp.refDes}`, 540, 320, onClose);
  const note = message(win.body, "Connect channels 1 to 4, then run the simulation.");
  const plot = new Plot(win.body);
  return {
    element: win.root,
    update(run) {
      if (!run.tran?.axis) return;
      const nets = run.pinNets.get(comp.id);
      const series: Series[] = [];
      // Each channel gets its own lane so edges can be compared by eye.
      for (const channel of ["1", "2", "3", "4"]) {
        const wave = differential(run.tran, nets, channel);
        if (!wave) continue;
        let high = 0;
        for (const v of wave) if (v > high) high = v;
        const scale = high > 0 ? 0.8 / high : 1;
        const lane = series.length * 1.2;
        series.push({ label: `Channel ${channel}`, x: run.tran.axis.re, y: wave.map((v) => v * scale - lane) });
      }
      note.style.display = series.length ? "none" : "";
      plot.set(series, { xLabel: "Time (s)" });
    },
    clear() {
      plot.set([]);
      note.style.display = "";
      note.textContent = "The circuit changed. Run it to see channels.";
    },
  };
}

export function createBode(host: HTMLElement, comp: SchComponent, onClose: () => void): InstrumentView {
  const win = floatingWindow(host, `Bode plotter ${comp.refDes}`, 540, 420, onClose);
  const note = message(win.body, "The circuit needs an AC source. Run the simulation to plot.");
  const magnitude = new Plot(win.body);
  const phase = new Plot(win.body);
  return {
    element: win.root,
    update(run) {
      const nets = run.pinNets.get(comp.id);
      const ac = run.ac;
      if (!ac?.axis || !nets?.get("in+") || !nets.get("out+")) {
        note.style.display = "";
        note.textContent = "Connect the IN and OUT pins, add an AC source, then run.";
        return;
      }
      const read = (name: string | undefined, i: number): [number, number] => {
        if (!name || name === "0") return [0, 0];
        const v = findVector(ac, `v(${name})`);
        return v ? [v.re[i], v.im?.[i] ?? 0] : [0, 0];
      };
      const n = ac.axis.re.length;
      const db = new Float64Array(n);
      const degrees = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const [ip, iq] = read(nets.get("in+"), i);
        const [im, in2] = read(nets.get("in-"), i);
        const [op, oq] = read(nets.get("out+"), i);
        const [om, on] = read(nets.get("out-"), i);
        const inRe = ip - im, inIm = iq - in2, outRe = op - om, outIm = oq - on;
        const denom = inRe * inRe + inIm * inIm || 1e-300;
        const re = (outRe * inRe + outIm * inIm) / denom;
        const im2 = (outIm * inRe - outRe * inIm) / denom;
        db[i] = 20 * Math.log10(Math.hypot(re, im2) || 1e-30);
        degrees[i] = (Math.atan2(im2, re) * 180) / Math.PI;
      }
      note.style.display = "none";
      magnitude.set([{ label: "Gain (dB)", x: ac.axis.re, y: db }], { logX: true });
      phase.set([{ label: "Phase (deg)", x: ac.axis.re, y: degrees, color: "#1864ab" }], { logX: true, xLabel: "Frequency (Hz)" });
    },
    clear() {
      magnitude.set([]);
      phase.set([]);
      note.style.display = "";
      note.textContent = "The circuit changed. Run it to plot.";
    },
  };
}
