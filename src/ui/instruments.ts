// Floating instrument windows and how each one reads a finished simulation.
import { acRms, findVector, settledMean, settledRms } from "../core/analyses";

export { acRms, settledMean };
import { readValue } from "../core/netlist";
import type { SchComponent } from "../core/schematic";
import type { SimResult } from "../core/sim";
import { formatSI, Plot, type Series } from "./plot";
import {coupleScope,scopeTrigger} from '../core/scope';
import { decodeUart, terminalText } from "../core/uart";

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
  voltsPerDivC?:number;
  voltsPerDivD?:number;
  triggerSource?:'A'|'B'|'C'|'D';
  triggerSlope?:'rising'|'falling';
  coupling?:Partial<Record<'A'|'B'|'C'|'D','DC'|'AC'|'GND'>>;
  /** Trigger on channel A rising through this level. Undefined shows the latest sweep as is. */
  triggerLevel?: number;
}

let topZ = 20;

/** How much of a window's width must stay on the sheet, so its title can always be grabbed. */
const KEEP_ON_SHEET = 120;

/** Where a window may sit: anywhere that leaves its title bar reachable on the sheet. */
export function clampWindow(left: number, top: number, sheetWidth: number, sheetHeight: number, titleHeight: number): { left: number; top: number } {
  return {
    left: Math.max(0, Math.min(left, sheetWidth - KEEP_ON_SHEET)),
    top: Math.max(0, Math.min(top, sheetHeight - titleHeight)),
  };
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAP = 8;

function overlap(a: Box, b: Box): number {
  const across = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const down = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return across > 0 && down > 0 ? across * down : 0;
}

/**
 * Where a new window hides the least of the others: beside or below them if there's room, starting
 * at the sheet's top right. When there isn't, it still never lands exactly on another one's title.
 */
export function freeSpot(width: number, height: number, taken: Box[], sheetWidth: number, sheetHeight: number): { left: number; top: number } {
  const right = sheetWidth - width - GAP;
  const across = [right, ...taken.flatMap((b) => [b.left - width - GAP, b.left + b.width + GAP]), GAP];
  const down = [GAP, ...taken.map((b) => b.top + b.height + GAP), sheetHeight - height - GAP];
  const spots: { left: number; top: number }[] = [];
  for (const left of across) for (const top of down) spots.push({ left, top });
  taken.forEach((_, i) => spots.push({ left: right - (i + 1) * 28, top: GAP + (i + 1) * 28 }));
  let best = { left: 0, top: 0 };
  let least = Infinity;
  for (const spot of spots) {
    const left = Math.max(0, Math.min(spot.left, sheetWidth - width));
    const top = Math.max(0, Math.min(spot.top, sheetHeight - height));
    if (taken.some((b) => Math.abs(b.left - left) < 20 && Math.abs(b.top - top) < 20)) continue;
    const box = { left, top, width, height };
    const covered = taken.reduce((sum, b) => sum + overlap(box, b), 0);
    if (covered < least) {
      least = covered;
      best = { left, top };
    }
  }
  return best;
}

/** The longest stretch of a column that no open window is in. */
function freeStretch(left: number, right: number, taken: Box[], sheetHeight: number): { top: number; bottom: number } {
  const inColumn = taken.filter((b) => b.left < right && b.left + b.width > left).sort((a, b) => a.top - b.top);
  let best = { top: 0, bottom: 0 };
  let from = GAP;
  for (const b of [...inColumn, { top: sheetHeight, height: 0 }]) {
    const bottom = b.top - GAP;
    if (bottom - from > best.bottom - best.top) best = { top: from, bottom };
    from = Math.max(from, b.top + b.height + GAP);
  }
  return best;
}

/** Shorter than this, a plot has little left beside its axes and controls. */
const SMALLEST_TILE = 240;
const NARROWEST_TILE = 300;
const SHORTEST_TILE = 120;

/**
 * Lays out windows that open together, in columns down the sheet's right side, leaving the left of
 * it for the circuit. A window that won't fit gets undefined, except that a sheet too small to hold
 * both a window and a circuit still gets one window.
 */
export function tileLayout(wanted: { width: number; height: number }[], taken: Box[], sheetWidth: number, sheetHeight: number): (Box | undefined)[] {
  const boxes: (Box | undefined)[] = wanted.map(() => undefined);
  const smallest = wanted.map((w) => Math.min(w.height, SMALLEST_TILE));
  const circuit = sheetWidth * 0.3;
  let next = 0;
  let right = sheetWidth - GAP;
  while (next < wanted.length) {
    const widest = Math.max(...wanted.slice(next).map((w) => w.width));
    const width = Math.min(Math.max(NARROWEST_TILE, Math.min(widest, sheetWidth * 0.5)), sheetWidth - 2 * GAP);
    const left = right - width;
    const roomy = left >= circuit;
    const alone = !taken.length && next === 0;
    if (width <= 0 || (!roomy && !alone)) break;
    const { top, bottom } = freeStretch(left, right, taken, sheetHeight);
    // As many as fit at their smallest, then what's spare goes to those that asked for more.
    let count = 0;
    let used = 0;
    while (next + count < wanted.length && (roomy || !count)) {
      const more = smallest[next + count] + (count ? GAP : 0);
      if (used + more > bottom - top) break;
      used += more;
      count++;
    }
    if (!count) {
      if (alone && bottom - top >= SHORTEST_TILE) {
        count = 1;
      } else if (!roomy) {
        break;
      } else {
        right = left - GAP;
        continue;
      }
    }
    if (!roomy) {
      // No side to share, so the window takes the bottom of the sheet and leaves the circuit the top.
      const own = Math.min(wanted[next].width, sheetWidth - 2 * GAP);
      const height = Math.min(wanted[next].height, Math.max(SMALLEST_TILE, Math.floor(sheetHeight * 0.6)), bottom - top);
      boxes[next] = { left: sheetWidth - GAP - own, top: bottom - height, width: own, height };
      break;
    }
    const members = wanted.slice(next, next + count).map((w, i) => ({ ...w, least: Math.min(smallest[next + i], bottom - top) }));
    const room = bottom - top - (count - 1) * GAP;
    const spare = Math.max(0, room - members.reduce((sum, m) => sum + m.least, 0));
    const asked = members.reduce((sum, m) => sum + m.height - m.least, 0);
    let y = top;
    members.forEach((member, i) => {
      const extra = asked ? Math.min(member.height - member.least, (spare * (member.height - member.least)) / asked) : 0;
      const height = Math.floor(member.least + extra);
      const own = Math.min(member.width, width);
      boxes[next + i] = { left: right - own, top: y, width: own, height };
      y += height + GAP;
    });
    next += count;
    right = left - GAP;
  }
  return boxes;
}

const boxOf = (root: HTMLElement): Box => ({ left: root.offsetLeft, top: root.offsetTop, width: root.offsetWidth, height: root.offsetHeight });

/** Moves windows that just opened together out of each other's way, and closes those with no room, which it returns. */
export function tileWindows(roots: HTMLElement[]): HTMLElement[] {
  const host = roots[0]?.parentElement;
  if (!host) return [];
  const others = [...host.querySelectorAll<HTMLElement>(":scope > .window")].filter((w) => !roots.includes(w));
  const boxes = tileLayout(roots.map((w) => ({ width: w.offsetWidth, height: w.offsetHeight })), others.map(boxOf), host.clientWidth, host.clientHeight);
  return roots.filter((root, i) => {
    const box = boxes[i];
    if (!box) {
      root.remove();
      return true;
    }
    Object.assign(root.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    return false;
  });
}

/** How much of the sheet, from its top left, is clear of the windows parked at its right or bottom. */
export function clearArea(host: HTMLElement): { width: number; height: number } {
  const clear = { width: host.clientWidth, height: host.clientHeight };
  for (const root of host.querySelectorAll<HTMLElement>(":scope > .window")) {
    if (root.offsetLeft >= host.clientWidth * 0.3) clear.width = Math.min(clear.width, root.offsetLeft);
    else if (root.offsetTop >= host.clientHeight * 0.3) clear.height = Math.min(clear.height, root.offsetTop);
  }
  return clear;
}

function placeWindow(root: HTMLElement, left: number, top: number): void {
  const host = root.parentElement!;
  const at = clampWindow(left, top, host.clientWidth, host.clientHeight, root.querySelector<HTMLElement>(".window-title")!.offsetHeight);
  root.style.left = `${at.left}px`;
  root.style.top = `${at.top}px`;
}

/** A window larger than the sheet would have its Close button out of reach. */
function fitWindow(root: HTMLElement, host: HTMLElement): void {
  if (root.offsetWidth > host.clientWidth) root.style.width = `${host.clientWidth}px`;
  if (root.offsetHeight > host.clientHeight) root.style.height = `${host.clientHeight}px`;
}

/** Brings a window to the front and fully back onto the sheet, wherever it was left. */
export function showWindow(root: HTMLElement): void {
  const host = root.parentElement;
  if (!host) return;
  root.style.zIndex = String(++topZ);
  fitWindow(root, host);
  placeWindow(root, Math.min(root.offsetLeft, host.clientWidth - root.offsetWidth), Math.min(root.offsetTop, host.clientHeight - root.offsetHeight));
}

// A smaller browser window shrinks the sheet, and it mustn't leave windows behind.
const watchedHosts = new WeakSet<HTMLElement>();
function watchHost(host: HTMLElement): void {
  if (watchedHosts.has(host)) return;
  watchedHosts.add(host);
  new ResizeObserver(() => {
    if (!host.clientWidth || !host.clientHeight) return;
    for (const root of host.querySelectorAll<HTMLElement>(":scope > .window")) {
      fitWindow(root, host);
      placeWindow(root, root.offsetLeft, root.offsetTop);
    }
  }).observe(host);
}

export function floatingWindow(host: HTMLElement, title: string, width: number, height: number, onClose: () => void): { root: HTMLElement; body: HTMLElement; setTitle(t: string): void } {
  const root = document.createElement("div");
  root.className = "window";
  // Stay inside the workspace, however small the window is.
  const w = Math.min(width, Math.max(300, host.clientWidth - 24));
  const h = Math.min(height, Math.max(180, host.clientHeight - 24));
  const others = [...host.querySelectorAll<HTMLElement>(":scope > .window")].map(boxOf);
  const spot = freeSpot(w, h, others, host.clientWidth, host.clientHeight);
  Object.assign(root.style, {
    left: `${spot.left}px`,
    top: `${spot.top}px`,
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
  watchHost(host);
  root.addEventListener("pointerdown", () => { root.style.zIndex = String(++topZ); });
  bar.addEventListener("pointerdown", (e) => {
    if (e.target === close) return;
    const startX = e.clientX - root.offsetLeft;
    const startY = e.clientY - root.offsetTop;
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => placeWindow(root, ev.clientX - startX, ev.clientY - startY);
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });
  // A drag across the panels would otherwise select their text.
  bar.addEventListener("mousedown", (e) => { if (e.target !== close) e.preventDefault(); });
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
  /** Takes up the part's current object, since undo and redo replace them all. */
  follow(comp: SchComponent): void;
  /** Blanks the readings, because the circuit no longer matches them. */
  clear(): void;
  /** Every chunk of a live run, in order, for instruments that must not miss samples. */
  stream?(run: RunData, time: Float64Array, vector: (name: string) => Float64Array | undefined): void;
  element: HTMLElement;
}

function controls(parent: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "controls";
  parent.append(row);
  return row;
}

function controlField(row: HTMLElement, label: string, value: string, apply: (text: string) => void): HTMLInputElement {
  const wrap = document.createElement("label");
  const input = document.createElement("input");
  input.value = value;
  input.onchange = () => apply(input.value);
  wrap.append(label, " ", input);
  row.append(wrap);
  return input;
}

// Redraws run many times a second, and must not overwrite what someone is typing.
function setField(input: HTMLInputElement, text: string): void {
  if (document.activeElement !== input && input.value !== text) input.value = text;
}

const showScale = (value: number, unit: string) => (value ? formatSI(value, unit).replace(/\s/g, "") : "auto");

/** Says so when a stopped run holds less than the time base asks to show. */
function storedNote(stored: number, span: number, running: boolean): string {
  return !running && stored < span * 0.99 ? `Only ${formatSI(stored, "s")} stored. Run again to fill the view.` : "";
}

function message(plot: HTMLElement, text: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "muted pad";
  note.textContent = text;
  plot.append(note);
  return note;
}

export function createScope(host: HTMLElement, comp: SchComponent, settings: ScopeSettings, onChange: () => void, onClose: () => void, running: () => boolean): InstrumentView {
  const win = floatingWindow(host, `Oscilloscope ${comp.refDes}`, 520, 340, onClose);
  if (comp.kind === "tektronix-scope") {
    win.root.classList.add("tektronix-panel");
    const name = document.createElement("div"); name.className = "panel-badge"; name.textContent = "Tektronix style · simulated four-channel scope"; win.body.append(name);
  }
  const note = message(win.body, "Run the simulation to see traces.");
  const plot = new Plot(win.body);
  const row = controls(win.body);
  const field = (label: string, value: string, apply: (text: string) => void) => controlField(row, label, value, apply);
  const time = field("Time/div", showScale(settings.timePerDiv, "s"), (text) => {
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
  const voltsA = field("A V/div", showScale(settings.voltsPerDivA, "V"), (text) => {
    settings.voltsPerDivA = scale(text);
    onChange();
    if (last) draw(last);
  });
  const voltsB = field("B V/div", showScale(settings.voltsPerDivB, "V"), (text) => {
    settings.voltsPerDivB = scale(text);
    onChange();
    if (last) draw(last);
  });
  const extraFields:HTMLInputElement[]=[];
  const channels:('A'|'B'|'C'|'D')[]=comp.kind==='tektronix-scope'?['A','B','C','D']:['A','B'];
  for(const channel of channels.slice(2)){
    const key=channel==='C'?'voltsPerDivC':'voltsPerDivD';
    extraFields.push(field(`${channel} V/div`,showScale(settings[key]??0,'V'),text=>{settings[key]=scale(text);onChange();if(last)draw(last);}));
  }
  const advanced=document.createElement('details');advanced.className='scope-options';
  const summary=document.createElement('summary');summary.textContent='Coupling and trigger';advanced.append(summary);win.body.append(advanced);
  const advancedRow=controls(advanced);
  const select=(label:string,choices:string[],value:string,change:(value:string)=>void)=>{
    const wrap=document.createElement('label');wrap.append(label+' ');const input=document.createElement('select');input.setAttribute('aria-label',label);for(const choice of choices){const option=document.createElement('option');option.value=choice;option.textContent=choice;input.append(option);}input.value=value;input.onchange=()=>{change(input.value);onChange();if(last)draw(last);};wrap.append(input);advancedRow.append(wrap);return input;
  };
  for(const channel of channels)select(`${channel} coupling`,['DC','AC','GND'],settings.coupling?.[channel]??'DC',value=>{settings.coupling??={};settings.coupling[channel]=value as 'DC'|'AC'|'GND';});
  select('Trigger source',channels,settings.triggerSource??'A',value=>{settings.triggerSource=value as 'A'|'B'|'C'|'D';});
  select('Trigger slope',['rising','falling'],settings.triggerSlope??'rising',value=>{settings.triggerSlope=value as 'rising'|'falling';});
  const trigger = field("Trigger", settings.triggerLevel === undefined ? "off" : formatSI(settings.triggerLevel, "V"), (text) => {
    settings.triggerLevel = readValue(text);
    onChange();
    if (last) draw(last);
  });
  const stats = document.createElement("span");
  stats.className = "muted";
  row.append(stats);

  function draw(run: RunData): void {
    setField(time, showScale(settings.timePerDiv, "s"));
    setField(voltsA, showScale(settings.voltsPerDivA, "V"));
    setField(voltsB, showScale(settings.voltsPerDivB, "V"));
    extraFields.forEach((field,i)=>setField(field,showScale(i===0?settings.voltsPerDivC??0:settings.voltsPerDivD??0,'V')));
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
    const waves=channels.map(channel=>{const values=differential(run.tran!,nets,channel,'G');return values?coupleScope(values,run.tran!.axis!.re,settings.coupling?.[channel]??'DC').subarray(from):undefined;});
    // Show ten divisions, starting at the last trigger that leaves a full sweep on screen.
    const start=scopeTrigger(axis,waves[channels.indexOf(settings.triggerSource??'A')],settings.triggerLevel,span,settings.triggerSlope);
    const scales=[settings.voltsPerDivA,settings.voltsPerDivB,settings.voltsPerDivC??0,settings.voltsPerDivD??0];
    const fixed = scales.slice(0,channels.length).some(n=>n>0);
    const series: Series[] = [];
    const add = (label: string, wave: Float64Array | undefined, perDiv: number, color: string) => {
      if (!wave) return;
      // With a set scale, each channel plots in divisions so the two can differ, as on a bench scope.
      const unit = fixed ? perDiv || peak(wave) / 4 || 1 : 1;
      series.push({ label, x: axis, y: fixed ? wave.map((v) => v / unit) : wave, color, unit: "V", readoutScale: unit });
    };
    channels.forEach((channel,i)=>add(channel,waves[i],scales[i],['#d9480f','#1864ab','#087f5b','#862e9c'][i]));
    note.textContent = series.length ? "" : "The scope channels are not connected to anything.";
    note.style.display = series.length ? "none" : "";
    // The axis keeps to the time base, even with less than that to show.
    plot.set(series, {
      xLabel: "Time (s)", xUnit: "s", xRange: [start, start + span],
      yRange: fixed ? [-5, 5] : undefined, yLabel: fixed ? "Divisions" : "Voltage (V)",
    });
    // Measure what's on screen, not the start-up that has scrolled off.
    let first = 0;
    while (first < axis.length - 1 && axis[first] < start) first++;
    const shown = axis.subarray(first);
    stats.textContent = [...waves.map((wave,i)=>wave&&`${channels[i]} ${formatSI(settledRms(wave.subarray(first),shown),'V')} rms`),storedNote(end-axis[0],span,running())].filter(Boolean).join('   ');
  }

  return {
    element: win.root,
    follow(part) {
      comp = part;
      win.setTitle(`Oscilloscope ${comp.refDes}`);
    },
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

export function createMultimeter(host: HTMLElement, comp: SchComponent, onClose: () => void, onConfigure?: (part: SchComponent, values: Record<string, string>) => void): InstrumentView {
  const branded = comp.kind === "agilent-multimeter";
  const win = floatingWindow(host, `Multimeter ${comp.refDes}`, branded ? 360 : 300, branded ? 260 : 180, onClose);
  if (comp.kind === "agilent-multimeter") {
    win.root.classList.add("agilent-panel");
    const name = document.createElement("div"); name.className = "panel-badge"; name.textContent = "Agilent style · simulated multimeter"; win.body.append(name);
    const row = document.createElement("div"); row.className = "design-controls";
    for (const [label, mode, coupling] of [["DC V", "volts", "dc"], ["AC V", "volts", "ac"], ["DC A", "amps", "dc"], ["AC A", "amps", "ac"], ["Ω", "ohms", "dc"]]) {
      const control = document.createElement("button"); control.textContent = label;
      control.disabled = !onConfigure;
      control.onclick = () => onConfigure?.(comp, { mode, coupling });
      row.append(control);
    }
    win.body.append(row);
  }
  const display = document.createElement("div");
  display.className = "readout";
  display.textContent = "--";
  const detail = document.createElement("div");
  detail.className = "muted pad";
  detail.textContent = "Change the mode in Properties.";
  win.body.append(display, detail);
  return {
    element: win.root,
    follow(part) {
      comp = part;
      win.setTitle(`Multimeter ${comp.refDes}`);
    },
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
    follow(part) {
      comp = part;
      win.setTitle(`Wattmeter ${comp.refDes}`);
    },
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
          // Power repeats like any other signal, so it's read like one, over whole periods.
          display.textContent = formatSI(settledMean(volts.map((v, i) => v * current.re[i]), time), "W");
          detail.textContent = "Average power, settled part of the run.";
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

export function createLogicAnalyzer(host: HTMLElement, comp: SchComponent, settings: ScopeSettings, onChange: () => void, onClose: () => void, running: () => boolean): InstrumentView {
  const win = floatingWindow(host, `Logic analyzer ${comp.refDes}`, 540, 320, onClose);
  const note = message(win.body, "Connect channels 1 to 4, then run the simulation.");
  const plot = new Plot(win.body);
  const row = controls(win.body);
  const time = controlField(row, "Time/div", showScale(settings.timePerDiv, "s"), (text) => {
    const value = readValue(text);
    if (value && value > 0) {
      settings.timePerDiv = value;
      onChange();
    }
  });
  const stats = document.createElement("span");
  stats.className = "muted";
  row.append(stats);
  return {
    element: win.root,
    follow(part) {
      comp = part;
      win.setTitle(`Logic analyzer ${comp.refDes}`);
    },
    update(run) {
      if (!run.tran?.axis) return;
      setField(time, showScale(settings.timePerDiv, "s"));
      const nets = run.pinNets.get(comp.id);
      const axis = run.tran.axis.re;
      const series: Series[] = [];
      const lanes: { at: number; label: string }[] = [];
      // Each channel gets its own lane so edges can be compared by eye. The lanes show highs and
      // lows at one height, and the hover readout gives the real voltage.
      for (const channel of ["1", "2", "3", "4"]) {
        const wave = differential(run.tran, nets, channel);
        if (!wave) continue;
        let high = 0;
        for (const v of wave) if (v > high) high = v;
        const scale = high > 0 ? 0.8 / high : 1;
        const lane = series.length * 1.2;
        const net = nets?.get(channel) ?? "";
        series.push({ label: `Channel ${channel} (${net})`, x: axis, y: wave.map((v) => v * scale - lane), unit: "V", readout: wave });
        lanes.push({ at: 0.4 - lane, label: laneName(channel, net) });
      }
      note.style.display = series.length ? "none" : "";
      const end = axis[axis.length - 1];
      const span = settings.timePerDiv * 10;
      const start = Math.max(axis[0], end - span);
      plot.set(series, {
        xLabel: "Time (s)", xUnit: "s", xRange: [start, start + span],
        yRange: series.length ? [-(series.length - 1) * 1.2 - 0.1, 0.9] : undefined, yLanes: lanes,
      });
      stats.textContent = storedNote(end - axis[0], span, running());
    },
    clear() {
      plot.set([]);
      stats.textContent = "";
      note.style.display = "";
      note.textContent = "The circuit changed. Run it to see channels.";
    },
  };
}

/** What fits beside a lane. Hovering gives the whole net name. */
function laneName(channel: string, net: string): string {
  const name = `${channel}: ${net}`;
  return name.length > 10 ? `${name.slice(0, 9)}...` : name;
}

export function createBode(host: HTMLElement, comp: SchComponent, onClose: () => void): InstrumentView {
  const win = floatingWindow(host, `Bode plotter ${comp.refDes}`, 540, 420, onClose);
  const note = message(win.body, "The circuit needs an AC source. Run the simulation to plot.");
  const magnitude = new Plot(win.body);
  const phase = new Plot(win.body);
  return {
    element: win.root,
    follow(part) {
      comp = part;
      win.setTitle(`Bode plotter ${comp.refDes}`);
    },
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
      let driven = false;
      for (let i = 0; i < n; i++) {
        const [ip, iq] = read(nets.get("in+"), i);
        const [im, in2] = read(nets.get("in-"), i);
        const [op, oq] = read(nets.get("out+"), i);
        const [om, on] = read(nets.get("out-"), i);
        const inRe = ip - im, inIm = iq - in2, outRe = op - om, outIm = oq - on;
        if (inRe !== 0 || inIm !== 0) driven = true;
        const denom = inRe * inRe + inIm * inIm || 1e-300;
        const re = (outRe * inRe + outIm * inIm) / denom;
        const im2 = (outIm * inRe - outRe * inIm) / denom;
        db[i] = 20 * Math.log10(Math.hypot(re, im2) || 1e-30);
        degrees[i] = (Math.atan2(im2, re) * 180) / Math.PI;
      }
      // With nothing at the input there's no gain to measure, and -600 dB would look like one.
      if (!driven) {
        magnitude.set([]);
        phase.set([]);
        note.style.display = "";
        note.textContent = "No AC signal reaches the IN pins, so there's no gain to plot. Add an AC source or a function generator.";
        return;
      }
      note.style.display = "none";
      magnitude.set([{ label: "Gain", x: ac.axis.re, y: db, unit: "dB" }], { logX: true, xUnit: "Hz", yLabel: "Gain (dB)" });
      phase.set([{ label: "Phase", x: ac.axis.re, y: degrees, color: "#1864ab", unit: "deg" }], { logX: true, xLabel: "Frequency (Hz)", xUnit: "Hz", yLabel: "Phase (degrees)" });
    },
    clear() {
      magnitude.set([]);
      phase.set([]);
      note.style.display = "";
      note.textContent = "The circuit changed. Run it to plot.";
    },
  };
}

/**
 * Serial terminal. It decodes UART frames on RX (referred to ground) from the transient data, and what is
 * typed into it goes out on TX while the circuit runs. Live chunks are decoded as they arrive.
 * `send` types bytes into the running circuit and returns why it could not, if it could not.
 */
export function createSerialTerminal(host: HTMLElement, comp: SchComponent, onClose: () => void, send?: (bytes: number[]) => string | undefined): InstrumentView {
  const win = floatingWindow(host, `Serial terminal ${comp.refDes}`, 380, 340, onClose);
  const screen = document.createElement("pre");
  screen.className = "serial-terminal";
  const detail = document.createElement("div");
  detail.className = "muted pad";
  const clearButton = document.createElement("button");
  clearButton.textContent = "Clear";
  // Keys go out one at a time as they are typed, as on a real terminal; Enter sends the chosen line ending.
  const typing = document.createElement("div");
  typing.className = "serial-input";
  const input = document.createElement("input");
  input.placeholder = "Type here to send on TX";
  input.setAttribute("aria-label", `Send from serial terminal ${comp.refDes}`);
  input.autocomplete = "off";
  input.spellcheck = false;
  const ending = document.createElement("select");
  ending.setAttribute("aria-label", "Enter sends");
  for (const [label, value] of [["Enter: CR", "\r"], ["Enter: LF", "\n"], ["Enter: CR LF", "\r\n"], ["Enter: nothing", ""]]) {
    const option = document.createElement("option");
    option.textContent = label;
    option.value = value;
    ending.append(option);
  }
  const sentNote = document.createElement("div");
  sentNote.className = "muted pad";
  let sent = 0;
  const transmit = (chars: string) => {
    // Characters outside one byte are sent as "?", as a terminal with an 8-bit character set would.
    const bytes = [...chars].map((ch) => (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63));
    if (!bytes.length) return;
    const problem = send ? send(bytes) : "This terminal cannot send.";
    if (problem) { sentNote.textContent = problem; return; }
    sent += bytes.length;
    sentNote.textContent = `Sent ${sent} byte${sent === 1 ? "" : "s"} on TX.`;
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation(); // the sheet's own shortcuts must not see typing
    if (event.key === "Enter") { event.preventDefault(); transmit(ending.value); input.value = ""; }
    else if (event.key === "Backspace") { event.preventDefault(); transmit("\b"); }
    else if (event.key === "Tab") { event.preventDefault(); transmit("\t"); }
    else if (event.key === "Escape") { event.preventDefault(); transmit("\x1b"); }
  });
  // Text arrives here however it was entered: keys, an input method, dictation or an on-screen keyboard.
  // It is sent at once and the box cleared, so the box only ever holds text still being composed.
  input.addEventListener("input", (event) => {
    if ((event as InputEvent).isComposing) return;
    transmit(input.value);
    input.value = "";
  });
  input.addEventListener("compositionend", () => { transmit(input.value); input.value = ""; });
  input.addEventListener("paste", (event) => {
    event.preventDefault();
    transmit((event.clipboardData?.getData("text") ?? "").replace(/\r?\n/g, ending.value));
  });
  typing.append(input, ending, clearButton);
  win.body.append(screen, typing, sentNote, detail);
  let text = "", resume = -Infinity, errors = 0, streamed = false;
  const lineState = { afterCr: false };
  // Samples not yet decoded, carried between live chunks so a frame split across two chunks is read whole.
  let tailTime: number[] = [], tailVolts: number[] = [];
  const reset = () => { text = ""; resume = -Infinity; errors = 0; streamed = false; tailTime = []; tailVolts = []; screen.textContent = ""; };
  clearButton.onclick = () => { text = ""; errors = 0; screen.textContent = ""; };
  const settings = () => ({ baud: readValue(comp.params.baud ?? "9600") ?? 0, threshold: readValue(comp.params.threshold ?? "2.5") ?? 2.5, parity: (comp.params.parity as "none" | "even" | "odd") ?? "none" });
  const describe = () => `${settings().baud || "?"} baud, 8 data bits, ${comp.params.parity ?? "none"} parity, 1 stop bit, idle high.`;
  detail.textContent = describe();
  const show = (decoded: ReturnType<typeof decodeUart>) => {
    resume = decoded.resume;
    if (decoded.gap && text) text += "\n[samples missed: decoding resynchronized]\n";
    errors += decoded.bytes.filter((b) => b.error).length;
    text += terminalText(decoded.bytes, lineState);
    if (text.length > 20000) text = text.slice(-20000);
    if (screen.textContent !== text) { screen.textContent = text; screen.scrollTop = screen.scrollHeight; }
    detail.textContent = describe() + (errors ? ` ${errors} frame error${errors === 1 ? "" : "s"} (shown as �).` : "");
  };
  const rxNet = (run: RunData) => run.pinNets.get(comp.id)?.get("RX") ?? run.pinNets.get(comp.id)?.get("RXD");
  return {
    element: win.root,
    follow(part) {
      comp = part;
      win.setTitle(`Serial terminal ${comp.refDes}`);
    },
    stream(run, time, vector) {
      const net = rxNet(run), s = settings();
      const volts = net && net !== "0" ? vector(`v(${net})`) : undefined;
      if (!volts || !(s.baud > 0) || !time.length) return;
      // A new run starts its time again.
      if (tailTime.length && time[0] < tailTime[0]) reset();
      streamed = true;
      // Consecutive chunks can share their boundary sample.
      let first = 0;
      const last = tailTime.length ? tailTime[tailTime.length - 1] : -Infinity;
      while (first < time.length && time[first] <= last) first++;
      const allTime = tailTime.concat(Array.from(time.subarray(first))), allVolts = tailVolts.concat(Array.from(volts.subarray(first)));
      show(decodeUart(allTime, allVolts, s, resume));
      // Keep one sample before the resume point, for edge detection, and everything after it.
      let from = 0;
      while (from + 1 < allTime.length && allTime[from + 1] <= resume) from++;
      tailTime = allTime.slice(from);
      tailVolts = allVolts.slice(from);
    },
    update(run) {
      if (streamed) return;
      const net = rxNet(run), s = settings();
      const time = run.tran?.axis?.re;
      const volts = net && net !== "0" && run.tran ? findVector(run.tran, `v(${net})`)?.re : undefined;
      if (!time || !volts || !(s.baud > 0)) {
        detail.textContent = !(s.baud > 0) ? "Set a positive baud rate." : net ? "Needs a transient run to decode." : "Connect RX to a signal.";
        return;
      }
      reset();
      show(decodeUart(time, volts, s));
    },
    clear() {
      reset();
      detail.textContent = "The circuit changed. Run it to receive.";
    },
  };
}
