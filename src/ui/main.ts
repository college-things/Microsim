// Application shell: menus, palette, properties, spreadsheet, dialogs and the simulate flow.
import { Assistant } from "../agent/assistant";
import { findVector, fourier, monteCarlo, parameterSweep, temperatureSweep, type SweepRun } from "../core/analyses";
import { Doc, newId } from "../core/doc";
import { PART_BY_KIND, PARTS } from "../core/library";
import { buildNetlist, listSources, parseValue, pinWorld, readValue, resolveSource } from "../core/netlist";
import type { ImportIssue, SchComponent, Schematic } from "../core/schematic";
import type { AnalysisRequest, SimResult } from "../core/sim";
import { runSimulation, stopSimulation } from "../sim/client";
import { LiveBuffer, LiveRun } from "../sim/live";
import { SchematicCanvas } from "./canvas";
import { createBode, createLogicAnalyzer, createMultimeter, createScope, createWattmeter, floatingWindow, type InstrumentView, type RunData, type ScopeSettings } from "./instruments";
import { buildExample, EXAMPLES, type Example } from "../core/examples";
import { resultToCsv, runsToCsv, schematicToSvg } from "../core/export";
import { indicatorParts, indicatorVectors, readIndicator } from "../core/indicators";
import { limitIssues, unsimulatedParts } from "../core/limits";
import { guardWindowClose, installNativeMenu, openFile, saveFile } from "./platform";
import { parseCircuit, serializeCircuit } from "../core/file";
import { applyInteractive, validateImportedParam } from "../importer/interactive";
import { formatSI, Plot, type Series } from "./plot";

const FILE_EXTENSION = "ohmlet";
const KEY_STORAGE = "ohmlet.apiKey";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (node as HTMLElement).append(...children);
  return node;
}

const readStore = (key: string) => {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
};
const writeStore = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* Private windows can block storage. */ }
};

const doc = new Doc();
const app = document.getElementById("app")!;
const shell = el("div", { className: "app" });
app.append(shell);

// Layout
const menubar = el("div", { className: "menubar" }, el("span", { className: "brand" }, "Ohmlet"));
const toolbar = el("div", { className: "toolbar" });
const main = el("div", { className: "main" });
const statusbar = el("div", { className: "statusbar" });
const statusText = el("span", { className: "grow" });
const statusCount = el("span");
statusbar.append(statusText, statusCount);
shell.append(menubar, toolbar, main, statusbar);

const palette = el("aside", { className: "palette" });
const center = el("div", { className: "center" });
const side = el("aside", { className: "side" });
main.append(palette, center, side);

const sheetHost = el("div", { className: "sheet-host" });
const spreadsheet = el("section", { className: "spreadsheet" });
center.append(sheetHost, spreadsheet);

const canvas = new SchematicCanvas(sheetHost, doc);
canvas.onStatus = (text) => { statusText.textContent = text; };
const limitsBanner = el("div", { className: "limits-banner", role: "alert", hidden: true });
sheetHost.append(limitsBanner);

/** Says directly what won't work in this circuit, as otherwise it just seems unresponsive. */
let shownNotices: string[] = [];
function showLimitsBanner(): void {
  const notices = unsimulatedParts(doc.schematic);
  limitsBanner.hidden = !notices.length;
  limitsBanner.textContent = notices.join(" ");
  issues = [...limitIssues(doc.schematic), ...issues.filter((issue) => !shownNotices.includes(issue.message) && !notices.includes(issue.message))];
  shownNotices = notices;
}

const emptyHint = el("div", { className: "empty-hint" },
  el("strong", { textContent: "Start a circuit" }),
  "Pick a part on the left and click here to place it, then click its pins to wire it. Or open a circuit from the Examples menu.");
sheetHost.append(emptyHint);

// Tabs helper
function tabs(parent: HTMLElement, names: string[], onShow: (name: string, body: HTMLElement) => void) {
  const bar = el("div", { className: "tabs", role: "tablist" });
  const body = el("div", { className: "tab-body", role: "tabpanel" });
  parent.append(bar, body);
  let active = names[0];
  const buttons = names.map((name) => {
    const button = el("button", { textContent: name, role: "tab" });
    button.onclick = () => show(name);
    button.onkeydown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.stopPropagation();
      const step = e.key === "ArrowRight" ? 1 : -1;
      const next = names[(names.indexOf(name) + step + names.length) % names.length];
      show(next);
      buttons[names.indexOf(next)].focus();
    };
    bar.append(button);
    return button;
  });
  const show = (name: string) => {
    active = name;
    buttons.forEach((b) => {
      b.classList.toggle("active", b.textContent === name);
      b.setAttribute("aria-selected", String(b.textContent === name));
    });
    body.replaceChildren();
    onShow(name, body);
  };
  show(active);
  return { show, refresh: () => show(active), current: () => active };
}

// Spreadsheet
let issues: ImportIssue[] = [];
let log: { text: string; kind: "" | "error" | "warning" }[] = [];
let lastOpRows: [string, number, string][] = [];

const sheetTabs = tabs(spreadsheet, ["Results", "Components", "Netlist", "Issues"], (name, body) => {
  if (name === "Results") {
    if (lastOpRows.length) {
      const table = el("table");
      table.innerHTML = "<thead><tr><th>Signal</th><th>Value</th></tr></thead>";
      const rows = el("tbody");
      for (const [signal, value, unit] of lastOpRows) {
        rows.append(el("tr", {}, el("td", { textContent: signal }), el("td", { className: "num", textContent: formatSI(value, unit) })));
      }
      table.append(rows);
      body.append(table);
    }
    const pre = el("pre");
    for (const entry of log) {
      pre.append(el("div", { className: entry.kind ? `issue-${entry.kind}` : "", textContent: entry.text }));
    }
    if (!log.length && !lastOpRows.length) pre.append("Run a simulation to see results here.");
    body.append(pre);
  } else if (name === "Components") {
    const table = el("table");
    table.innerHTML = "<thead><tr><th>Ref</th><th>Part</th><th>Value</th><th>Pins</th></tr></thead>";
    const rows = el("tbody");
    const nets = buildNetlist(doc.schematic).pinNets;
    for (const comp of doc.schematic.components) {
      const part = PART_BY_KIND.get(comp.kind);
      const pinText = [...(nets.get(comp.id) ?? new Map<string, string>())].map(([p, n]) => `${p}:${n}`).join("  ");
      const row = el("tr", { tabIndex: 0 },
        el("td", { textContent: comp.refDes }),
        el("td", { textContent: part?.name ?? comp.kind }),
        el("td", { textContent: comp.displayValue ?? (part?.valueParam ? comp.params[part.valueParam] : "") ?? "" }),
        el("td", { textContent: pinText }));
      row.onclick = () => canvas.select([comp.id]);
      row.onkeydown = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          canvas.select([comp.id]);
        }
      };
      rows.append(row);
    }
    table.append(rows);
    body.append(table);
  } else if (name === "Netlist") {
    body.append(el("pre", { textContent: buildNetlist(doc.schematic).text }));
  } else {
    const netlistWarnings = buildNetlist(doc.schematic).warnings;
    const pre = el("pre");
    for (const issue of issues) {
      pre.append(el("div", {
        className: `issue-${issue.severity}`,
        textContent: `${issue.severity}${issue.refDes ? ` ${issue.refDes}` : ""}: ${issue.message}`,
      }));
    }
    for (const warning of netlistWarnings) pre.append(el("div", { className: "issue-warning", textContent: `warning: ${warning}` }));
    if (!pre.childElementCount) pre.textContent = "No issues.";
    body.append(pre);
  }
});

function writeLog(text: string, kind: "" | "error" | "warning" = ""): void {
  log.push({ text, kind });
  if (log.length > 200) log = log.slice(-200);
  sheetTabs.show("Results");
}

// Numbers from before an edit must never pass for the current circuit.
function markResultsStale(): void {
  dcSolved = false;
  // Anything still running is working on a circuit that no longer exists.
  if (activity !== "idle") endActivity();
  for (const view of views.values()) view.clear();
  canvas.displays.clear();
  for (const [win, title] of resultWindows) {
    const name = win.querySelector(".window-title span");
    if (name) name.textContent = `${title} (out of date)`;
  }
  if (!lastRun && !lastOpRows.length && !canvas.probes.size && !log.length) return;
  lastRun = undefined;
  lastOpRows = [];
  canvas.probes.clear();
  log = [{ text: "The circuit changed. Run again to update the results.", kind: "warning" }];
  if (sheetTabs.current() === "Results") sheetTabs.refresh();
  runState.textContent = "Results out of date";
}

let lastSignature = "";
let settingEdit = false;
doc.subscribe(() => {
  statusCount.textContent = `${doc.schematic.components.length} parts, ${doc.schematic.wires.length} wires`;
  emptyHint.hidden = doc.schematic.components.length > 0;
  for (const [id, view] of views) {
    if (!doc.schematic.components.some((c) => c.id === id)) {
      view.element.remove();
      views.delete(id);
    }
  }
  // Moving a part or changing nothing electrical keeps results valid.
  const signature = buildNetlist(doc.schematic).text;
  if (signature !== lastSignature) {
    lastSignature = signature;
    // A setting changed on a running circuit carries on, so its readings stay live.
    if (!settingEdit) markResultsStale();
    showLimitsBanner();
  }
  if (sheetTabs.current() !== "Results") sheetTabs.refresh();
  renderProperties();
  scheduleAutosave();
});

// Palette
function partIcon(kind: string): HTMLCanvasElement {
  const icon = el("canvas", { width: 60, height: 44 });
  const ctx = icon.getContext("2d")!;
  const part = PART_BY_KIND.get(kind)!;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--symbol").trim();
  ctx.scale(0.62, 0.62);
  ctx.translate(48, 35);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  for (const g of part.graphics) {
    ctx.beginPath();
    if (g.kind === "line" || g.kind === "polygon") {
      g.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (g.kind === "polygon") { ctx.closePath(); if (g.filled) ctx.fill(); }
      ctx.stroke();
    } else if (g.kind === "rect") {
      ctx.strokeRect(g.x, g.y, g.w, g.h);
    } else if (g.kind === "ellipse") {
      ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, 7);
      ctx.stroke();
    }
  }
  return icon;
}

const partSearch = el("input", { type: "search", placeholder: "Find a part", ariaLabel: "Find a part", className: "part-search" });
palette.append(partSearch);
const partList = el("div");
palette.append(partList);
function renderPalette(): void {
  const query = partSearch.value.trim().toLowerCase();
  partList.replaceChildren();
  for (const category of ["Sources", "Basic", "Diodes", "Transistors", "Analog", "Digital", "Instruments"] as const) {
    const parts = PARTS.filter((p) => p.category === category && p.name.toLowerCase().includes(query));
    if (!parts.length) continue;
    partList.append(el("h4", { textContent: category }));
    for (const part of parts) {
      const button = el("button", { className: "part", title: `Place ${part.name}`, draggable: true }, partIcon(part.kind), part.name);
      button.onclick = (e: MouseEvent) => {
        // detail is 0 when a key pressed the button, and there's no pointer to place with.
        if (e.detail === 0) canvas.placeAtCenter(part.kind);
        else canvas.beginPlace(part.kind);
      };
      button.ondragstart = (e: DragEvent) => e.dataTransfer?.setData("text/part", part.kind);
      partList.append(button);
    }
  }
  if (!partList.childElementCount) partList.append(el("p", { className: "muted pad", textContent: "No matching parts. Add a SPICE model block to use your own model." }));
}
partSearch.oninput = renderPalette;
renderPalette();

canvas.onActivate = (comp) => {
  if (comp.interactive?.kind === "switch") {
    toggleSwitch(comp);
  } else if (comp.kind === "switch") {
    changeSetting(() => { comp.params.state = comp.params.state === "closed" ? "open" : "closed"; });
  } else if (comp.instrument && comp.instrument !== "function-generator" && comp.instrument !== "clock" && comp.instrument !== "unsupported") {
    openInstrument(comp);
  } else {
    sideTabs.show("Properties");
    propsBody?.querySelector("input, select")?.scrollIntoView();
    propsBody?.querySelector<HTMLElement>("input:not([data-ref]), select")?.focus();
  }
};


// Properties and assistant
let propsBody: HTMLElement | undefined;
const sideTabs: ReturnType<typeof tabs> = tabs(side, ["Properties", "Assistant"], (name, body) => {
  if (name === "Properties") {
    propsBody = body;
    renderProperties();
  } else {
    propsBody = undefined;
    body.append(chatPanel());
  }
});

function renderProperties(): void {
  if (!propsBody) return;
  const body = propsBody;
  const active = document.activeElement;
  if (active && body.contains(active)) return;
  body.replaceChildren();
  const wrap = el("div", { className: "pad" });
  body.append(wrap);
  const selected = doc.schematic.components.filter((c) => canvas.selection.has(c.id));
  if (selected.length !== 1) {
    wrap.append(el("p", {
      className: "muted",
      textContent: selected.length > 1 ? `${selected.length} parts selected.` : "Select a part to edit it. Click a pin to start a wire. R rotates, M mirrors, Delete removes.",
    }));
    return;
  }
  const comp = selected[0];
  const part = PART_BY_KIND.get(comp.kind);
  const heading = el("h4", { textContent: part?.name ?? "Imported part" });
  heading.style.margin = "0 0 8px";
  wrap.append(heading);
  const field = (label: string, control: HTMLElement) => wrap.append(el("label", { className: "field" }, label, control));
  const ref = el("input", { value: comp.refDes });
  ref.dataset.ref = "true";
  const problem = el("p", { className: "field-error", role: "alert", hidden: true });
  const report = (control: HTMLElement, text: string) => {
    problem.textContent = text;
    problem.hidden = !text;
    control.setAttribute("aria-invalid", text ? "true" : "false");
  };
  ref.onchange = () => {
    const name = ref.value.trim();
    if (comp.lockedName) {
      report(ref, "Other parts refer to this part by name, so renaming it would break them.");
      ref.value = comp.refDes;
      return;
    }
    const clash = doc.schematic.components.some((c) => c !== comp && c.refDes.toLowerCase() === name.toLowerCase());
    if (!name || clash || !/^[\w.+-]+$/.test(name)) {
      report(ref, !name ? "A part needs a name." : clash ? `${name} is already in use.` : "Use letters, numbers, dots, dashes or underscores.");
      ref.value = comp.refDes;
      return;
    }
    report(ref, "");
    doc.checkpoint();
    comp.refDes = name;
    doc.notify();
  };
  field("Reference", ref);
  // Imported parts expose only settings the file gives a real name.
  const imported = Object.keys(comp.paramLabels ?? {}).map((key) => ({
    key, label: comp.paramLabels![key], default: "", options: undefined as string[] | undefined, text: true,
  }));
  const defs: { key: string; label: string; default: string; options?: string[]; text?: boolean }[] = part?.params ?? imported;
  for (const def of defs) {
    const control = def.options
      ? el("select", {}, ...def.options.map((o) => el("option", { value: o, textContent: o, selected: comp.params[def.key] === o })))
      : el("input", { value: comp.params[def.key] ?? "" });
    control.onchange = () => {
      if (part && !def.options && !def.text && readValue(control.value) === undefined) {
        report(control, `"${control.value}" isn't a value. Try 10k, 4.7u or 1M. Capital M means mega, small m means milli.`);
        return;
      }
      const invalid = part ? undefined : validateImportedParam(comp, def.key, control.value);
      if (invalid) {
        report(control, invalid);
        return;
      }
      report(control, "");
      // Changing a setting after a run updates the results, like turning a knob.
      changeSetting(() => {
        comp.params[def.key] = control.value;
        comp.displayValue = undefined;
      });
    };
    field(def.label, control);
  }
  wrap.append(problem);
  appendInteractive(wrap, comp);
  appendConnections(wrap, comp);
  if (comp.instrument && comp.instrument !== "unsupported" && comp.instrument !== "function-generator" && comp.instrument !== "clock") {
    wrap.append(el("button", { className: "primary", textContent: "Open instrument", onclick: () => openInstrument(comp) }));
  }
  if (!part && comp.spice) {
    wrap.append(el("p", { className: "muted", textContent: "SPICE definition from the imported file:" }), el("pre", { textContent: comp.spice }));
  }
}
canvas.onSelectionChange = renderProperties;

/** One edit to parts' settings, as a single undo step, applied to the circuit if it's running. */
function changeSetting(change: () => void): void {
  doc.checkpoint();
  change();
  // Only a circuit that's running takes the change live. A stopped one just waits for Run,
  // and its old numbers count as out of date like after any other edit.
  const running = activity === "run";
  // A solved DC circuit has nothing to stop, so a change simply solves it again.
  const resolve = dcSolved;
  settingEdit = running;
  doc.notify();
  settingEdit = false;
  if (running) applySettingsToRun();
  else if (resolve) void simulateRun();
}

// Several presses can land together, and the circuit only needs the latest values.
let settingTimer: ReturnType<typeof setTimeout> | undefined;
let updatesInFlight = 0;

/** Drops a change still on its way to the circuit. Returns whether there was one. */
function cancelPendingSettings(): boolean {
  const pending = settingTimer !== undefined || updatesInFlight > 0;
  if (settingTimer) clearTimeout(settingTimer);
  settingTimer = undefined;
  return pending;
}

function applySettingsToRun(): void {
  if (settingTimer) return;
  settingTimer = setTimeout(async () => {
    settingTimer = undefined;
    const netlist = buildNetlist(doc.schematic);
    if (netlist.errors.length) {
      endActivity();
      for (const error of netlist.errors) log.push({ text: error, kind: "error" });
      sheetTabs.show("Results");
      return;
    }
    const current = live;
    if (current) {
      updatesInFlight++;
      const applied = await current.update(netlist.text);
      updatesInFlight--;
      if (current !== live) return;
      // Only a change of structure needs a restart, which is what costs the circuit its state.
      if (applied) void refreshSnapshots(netlist.text);
      else restartRun();
      return;
    }
    // Still on its operating point, which has now been overtaken.
    if (activity === "run") restartRun();
  }, 30);
}

/** The results a live update doesn't refresh by itself: the DC table and any Bode plot. */
async function refreshSnapshots(netlist: string): Promise<void> {
  const run = lastRun;
  const token = runToken;
  if (!run) return;
  try {
    const op = await runSimulation(netlist, { type: "op" });
    if (token !== runToken) return;
    run.op = op;
    lastOpRows = op.vectors.map((v) => [v.name, v.re[0], v.unit]);
    // Wires the live data doesn't carry show this operating point instead.
    showProbes(op, doc.schematic, run.pinNets);
    canvas.invalidate();
    const bode = doc.schematic.components.find((c) => c.instrument === "bode-plotter");
    if (bode) {
      const ac = await runSimulation(netlist, {
        type: "ac", sweep: "dec", points: 40,
        fstart: parseValue(bode.params.fstart) || 1, fstop: parseValue(bode.params.fstop) || 1e7,
      });
      if (token !== runToken) return;
      run.ac = ac;
    }
    for (const view of views.values()) view.update(run);
    if (sheetTabs.current() === "Results") sheetTabs.refresh();
  } catch {
    // The running circuit reports real problems. These tables just stay blank until then.
    lastOpRows = [];
    if (sheetTabs.current() === "Results") sheetTabs.refresh();
  }
}

function setInteractive(comps: SchComponent[], value: (comp: SchComponent) => number): void {
  changeSetting(() => {
    for (const comp of comps) Object.assign(comp, applyInteractive(comp, value(comp)));
  });
}

const nextPosition = (comp: SchComponent) => {
  const spec = comp.interactive;
  return spec?.kind === "switch" ? (spec.position + 1) % spec.positions : 0;
};

const buttonReleases = new Set<ReturnType<typeof setTimeout>>();

/** Lets go of momentary buttons by id, since undo can replace the part objects meanwhile. */
function releaseButtons(ids: string[]): void {
  const parts = doc.schematic.components.filter((c) => ids.includes(c.id));
  if (parts.length) setInteractive(parts, () => 0);
}

function toggleSwitch(comp: SchComponent): void {
  if (comp.interactive?.kind !== "switch") return;
  if (comp.interactive.momentary) {
    // Clicking a momentary button presses it and lets go.
    setInteractive([comp], () => comp.interactive?.kind === "switch" ? comp.interactive.positions - 1 : 1);
    const id = comp.id;
    const release = setTimeout(() => {
      buttonReleases.delete(release);
      releaseButtons([id]);
    }, 200);
    buttonReleases.add(release);
    return;
  }
  setInteractive([comp], nextPosition);
}

/** Moves a variable part by one key press: up with the key, down with Shift. */
function stepVariable(comp: SchComponent, down: boolean): number {
  if (comp.interactive?.kind !== "variable") return 0;
  const step = comp.interactive.increment ?? 5;
  return Math.min(100, Math.max(0, comp.interactive.percent + (down ? -step : step)));
}

function appendInteractive(wrap: HTMLElement, comp: SchComponent): void {
  const spec = comp.interactive;
  if (spec?.kind === "switch") {
    const hint = spec.key ? ` (key ${spec.key})` : "";
    const button = el("button", {
      textContent: `Switch position ${spec.position + 1} of ${spec.positions}${hint}`,
      onclick: () => toggleSwitch(comp),
    });
    wrap.append(button);
  } else if (spec?.kind === "variable") {
    const slider = el("input", { type: "range", min: "0", max: "100", step: String(spec.increment ?? 1), value: String(spec.percent), ariaLabel: "Setting in percent" });
    slider.style.width = "100%";
    slider.onchange = () => setInteractive([comp], () => Number(slider.value));
    wrap.append(el("label", { className: "field" }, `Setting: ${spec.percent}%${spec.key ? ` (key ${spec.key})` : ""}`, slider));
  }
}

/** Wiring without a pointer: pick a pin and what it connects to. */
function appendConnections(wrap: HTMLElement, comp: SchComponent): void {
  if (!comp.pins.length) return;
  const others = doc.schematic.components.filter((c) => c !== comp && c.refDes);
  const nets = buildNetlist(doc.schematic).pinNets.get(comp.id);
  const heading = el("h4", { textContent: "Connections" });
  heading.style.margin = "12px 0 6px";
  wrap.append(heading);
  for (const pin of comp.pins) {
    const target = el("select", { ariaLabel: `Connect pin ${pin.name} to` },
      el("option", { value: "", textContent: nets?.get(pin.name) ? `On net ${nets.get(pin.name)}. Connect to...` : "Not connected. Connect to..." }));
    for (const other of others) {
      for (const otherPin of other.pins) {
        target.append(el("option", { value: `${other.id}|${otherPin.name}`, textContent: `${other.refDes} pin ${otherPin.name}` }));
      }
    }
    target.onchange = () => {
      const [id, name] = target.value.split("|");
      const other = doc.schematic.components.find((c) => c.id === id);
      if (!other) return;
      doc.checkpoint();
      doc.connectPins(comp, pin.name, other, name);
      doc.notify();
      statusText.textContent = `Connected ${comp.refDes} pin ${pin.name} to ${other.refDes} pin ${name}.`;
      target.blur();
      renderProperties();
    };
    wrap.append(el("label", { className: "field" }, `Pin ${pin.name}`, target));
  }
}

// Instruments
const views = new Map<string, InstrumentView>();
const scopeSettings = new Map<string, ScopeSettings>();
let lastRun: RunData | undefined;

/** Starts from what the file stored for this scope, if anything. */
function scopeDefaults(comp: SchComponent, netlist: string): ScopeSettings {
  const stored = (key: string) => readValue(comp.params[key]) ?? 0;
  return {
    timePerDiv: stored("timePerDiv") || autoTimePerDiv(netlist),
    voltsPerDivA: stored("voltsPerDivA"),
    voltsPerDivB: stored("voltsPerDivB"),
    triggerLevel: readValue(comp.params.triggerLevel),
  };
}

function openInstrument(comp: SchComponent): void {
  if (views.has(comp.id)) return;
  const onClose = () => views.delete(comp.id);
  let view: InstrumentView | undefined;
  if (comp.instrument === "oscilloscope") {
    const settings = scopeSettings.get(comp.id) ?? scopeDefaults(comp, buildNetlist(doc.schematic).text);
    scopeSettings.set(comp.id, settings);
    view = createScope(sheetHost, comp, settings, () => {
      // A running circuit just sweeps at the new rate. A stopped one is run again for it.
      comp.params.timePerDiv = String(settings.timePerDiv);
      doc.dirty = true;
      if (live) live.setRate(liveRate(doc.schematic.components.filter((c) => c.instrument), buildNetlist(doc.schematic).text));
      else if (lastRun) view?.update(lastRun);
    }, onClose);
  } else if (comp.instrument === "multimeter") {
    view = createMultimeter(sheetHost, comp, onClose);
  } else if (comp.instrument === "bode-plotter") {
    view = createBode(sheetHost, comp, onClose);
  } else if (comp.instrument === "wattmeter") {
    view = createWattmeter(sheetHost, comp, onClose);
  } else if (comp.instrument === "logic-analyzer") {
    view = createLogicAnalyzer(sheetHost, comp, onClose);
  }
  if (view) {
    views.set(comp.id, view);
    if (lastRun) view.update(lastRun);
  }
}

// Interactive run: operating point, plus transient and AC when instruments or sources need them.
// One thing runs at a time, and it owns the Run and Stop buttons and the status.
type Activity = "idle" | "run" | "analysis";
let activity: Activity = "idle";
// True after a run that solved once and finished, because nothing in the circuit changes over time.
let dcSolved = false;
const runButton = el("button", { className: "primary run", textContent: "Run" });
const stopButton = el("button", { textContent: "Stop", disabled: true });
const runState = el("span", { className: "run-state" });

function setActivity(next: Activity, text = ""): void {
  activity = next;
  runButton.disabled = next !== "idle";
  stopButton.disabled = next === "idle";
  runState.textContent = text;
}

/** Ends whatever is running, so that a late result from it can't report anything. */
function endActivity(text = ""): void {
  runToken++;
  cancelPendingSettings();
  stopLive();
  stopSimulation();
  setActivity("idle", text);
}

function friendly(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Each run has a token, so a run overtaken by a newer one can't report or start anything.
let runToken = 0;

async function simulateRun(): Promise<void> {
  if (activity !== "idle") return;
  const token = ++runToken;
  dcSolved = false;
  // A value still being typed counts as entered.
  (document.activeElement as HTMLElement | null)?.closest?.(".side")?.querySelector<HTMLElement>(":focus")?.blur();
  const stopText = stopAtInput.value.trim();
  if (stopText && !((readValue(stopText) ?? 0) > 0)) {
    writeLog(`"${stopText}" isn't a time after the start. Try 10m, or leave Stop at empty to run until stopped.`, "error");
    return;
  }
  const schematic = doc.schematic;
  const netlist = buildNetlist(schematic);
  log = [];
  lastOpRows = [];
  for (const warning of netlist.warnings) log.push({ text: warning, kind: "warning" });
  if (!schematic.components.length) {
    writeLog("Place some parts first.", "warning");
    return;
  }
  if (netlist.errors.length) {
    for (const error of netlist.errors) log.push({ text: error, kind: "error" });
    sheetTabs.show("Results");
    return;
  }
  setActivity("run", "Simulating...");
  canvas.probes.clear();
  const run: RunData = { pinNets: netlist.pinNets, refs: netlist.refs };
  for (const notice of unsimulatedParts(schematic)) log.push({ text: notice, kind: "error" });
  try {
    run.op = await runSimulation(netlist.text, { type: "op" });
    if (token !== runToken) return;
    for (const warning of new Set(run.op.warnings)) log.push({ text: warning, kind: "warning" });
    lastOpRows = run.op.vectors.map((v) => [v.name, v.re[0], v.unit]);
    showProbes(run.op, schematic, netlist.pinNets);
    updateIndicators(run, run.op);

    const instruments = schematic.components.filter((c) => c.instrument);
    const scopes = instruments.filter((c) => c.instrument === "oscilloscope");
    for (const scope of scopes) {
      if (!scopeSettings.has(scope.id)) scopeSettings.set(scope.id, scopeDefaults(scope, netlist.text));
    }
    const bode = instruments.find((c) => c.instrument === "bode-plotter");
    if (bode) {
      run.ac = await runSimulation(netlist.text, {
        type: "ac", sweep: "dec", points: 40,
        fstart: parseValue(bode.params.fstart) || 1, fstop: parseValue(bode.params.fstop) || 1e7,
      });
      if (token !== runToken) return;
    }
    for (const comp of instruments) if (!views.has(comp.id)) openInstrument(comp);
    lastRun = run;
    for (const view of views.values()) view.update(run);
    log.push({ text: `Operating point solved in ${Math.round(run.op.stats.elapsedMs)} ms (${run.op.stats.unknowns} unknowns).`, kind: "" });
    const stale = buildNetlist(doc.schematic).text !== netlist.text;
    if (stale) log.push({ text: "The circuit changed during this run, so these results are out of date.", kind: "warning" });
    else startLive(run, netlist.text, instruments, scopes);
  } catch (error) {
    if (token === runToken) log.push({ text: friendly(error), kind: "error" });
  } finally {
    if (token === runToken) {
      if (!live) {
        setActivity("idle");
        dcSolved = Boolean(lastRun?.op);
      }
      sheetTabs.show("Results");
      canvas.invalidate();
    }
  }
}

// Continuous running. The worker keeps simulating, and instruments redraw at a steady rate
// from the newest samples, so behaviour that takes a long time to appear can be watched.
let live: LiveRun | undefined;
let liveFrame = 0;
const stopAtInput = el("input", { placeholder: "never", title: "Simulated time to stop at, such as 10m", ariaLabel: "Stop at simulated time" });
stopAtInput.className = "stop-at";
const speedSelect = el("select", { ariaLabel: "Simulation speed", title: "How fast simulated time passes" },
  el("option", { value: "auto", textContent: "Auto speed" }),
  el("option", { value: "real", textContent: "Real time" }),
  el("option", { value: "max", textContent: "Fastest" }));
speedSelect.onchange = () => {
  if (live) live.setRate(liveRate(doc.schematic.components.filter((c) => c.instrument), buildNetlist(doc.schematic).text));
};

/**
 * Simulated seconds per real second. A scope gets ten screens a second, so slow start-ups don't
 * take minutes. Without one, real time keeps LEDs and counters at a speed a person can watch.
 */
function liveRate(instruments: SchComponent[], netlist: string): number | undefined {
  if (speedSelect.value === "max") return undefined;
  if (speedSelect.value === "real") return 1;
  const scopes = instruments.filter((c) => c.instrument === "oscilloscope");
  if (scopes.length) {
    const perDiv = Math.max(...scopes.map((c) => scopeSettings.get(c.id)?.timePerDiv ?? 0), 0) || autoTimePerDiv(netlist);
    return perDiv * 100;
  }
  if (instruments.some((c) => c.instrument === "logic-analyzer")) return autoTimePerDiv(netlist) * 10;
  return 1;
}

function stopLive(): void {
  live?.stop();
  live = undefined;
  if (liveFrame) cancelAnimationFrame(liveFrame);
  liveFrame = 0;
}

/** The nets and sense sources the open instruments read, so nothing else is transferred. */
function liveVectors(run: RunData, instruments: SchComponent[]): string[] {
  const names = new Set<string>();
  for (const comp of instruments) {
    for (const net of run.pinNets.get(comp.id)?.values() ?? []) if (net !== "0") names.add(`v(${net})`.toLowerCase());
    const ref = run.refs.get(comp.id);
    if (ref) names.add(`i(v${ref})`.toLowerCase());
  }
  for (const comp of indicatorParts(doc.schematic.components)) {
    for (const name of indicatorVectors(comp, run.pinNets.get(comp.id), run.refs.get(comp.id))) names.add(name);
  }
  // With nothing else to watch, the voltages shown on the wires follow the circuit.
  if (!names.size && showVoltages && doc.schematic.components.length <= 80) {
    for (const nets of run.pinNets.values()) for (const net of nets.values()) if (net !== "0") names.add(`v(${net})`.toLowerCase());
  }
  return [...names];
}

function updateWireVoltages(run: RunData, result: SimResult): void {
  if (!canvas.probes.size && !showVoltages) return;
  showProbes(result, doc.schematic, run.pinNets);
}

function updateIndicators(run: RunData, result: SimResult): void {
  for (const comp of indicatorParts(doc.schematic.components)) {
    const shown = readIndicator(comp, result, run.pinNets.get(comp.id), run.refs.get(comp.id));
    if (shown) canvas.displays.set(comp.id, shown);
    else canvas.displays.delete(comp.id);
  }
  canvas.invalidate();
}

function startLive(run: RunData, netlist: string, instruments: SchComponent[], scopes: SchComponent[]): void {
  stopLive();
  // Sources that change over time, whether a library part, a logic device or a file's source.
  const varies = /\b(sin|pulse|pwl|exp|sffm|am)\s*\(/i.test(netlist) || /^a\S*\s/im.test(netlist) || /\bsw_|\bd_/i.test(netlist);
  const watching = instruments.filter((c) => c.instrument !== "bode-plotter" && c.instrument !== "function-generator" && c.instrument !== "clock");
  const keep = liveVectors(run, watching);
  if (!keep.length || (!varies && !scopes.length)) return;
  const perDiv = () => Math.max(...scopes.map((c) => scopeSettings.get(c.id)!.timePerDiv), 0) || autoTimePerDiv(netlist);
  // Meters need several periods of the circuit's own signals however far a scope is zoomed in,
  // and a trigger needs three screens of the scope's.
  const history = () => Math.max(perDiv() * 30, autoTimePerDiv(netlist) * 10);
  const stopAt = readValue(stopAtInput.value);
  let simTime = 0;
  let dirtyFrame = false;
  let warned = false;
  // Buffers belong to one run, so a stopped run's last messages can't reach the next one's.
  let buffer: LiveBuffer | undefined;
  const draw = () => {
    liveFrame = live ? requestAnimationFrame(draw) : 0;
    if (!dirtyFrame || !buffer) return;
    dirtyFrame = false;
    run.tran = buffer.snapshot(history());
    lastRun = run;
    for (const view of views.values()) view.update(run);
    if (run.tran) {
      updateIndicators(run, run.tran);
      updateWireVoltages(run, run.tran);
    }
    runState.textContent = `Running, t = ${formatSI(simTime, "s")}`;
  };
  live = new LiveRun(netlist, keep, liveRate(instruments, netlist), stopAt && stopAt > 0 ? stopAt : undefined, {
    onReady(names, warnings) {
      buffer = new LiveBuffer(names);
      for (const warning of new Set(warnings)) {
        log.push({ text: warning, kind: "warning" });
        warned = true;
      }
      if (warned) sheetTabs.show("Results");
    },
    onChunk(time, values, reached) {
      buffer?.append(time, values);
      simTime = reached;
      dirtyFrame = true;
    },
    onFinished() {
      // Show the final samples, then settle.
      dirtyFrame = true;
      live = undefined;
      draw();
      setActivity("idle", `Stopped at t = ${formatSI(simTime, "s")}`);
    },
    onError(message) {
      live = undefined;
      setActivity("idle");
      writeLog(message, "error");
    },
  });
  liveFrame = requestAnimationFrame(draw);
  setActivity("run", "Running");
}

/** Runs again from the start, as when a value changes while the circuit is running. */
function restartRun(): void {
  endActivity();
  void simulateRun();
}

/** Shows about five periods of the slowest source, or 1 ms/div when nothing repeats. */
function autoTimePerDiv(netlist: string): number {
  let longest = 0;
  for (const match of netlist.matchAll(/\bsin\s*\(\s*(\S+)\s+(\S+)\s+([^\s)]+)/gi)) {
    const freq = parseValue(match[3]);
    if (freq > 0) longest = Math.max(longest, 1 / freq);
  }
  for (const match of netlist.matchAll(/\bpulse\s*\(([^)]*)\)/gi)) {
    const period = parseValue(match[1].trim().split(/\s+/)[6]);
    if (period > 0) longest = Math.max(longest, period);
  }
  return longest > 0 ? (longest * 5) / 10 : 1e-3;
}

function showProbes(op: SimResult, schematic: Schematic, pinNets: Map<string, Map<string, string>>): void {
  if (!showVoltages || schematic.components.length > 80) return;
  const seen = new Set<string>();
  for (const comp of schematic.components) {
    const nets = pinNets.get(comp.id);
    for (const pin of comp.pins) {
      const net = nets?.get(pin.name);
      if (!net || net === "0" || seen.has(net)) continue;
      const v = findVector(op, `v(${net})`);
      if (!v) continue;
      seen.add(net);
      const at = pinWorld(comp, pin);
      canvas.probes.set(`${at.x},${at.y}`, formatSI(v.re[v.re.length - 1], "V"));
    }
  }
}

runButton.onclick = () => void simulateRun();
stopButton.onclick = () => {
  // Stop is final: a change still on its way to the circuit mustn't start it again.
  const changeWasPending = settingTimer !== undefined || updatesInFlight > 0;
  endActivity("Stopped");
  // That change never reached the circuit, so the readings don't match the sheet.
  if (changeWasPending) markResultsStale();
};

let showVoltages = true;
let importedAnalyses: AnalysisRequest[] = [];

// Analyses dialog and grapher
function dialog(title: string, build: (body: HTMLElement, close: () => void) => void, onDismiss?: () => void): void {
  const overlay = el("div", { className: "overlay", role: "dialog" });
  const box = el("div", { className: "dialog" }, el("h3", { textContent: title }));
  const close = () => {
    overlay.remove();
    onDismiss?.();
  };
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  build(box, close);
  overlay.append(box);
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", title);
  // Keep the keyboard inside the dialog, and put focus back where it was afterward.
  const previous = document.activeElement as HTMLElement | null;
  overlay.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...box.querySelectorAll<HTMLElement>("input, select, textarea, button")].filter((n) => !(n as HTMLButtonElement).disabled);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  new MutationObserver((_, watcher) => {
    if (overlay.isConnected) return;
    watcher.disconnect();
    previous?.focus?.();
  }).observe(document.body, { childList: true });
  document.body.append(overlay);
  (box.querySelector<HTMLElement>("[autofocus]") ?? box.querySelector<HTMLElement>("input, select, textarea, button"))?.focus();
}

/** Windows that show results from an earlier circuit, closed when another file opens. */
const resultWindows = new Map<HTMLElement, string>();
function resultWindow(title: string, width: number, height: number) {
  const win = floatingWindow(sheetHost, title, width, height, () => resultWindows.delete(win.root));
  resultWindows.set(win.root, title);
  return win;
}

function grapher(title: string, runs: SweepRun[]): void {
  const first = runs[0]?.result;
  if (!first) return;
  const win = resultWindow(title, 620, 420);
  if (!first.axis) {
    const rows = runs.flatMap((r) => r.result.vectors.map((v) => `${runs.length > 1 ? `${r.label}  ` : ""}${v.name} = ${formatSI(v.re[0], v.unit)}`));
    const pre = el("pre", { textContent: rows.join("\n") });
    pre.style.overflow = "auto";
    win.body.append(pre);
    return;
  }
  const isAc = first.analysis === "ac";
  const plot = new Plot(win.body);
  const phase = isAc ? new Plot(win.body) : undefined;
  const legend = el("div", { className: "legend" });
  win.body.append(legend);
  legend.append(el("button", {
    className: "quiet", textContent: "Export CSV",
    onclick: () => void exportText(`${stem()}-${first.analysis}.csv`, "csv", runs.length > 1 ? runsToCsv(runs) : resultToCsv(first)),
  }));
  const names = first.vectors.map((v) => v.name);
  const picked = new Set(names.filter((n) => n.startsWith("v(") && !n.includes(".")).slice(0, 4));
  if (!picked.size && names[0]) picked.add(names[0]);
  const redraw = () => {
    const main: Series[] = [];
    const angle: Series[] = [];
    for (const run of runs) {
      const axis = run.result.axis!.re;
      for (const vector of run.result.vectors) {
        if (!picked.has(vector.name)) continue;
        const label = runs.length > 1 ? `${vector.name} ${run.label}` : vector.name;
        if (vector.im) {
          const db = Float64Array.from(vector.re, (re, i) => 20 * Math.log10(Math.hypot(re, vector.im![i]) || 1e-30));
          const deg = Float64Array.from(vector.re, (re, i) => (Math.atan2(vector.im![i], re) * 180) / Math.PI);
          main.push({ label, x: axis, y: db });
          angle.push({ label, x: axis, y: deg });
        } else {
          main.push({ label, x: axis, y: vector.re });
        }
      }
    }
    const axisName = first.axis!.name;
    plot.set(main, { logX: isAc, xLabel: isAc ? undefined : axisName, yLabel: isAc ? "dB" : undefined });
    phase?.set(angle, { logX: true, xLabel: "Frequency (Hz), magnitude in dB above, phase in degrees below" });
  };
  for (const name of names.slice(0, 60)) {
    const box = el("input", { type: "checkbox", checked: picked.has(name) });
    box.onchange = () => {
      if (box.checked) picked.add(name); else picked.delete(name);
      redraw();
    };
    legend.append(el("label", {}, box, name));
  }
  redraw();
}

interface AnalysisForm {
  type: string;
  /** Kept per analysis, because the same field name means different things across them. */
  values: Record<string, Record<string, string>>;
}
const formState: AnalysisForm = { type: "tran", values: {} };

/** Starting values that exist in the open circuit, plus suggestions for the field. */
function circuitChoices() {
  const netlist = buildNetlist(doc.schematic);
  const nets = [...new Set([...netlist.pinNets.values()].flatMap((m) => [...m.values()]))]
    .filter((net) => net !== "0")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const sources = listSources(netlist.text);
  const passives = doc.schematic.components.filter((c) => c.refDes && (c.family ?? c.kind) === "resistor").map((c) => c.refDes);
  // A signal source is a more useful starting point than a supply, which often has no gain.
  const line = (name: string) => netlist.text.split("\n").find((l) => l.startsWith(`${name} `)) ?? "";
  const signal = sources.find((name) => /\b(ac|sin|pulse|pwl)\b/i.test(line(name)));
  const sine = /\bsin\s*\(\s*\S+\s+\S+\s+([^\s)]+)/i.exec(netlist.text);
  return { nets, sources, passives, signal, frequency: sine?.[1] };
}

function fieldDefault(key: string, initial: string, choices: ReturnType<typeof circuitChoices>): string {
  const lastNet = choices.nets[choices.nets.length - 1] ?? "";
  switch (key) {
    case "source": return choices.signal ?? choices.sources[0] ?? initial;
    case "fund": return choices.frequency ?? initial;
    case "output": return lastNet ? `v(${lastNet})` : initial;
    case "node":
    case "outp": return lastNet || initial;
    case "inp": return choices.nets[0] ?? initial;
    case "ref": return choices.passives[0] ?? initial;
    default: return initial;
  }
}

/** Accepts a bare net name as shorthand for its voltage. */
const asOutput = (text: string) => (/[()]/.test(text) ? text.trim() : `v(${text.trim()})`);

function sourceOrThrow(netlist: string, typed: string): string {
  const source = resolveSource(netlist, typed);
  if (source) return source;
  const known = listSources(netlist);
  throw new Error(`No independent source called "${typed}". ${known.length ? `Sources here: ${known.slice(0, 12).join(", ")}.` : "This circuit has none."}`);
}

const ANALYSIS_FIELDS: Record<string, [string, string, string][]> = {
  op: [],
  tran: [["tstop", "Stop time", "10m"], ["tmax", "Maximum step (optional)", ""]],
  ac: [["fstart", "Start frequency", "1"], ["fstop", "Stop frequency", "10meg"], ["points", "Points per decade", "40"]],
  dc: [["source", "Source name", "V1"], ["start", "Start", "0"], ["stop", "Stop", "10"], ["step", "Step", "0.1"]],
  fourier: [["node", "Output net", ""], ["fund", "Fundamental frequency", "1k"], ["cycles", "Periods to settle", "10"]],
  sweep: [["ref", "Component", "R1"], ["param", "Parameter", "value"], ["from", "From", "1k"], ["to", "To", "10k"], ["steps", "Steps", "5"], ["inner", "Analysis (op, tran, ac)", "tran"], ["tstop", "Stop time (tran)", "10m"]],
  temperature: [["from", "From (C)", "-40"], ["to", "To (C)", "125"], ["steps", "Steps", "4"], ["inner", "Analysis (op, tran, ac)", "op"], ["tstop", "Stop time (tran)", "10m"]],
  montecarlo: [["runs", "Runs", "10"], ["tol", "Tolerance (%)", "5"], ["inner", "Analysis (op, tran, ac)", "tran"], ["tstop", "Stop time (tran)", "10m"]],
  noise: [["output", "Output, like v(out)", "v(n2)"], ["source", "Input source", "V1"], ["fstart", "Start frequency", "1"], ["fstop", "Stop frequency", "1meg"], ["points", "Points per decade", "20"]],
  transfer: [["output", "Output, like v(out)", "v(n2)"], ["source", "Input source", "V1"]],
  sensitivity: [["output", "Output, like v(out)", "v(n2)"]],
  polezero: [["inp", "Input +", "n1"], ["inn", "Input -", "0"], ["outp", "Output +", "n2"], ["outn", "Output -", "0"]],
};
const ANALYSIS_NAMES: Record<string, string> = {
  op: "DC operating point", tran: "Transient", ac: "AC sweep", dc: "DC sweep",
  fourier: "Fourier", noise: "Noise", transfer: "Transfer function", sensitivity: "Sensitivity", polezero: "Pole-zero",
  sweep: "Parameter sweep", temperature: "Temperature sweep", montecarlo: "Monte Carlo",
};

function innerRequest(v: Record<string, string>): AnalysisRequest {
  const inner = (v.inner ?? "").trim().toLowerCase();
  if (inner === "op") return { type: "op" };
  if (inner === "ac") return { type: "ac", sweep: "dec", points: 40, fstart: 1, fstop: 1e7 };
  const tstop = parseValue(v.tstop) || 1e-2;
  return { type: "tran", tstop, tstep: tstop / 1000, tmax: tstop / 200 };
}

function textWindow(title: string, rows: string[]): void {
  const win = resultWindow(title, 460, 300);
  const pre = el("pre", { textContent: rows.join("\n") });
  pre.style.overflow = "auto";
  win.body.append(pre);
}

/** Reads a required number from an analysis form, naming the field when it's wrong. */
function need(values: Record<string, string>, key: string, label: string): number {
  const value = readValue(values[key]);
  if (value === undefined) throw new Error(`"${values[key] ?? ""}" isn't a valid ${label}.`);
  return value;
}

async function runAnalysis(form: AnalysisForm): Promise<void> {
  // Whatever is running gives way to the analysis the person just asked for.
  endActivity();
  dcSolved = false;
  const token = runToken;
  const netlist = buildNetlist(doc.schematic);
  const v = form.values[form.type] ?? {};
  log = [];
  if (netlist.errors.length) {
    for (const error of netlist.errors) log.push({ text: error, kind: "error" });
    sheetTabs.show("Results");
    return;
  }
  setActivity("analysis", `${ANALYSIS_NAMES[form.type]}...`);
  try {
    const name = ANALYSIS_NAMES[form.type];
    if (form.type === "sweep") {
      grapher(name, await parameterSweep(doc.schematic, v.ref, v.param, need(v, "from", "start value"), need(v, "to", "end value"), need(v, "steps", "step count"), innerRequest(v), runSimulation));
    } else if (form.type === "montecarlo") {
      grapher(name, await monteCarlo(doc.schematic, need(v, "runs", "run count"), need(v, "tol", "tolerance"), innerRequest(v), runSimulation));
    } else if (form.type === "temperature") {
      grapher(name, await temperatureSweep(netlist.text, need(v, "from", "start temperature"), need(v, "to", "end temperature"), need(v, "steps", "step count"), innerRequest(v), runSimulation));
    } else if (form.type === "noise") {
      const result = await runSimulation(netlist.text, {
        type: "noise", output: asOutput(v.output), source: sourceOrThrow(netlist.text, v.source), sweep: "dec", points: need(v, "points", "point count"),
        fstart: need(v, "fstart", "start frequency"), fstop: need(v, "fstop", "stop frequency"),
      });
      for (const warning of result.warnings) log.push({ text: warning, kind: "warning" });
      if (result.noise) {
        log.push({ text: `Output noise ${formatSI(result.noise.onoiseRms, "V")} rms, input-referred ${formatSI(result.noise.inoiseRms, "V")} rms over the sweep.`, kind: "" });
        for (const row of result.noise.contributions.slice(0, 8)) log.push({ text: `  ${row.device}: ${formatSI(row.rms, "V")} rms`, kind: "" });
      }
      grapher(name, [{ label: "", result }]);
    } else if (form.type === "transfer") {
      const result = await runSimulation(netlist.text, { type: "transfer", output: asOutput(v.output), source: sourceOrThrow(netlist.text, v.source) });
      const t = result.transfer;
      textWindow(name, t ? [
        `Gain: ${t.gain.toPrecision(6)}`,
        `Input resistance: ${Number.isFinite(t.inputResistance) ? formatSI(t.inputResistance, "Ohm") : "infinite"}`,
        `Output resistance: ${formatSI(t.outputResistance, "Ohm")}`,
      ] : ["No result."]);
    } else if (form.type === "sensitivity") {
      const result = await runSimulation(netlist.text, { type: "sensitivity", output: asOutput(v.output) });
      textWindow(name, (result.sensitivity ?? []).map((row) => `${row.device.padEnd(12)} ${row.absolute.toPrecision(4).padStart(12)} per unit   ${Number.isNaN(row.normalized) ? "--" : row.normalized.toPrecision(4)} relative`));
    } else if (form.type === "polezero") {
      const result = await runSimulation(netlist.text, { type: "polezero", input: [v.inp, v.inn], output: [v.outp, v.outn] });
      const rows: string[] = [];
      for (const vector of result.vectors) {
        for (let i = 0; i < vector.re.length; i++) {
          const im = vector.im?.[i] ?? 0;
          rows.push(`${vector.name.padEnd(6)} ${vector.re[i].toPrecision(5)}${im ? ` ${im < 0 ? "-" : "+"} j${Math.abs(im).toPrecision(5)}` : ""}  (${formatSI(Math.hypot(vector.re[i], im) / (2 * Math.PI), "Hz")})`);
        }
      }
      textWindow(name, rows.length ? rows : ["No poles or zeros found."]);
    } else if (form.type === "fourier") {
      const fund = parseValue(v.fund);
      if (!(fund > 0)) throw new Error("Enter a fundamental frequency.");
      const tstop = (parseValue(v.cycles) || 10) / fund;
      const result = await runSimulation(netlist.text, { type: "tran", tstop, tstep: tstop / 2000, tmax: 1 / (fund * 100) });
      const vector = findVector(result, `v(${v.node})`);
      if (!vector) throw new Error(`No net named "${v.node}". See the Components tab for net names.`);
      const out = fourier(result.axis!.re, vector.re, fund);
      const lines = [
        `DC component: ${formatSI(out.dc, "V")}`,
        `Total harmonic distortion: ${out.thd.toFixed(3)} %`,
        "",
        ...out.rows.map((r) => `#${r.harmonic}  ${formatSI(r.frequency, "Hz").padEnd(11)} ${formatSI(r.magnitude, "V").padEnd(11)} ${r.phaseDeg.toFixed(1)} deg`),
      ];
      const win = resultWindow(`Fourier of v(${v.node})`, 420, 320);
      win.body.append(el("pre", { textContent: lines.join("\n") }));
    } else {
      let request: AnalysisRequest;
      if (form.type === "tran") {
        const tstop = parseValue(v.tstop);
        if (!(tstop > 0)) throw new Error("Enter a stop time.");
        request = { type: "tran", tstop, tstep: tstop / 1000, tmax: parseValue(v.tmax) || tstop / 200 };
      } else if (form.type === "ac") {
        request = { type: "ac", sweep: "dec", points: parseValue(v.points) || 40, fstart: parseValue(v.fstart), fstop: parseValue(v.fstop) };
      } else if (form.type === "dc") {
        request = { type: "dc", source: sourceOrThrow(netlist.text, v.source), start: need(v, "start", "start value"), stop: need(v, "stop", "stop value"), step: need(v, "step", "step") };
      } else {
        request = { type: "op" };
      }
      const result = await runSimulation(netlist.text, request, (f) => { runState.textContent = `${name} ${Math.round(f * 100)}%`; });
      for (const warning of result.warnings) log.push({ text: warning, kind: "warning" });
      if (result.analysis === "op") lastOpRows = result.vectors.map((vec) => [vec.name, vec.re[0], vec.unit]);
      grapher(name, [{ label: "", result }]);
    }
  } catch (error) {
    if (token === runToken) log.push({ text: friendly(error), kind: "error" });
  } finally {
    // An analysis overtaken by something else no longer owns the buttons or the status.
    if (token === runToken) {
      setActivity("idle");
      sheetTabs.show("Results");
    }
  }
}

function analysesDialog(): void {
  dialog("Analyses", (box, close) => {
    const select = el("select", {}, ...Object.entries(ANALYSIS_NAMES).map(([value, label]) => el("option", { value, textContent: label, selected: formState.type === value })));
    const fields = el("div");
    const choices = circuitChoices();
    const netOptions = el("datalist", { id: "nets-list" }, ...choices.nets.map((net) => el("option", { value: net })));
    const outputOptions = el("datalist", { id: "outputs-list" }, ...choices.nets.map((net) => el("option", { value: `v(${net})` })));
    const sourceOptions = el("datalist", { id: "sources-list" }, ...choices.sources.map((name) => el("option", { value: name })));
    const partOptions = el("datalist", { id: "parts-list" }, ...choices.passives.map((name) => el("option", { value: name })));
    box.append(netOptions, outputOptions, sourceOptions, partOptions);
    const SUGGEST: Record<string, string> = { source: "sources-list", output: "outputs-list", node: "nets-list", inp: "nets-list", inn: "nets-list", outp: "nets-list", outn: "nets-list", ref: "parts-list" };
    const render = () => {
      formState.type = select.value;
      const values = (formState.values[select.value] ??= {});
      fields.replaceChildren();
      for (const [key, label, initial] of ANALYSIS_FIELDS[select.value]) {
        const input = el("input", { value: values[key] ?? fieldDefault(key, initial, choices) });
        if (SUGGEST[key]) input.setAttribute("list", SUGGEST[key]);
        values[key] = input.value;
        input.oninput = () => { values[key] = input.value; };
        fields.append(el("label", { className: "field" }, label, input));
      }
    };
    select.onchange = render;
    box.append(el("label", { className: "field" }, "Analysis", select), fields);
    render();
    box.append(el("div", { className: "dialog-actions" },
      el("button", { textContent: "Cancel", onclick: close }),
      el("button", { className: "primary", textContent: "Run", onclick: () => { close(); void runAnalysis(formState); } }),
    ));
  });
}

// window.confirm and window.prompt are unreliable in desktop webviews, so these are in-app.
function askConfirm(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    dialog(title, (box, close) => {
      const finish = (value: boolean) => {
        if (answered) return;
        answered = true;
        close();
        resolve(value);
      };
      box.append(el("p", { textContent: message }), el("div", { className: "dialog-actions" },
        el("button", { textContent: "Cancel", onclick: () => finish(false) }),
        el("button", { className: "primary", textContent: action, onclick: () => finish(true) }),
      ));
    }, () => { if (!answered) { answered = true; resolve(false); } });
  });
}

function askText(title: string, label: string, onDone: (value: string) => void): void {
  dialog(title, (box, close) => {
    const input = el("input", { ariaLabel: label });
    const submit = () => {
      const value = input.value.trim();
      close();
      if (value) onDone(value);
    };
    input.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter") submit(); };
    box.append(el("label", { className: "field" }, label, input), el("div", { className: "dialog-actions" },
      el("button", { textContent: "Cancel", onclick: close }),
      el("button", { className: "primary", textContent: "OK", onclick: submit }),
    ));
  });
}

function modelsDialog(): void {
  dialog("SPICE models", (box, close) => {
    const area = el("textarea", { value: doc.schematic.definitions, ariaLabel: "SPICE model text", spellcheck: false });
    area.style.cssText = "width:100%;height:240px;font:12px ui-monospace,Menlo,Consolas,monospace";
    box.append(
      el("p", { className: "muted", textContent: "Paste .model or .subckt text from a manufacturer. Use subcircuits through a SPICE model block, by name." }),
      area,
      el("div", { className: "dialog-actions" },
        el("button", { textContent: "Cancel", onclick: close }),
        el("button", { className: "primary", textContent: "Save", onclick: () => {
          doc.checkpoint();
          doc.schematic.definitions = area.value;
          doc.notify();
          close();
        } }),
      ),
    );
  });
}

async function confirmDiscard(): Promise<boolean> {
  return !doc.dirty || askConfirm("Unsaved changes", "Discard the changes to this circuit?", "Discard");
}

function stem(): string {
  return (doc.schematic.name || "Untitled").replace(/[\\/:*?"<>|]/g, "_");
}

// Files
async function newFile(): Promise<void> {
  if (!(await confirmDiscard())) return;
  doc.replace({ name: "Untitled", components: [], wires: [], labels: [], texts: [], definitions: "" });
  resetAfterLoad();
}

async function openExample(example: Example): Promise<void> {
  if (!(await confirmDiscard())) return;
  doc.replace(buildExample(example));
  resetAfterLoad();
}

function resetAfterLoad(): void {
  endActivity();
  dcSolved = false;
  issues = [];
  log = [];
  lastOpRows = [];
  lastRun = undefined;
  importedAnalyses = [];
  cancelPendingSettings();
  for (const release of buttonReleases) clearTimeout(release);
  buttonReleases.clear();
  heldButtons.clear();
  assistant.stop();
  showLimitsBanner();
  savedPath = undefined;
  runState.textContent = "";
  canvas.probes.clear();
  canvas.displays.clear();
  for (const view of views.values()) view.element.remove();
  views.clear();
  scopeSettings.clear();
  for (const win of resultWindows.keys()) win.remove();
  resultWindows.clear();
  lastSignature = buildNetlist(doc.schematic).text;
  clearAutosave();
  canvas.select([]);
  canvas.fit();
  sheetTabs.refresh();
}

const OPENABLE = [FILE_EXTENSION, "ms14", "ms13", "ms12", "ms11", "ms10", "cir", "sp"];

async function openCircuit(): Promise<void> {
  if (!(await confirmDiscard())) return;
  try {
    const file = await openFile(OPENABLE);
    if (file) await loadBytes(file.name, file.bytes, file.path);
  } catch (error) {
    writeLog(`Could not open the file: ${friendly(error)}`, "error");
  }
}

/** Shows a plain SPICE file as one block, so all the analyses work on it. */
function netlistSchematic(name: string, text: string): Schematic {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // A SPICE deck's first line is always its title, and .end would cut off what follows.
  const body = lines.slice(1).filter((line) => !/^\s*\.end\s*$/i.test(line)).join("\n");
  return {
    name, wires: [], labels: [], texts: [{ id: newId("t"), x: -70, y: -40, text: lines[0]?.slice(0, 120) ?? "" }], definitions: "",
    components: [{
      id: newId("c"), refDes: "NETLIST", kind: "imported", x: 0, y: 0, rotation: 0, mirrored: false, params: {}, pins: [],
      spice: body, graphics: [{ kind: "rect", x: -70, y: -25, w: 140, h: 50, filled: false }, { kind: "text", x: 0, y: 0, text: "SPICE netlist", size: 11 }],
    }],
  };
}

async function loadBytes(name: string, bytes: Uint8Array, path?: string): Promise<void> {
  const lower = name.toLowerCase();
  const stem = name.replace(/\.[^.]+$/, "");
  try {
    // Everything is parsed and checked first, so a bad file can't touch the open circuit.
    if (lower.endsWith(`.${FILE_EXTENSION}`)) {
      const file = parseCircuit(new TextDecoder().decode(bytes));
      doc.replace(file.schematic);
      resetAfterLoad();
      issues = file.issues;
      showLimitsBanner();
      importedAnalyses = file.analyses;
      savedPath = path;
      sheetTabs.refresh();
      return;
    }
    if (lower.endsWith(".cir") || lower.endsWith(".sp")) {
      doc.replace(netlistSchematic(stem, new TextDecoder().decode(bytes)));
      resetAfterLoad();
      statusText.textContent = `Opened ${name}. Choose Analyses to simulate it.`;
      return;
    }
    statusText.textContent = `Importing ${name}...`;
    const { importMs14 } = await import("../importer/index");
    const started = performance.now();
    const result = importMs14(bytes);
    result.schematic.name = stem;
    doc.replace(result.schematic);
    resetAfterLoad();
    issues = result.issues;
    showLimitsBanner();
    importedAnalyses = result.analyses;
    statusText.textContent = `Imported ${name} in ${Math.round(performance.now() - started)} ms.`;
    const serious = issues.filter((i) => i.severity !== "info").length;
    sheetTabs.show(serious ? "Issues" : "Components");
  } catch (error) {
    statusText.textContent = "";
    writeLog(`Could not open ${name}: ${friendly(error)}`, "error");
  }
}

let savedPath: string | undefined;

async function saveCircuit(saveAs = false): Promise<void> {
  try {
    const contents = serializeCircuit({ schematic: doc.schematic, analyses: importedAnalyses, issues });
    const used = await saveFile(`${stem()}.${FILE_EXTENSION}`, FILE_EXTENSION, contents, saveAs ? undefined : savedPath);
    if (!used) return;
    savedPath = used.includes("/") || used.includes("\\") ? used : undefined;
    doc.dirty = false;
    clearAutosave();
    statusText.textContent = `Saved ${used}.`;
  } catch (error) {
    writeLog(`Could not save: ${friendly(error)}. Your circuit is still open.`, "error");
  }
}

async function exportText(name: string, extension: string, contents: string): Promise<void> {
  try {
    const used = await saveFile(name, extension, contents);
    if (used) statusText.textContent = `Exported ${used}.`;
  } catch (error) {
    writeLog(`Could not export: ${friendly(error)}`, "error");
  }
}

// Autosave protects against a crash or a forced quit. It's a recovery copy, not a save.
const AUTOSAVE_KEY = "ohmlet.autosave";
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleAutosave(): void {
  if (!doc.dirty || autosaveTimer) return;
  autosaveTimer = setTimeout(writeAutosave, 2000);
}

function writeAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = undefined;
  if (doc.dirty) writeStore(AUTOSAVE_KEY, serializeCircuit({ schematic: doc.schematic, analyses: importedAnalyses, issues }));
}

// A page being hidden is the last reliable moment before a window closes or an app is killed.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") writeAutosave();
});
window.addEventListener("pagehide", writeAutosave);

function clearAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = undefined;
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* Storage can be blocked. */ }
}

// A copy awaiting a decision lives apart from the autosave, so that new edits and opened files
// can't overwrite it. It stays until the person chooses, however many times they dismiss this.
const RECOVERY_KEY = "ohmlet.recovery";
const removeStore = (key: string) => {
  try { localStorage.removeItem(key); } catch { /* Storage can be blocked. */ }
};

function recoveryQueue(): string[] {
  try {
    const queue: unknown = JSON.parse(readStore(RECOVERY_KEY) || "[]");
    return Array.isArray(queue) ? queue.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveRecoveryQueue(queue: string[]): boolean {
  const text = JSON.stringify(queue);
  writeStore(RECOVERY_KEY, text);
  return readStore(RECOVERY_KEY) === text;
}

async function offerRecovery(): Promise<void> {
  // Every session's unsaved work waits its turn, so one crash can't cost another's.
  const newest = readStore(AUTOSAVE_KEY);
  if (newest) {
    const queue = recoveryQueue();
    if (!queue.includes(newest)) queue.push(newest);
    // The autosave only goes once its copy is safely stored.
    if (saveRecoveryQueue(queue.slice(-5))) removeStore(AUTOSAVE_KEY);
  }
  const queue = recoveryQueue();
  const text = queue[queue.length - 1];
  if (!text) return;
  const dropOffered = () => saveRecoveryQueue(recoveryQueue().filter((item) => item !== text));
  try {
    const file = parseCircuit(text);
    const choice = await new Promise<"recover" | "discard" | "later">((resolve) => {
      let answered = false;
      const answer = (value: "recover" | "discard" | "later") => {
        if (!answered) resolve(value);
        answered = true;
      };
      dialog("Recover your circuit?", (box, close) => {
        const pick = (value: "recover" | "discard") => { answer(value); close(); };
        box.append(el("p", { textContent: `"${file.schematic.name}" wasn't saved when Ohmlet last closed.` }), el("div", { className: "dialog-actions" },
          el("button", { textContent: "Discard it", onclick: () => pick("discard") }),
          el("button", { className: "primary", textContent: "Recover", onclick: () => pick("recover"), autofocus: true }),
        ));
        // Dismissing without choosing keeps the copy, since it may be someone's only one.
      }, () => answer("later"));
    });
    if (choice === "discard") {
      dropOffered();
      // Offer any older copy next, rather than leaving it until another launch.
      void offerRecovery();
    }
    if (choice !== "recover") return;
    doc.replace(file.schematic);
    resetAfterLoad();
    issues = file.issues;
    importedAnalyses = file.analyses;
    doc.dirty = true;
    // From here it's the open circuit, protected by autosave like any other, in case this
    // session fails as well.
    writeStore(AUTOSAVE_KEY, text);
    dropOffered();
    sheetTabs.refresh();
  } catch {
    // Unreadable, so it can't be offered, and it would block other copies from being offered.
    dropOffered();
  }
}

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (await confirmDiscard()) await loadBytes(file.name, bytes);
});

// Assistant panel
function settingsDialog(afterSave?: () => void): void {
  dialog("Assistant settings", (box, close) => {
    const key = el("input", { type: "password", value: readStore(KEY_STORAGE), placeholder: "sk-ant-...", autocomplete: "off", ariaLabel: "Anthropic API key" });
    box.append(
      el("label", { className: "field" }, "Anthropic API key", key),
      el("p", { className: "muted", textContent: "Stored unencrypted in this app's local storage on this computer. Your circuit and messages go to Anthropic only when you use the assistant." }),
      el("div", { className: "dialog-actions" },
        el("button", { textContent: "Cancel", onclick: close }),
        el("button", { className: "primary", textContent: "Save", onclick: () => { writeStore(KEY_STORAGE, key.value.trim()); close(); afterSave?.(); } }),
      ),
    );
  });
}

const assistant = new Assistant(doc, runSimulation, () => readStore(KEY_STORAGE), stopSimulation);
const chatLog = el("div", { className: "chat-log", role: "log", ariaLive: "polite" });
// One panel for the app's lifetime: switching tabs must not orphan a run or lose its Stop button.
let chat: HTMLElement | undefined;
function chatPanel(): HTMLElement {
  if (chat) return chat;
  const input = el("textarea", { placeholder: "Describe a circuit to build, or ask about this one", ariaLabel: "Message the assistant" });
  const send = el("button", { className: "primary", textContent: "Send" });
  const stop = el("button", { textContent: "Stop", disabled: true });
  const submit = async () => {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    if (!readStore(KEY_STORAGE)) {
      settingsDialog();
      return;
    }
    input.value = "";
    chatLog.append(el("div", { className: "msg user", textContent: text }));
    let bubble: HTMLElement | undefined;
    send.disabled = true;
    stop.disabled = false;
    try {
      await assistant.send(text, {
        onText(delta) {
          if (!bubble) {
            if (!delta.trim()) return;
            bubble = el("div", { className: "msg assistant" });
            chatLog.append(bubble);
          }
          bubble.textContent += delta;
          chatLog.scrollTop = chatLog.scrollHeight;
        },
        onTool(summary) {
          bubble = undefined;
          chatLog.append(el("div", { className: "msg tool", textContent: summary }));
          chatLog.scrollTop = chatLog.scrollHeight;
        },
      });
    } catch (error) {
      chatLog.append(el("div", { className: "msg error", textContent: friendly(error) }));
    } finally {
      send.disabled = false;
      stop.disabled = true;
      canvas.fit();
    }
  };
  send.onclick = () => void submit();
  stop.onclick = () => assistant.stop();
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };
  chat = el("div", { className: "chat" }, chatLog,
    el("div", { className: "chat-input" }, input,
      el("div", { className: "chat-actions" },
        el("button", { className: "quiet", textContent: "Settings", onclick: () => settingsDialog() }),
        el("span", {},
          el("button", { className: "quiet", textContent: "New chat", onclick: () => { assistant.reset(); chatLog.replaceChildren(); } }),
          " ", stop, " ", send),
      )));
  return chat;
}

// Menus and toolbar
type MenuItem = [label: string, action: () => void, shortcut?: string];
const mod = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
const MENUS: Record<string, MenuItem[]> = {
  File: [
    ["New", () => void newFile(), `${mod}+N`],
    ["Open...", () => void openCircuit(), `${mod}+O`],
    ["Save", () => void saveCircuit(), `${mod}+S`],
    ["Save as...", () => void saveCircuit(true), `${mod}+Shift+S`],
    ["Export schematic as SVG", () => void exportText(`${stem()}.svg`, "svg", schematicToSvg(doc.schematic))],
    ["Export SPICE netlist", () => void exportText(`${stem()}.cir`, "cir", buildNetlist(doc.schematic).text)],
  ],
  Examples: EXAMPLES.map((example): MenuItem => [example.name, () => void openExample(example)]),
  Edit: [
    ["Undo", () => undoDocument(), `${mod}+Z`],
    ["Redo", () => undoDocument(true), `${mod}+Shift+Z`],
    ["Copy", () => canvas.copySelected(), `${mod}+C`],
    ["Paste", () => canvas.paste(), `${mod}+V`],
    ["Select all", () => canvas.selectAll(), `${mod}+A`],
    ["Name a net...", () => askText("Name a net", "Net name", (value) => canvas.beginAnnotation("label", value)), "L"],
    ["Add a note...", () => askText("Add a note", "Note", (value) => canvas.beginAnnotation("text", value)), "T"],
    ["SPICE models...", modelsDialog],
    ["Rotate", () => canvas.rotateSelected(), "R"],
    ["Mirror", () => canvas.mirrorSelected(), "M"],
    ["Delete", () => canvas.deleteSelected(), "Del"],
  ],
  View: [
    ["Zoom in", () => canvas.zoomBy(1.25), "+"],
    ["Zoom out", () => canvas.zoomBy(0.8), "-"],
    ["Fit to window", () => canvas.fit(), "F"],
    ["Toggle voltages on wires", () => { showVoltages = !showVoltages; if (!showVoltages) canvas.probes.clear(); canvas.invalidate(); }],
  ],
  Simulate: [
    ["Run", () => void simulateRun(), "F5"],
    ["Stop", () => stopButton.click()],
    ["Analyses...", analysesDialog, "F6"],
    ["Analyses from imported file", () => {
      if (!importedAnalyses.length) { writeLog("The open file has no stored analyses to run.", "warning"); return; }
      void (async () => {
        endActivity();
        dcSolved = false;
        const token = runToken;
        const netlist = buildNetlist(doc.schematic);
        if (netlist.errors.length) { writeLog(netlist.errors.join(" "), "error"); return; }
        setActivity("analysis", "Running stored analyses...");
        for (const request of importedAnalyses) {
          try {
            const result = await runSimulation(netlist.text, request);
            if (token !== runToken) return;
            grapher(ANALYSIS_NAMES[request.type], [{ label: "", result }]);
          } catch (error) {
            // Stop means stop, not carry on with the next one.
            if (token !== runToken) return;
            writeLog(`${ANALYSIS_NAMES[request.type]}: ${friendly(error)}`, "error");
          }
        }
        if (token === runToken) setActivity("idle");
      })();
    }],
  ],
  Help: [["Getting started", () => dialog("Getting started", (box, close) => {
    const list = el("ul");
    list.style.paddingLeft = "18px";
    for (const tip of [
      "Place a part: click it on the left, then click the sheet. Hold Shift to place several.",
      "Wire it: click a pin, click to add corners, then click another pin or wire. Esc cancels.",
      "Every circuit needs a Ground part.",
      "Values: 10k, 4.7u, 1M. Capital M is mega and small m is milli.",
      "Run with the Run button or F5. A circuit with anything that changes over time keeps running until you press Stop, or until the Stop at time. A purely DC circuit solves once, and solves again when you change a setting.",
      "Change a value or press a part's key while it runs, and the circuit carries on from where it is. Auto speed runs fast with a scope open, and in real time otherwise.",
      "Name a net with L. Wires with the same name are connected.",
      "Use your own device models under Edit, SPICE models, then place a SPICE model block.",
      "Rotate with R, mirror with M, nudge with the arrow keys, and pan with a right-drag or two fingers.",
      "The Assistant tab can build and test circuits for you. It needs an Anthropic API key.",
    ]) list.append(el("li", { textContent: tip }));
    box.append(list, el("div", { className: "dialog-actions" }, el("button", { className: "primary", textContent: "Close", onclick: close })));
  })], ["What Ohmlet doesn't do", () => dialog("What Ohmlet doesn't do", (box, close) => {
    const list = el("ul");
    list.style.paddingLeft = "18px";
    for (const limit of [
      "Microcontrollers, LCDs and serial ports aren't simulated. Circuits with them open and run, but those parts do nothing, and a notice says so.",
      "LabVIEW co-simulation and instruments aren't supported.",
      "There's no component database. The parts list is generic, and you can add real parts by pasting their SPICE models.",
      "Instruments are limited to oscilloscope, multimeter, wattmeter, Bode plotter, logic analyzer, function generator and clock.",
      "Distortion, worst-case and RF analyses aren't available.",
      "Sheets from files are flattened, so there's no hierarchical or multi-page editing.",
      "It reads .ms14 files but can't save them. Files from older versions may open, but haven't been tested.",
      "There's no PCB layout or transfer.",
      "Device models and logic levels are approximations, so results may differ from other simulators.",
    ]) list.append(el("li", { textContent: limit }));
    box.append(list, el("div", { className: "dialog-actions" }, el("button", { className: "primary", textContent: "Close", onclick: close })));
  })], ["About Ohmlet", () => dialog("Ohmlet", (box, close) => {
    box.append(
      el("p", { textContent: "A lightweight circuit simulator with an AI assistant." }),
      el("p", { className: "muted", textContent: "Ohmlet is an independent project and is not affiliated with or endorsed by National Instruments or Emerson." }),
      el("div", { className: "dialog-actions" }, el("button", { className: "primary", textContent: "Close", onclick: close })),
    );
  })]],
};

let openMenu: HTMLElement | undefined;
function closeAnyMenu(): void {
  openMenu?.remove();
  openMenu = undefined;
  for (const opener of menubar.querySelectorAll("[aria-haspopup]")) opener.setAttribute("aria-expanded", "false");
}

for (const [title, items] of Object.entries(MENUS)) {
  const wrap = el("div", { className: "menu" });
  const button = el("button", { className: "quiet", textContent: title });
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.onclick = (e) => {
    e.stopPropagation();
    const had = wrap.querySelector(".menu-items");
    closeAnyMenu();
    if (had) return;
    const list = el("div", { className: "menu-items", role: "menu" });
    for (const [label, action, shortcut] of items) {
      list.append(el("button", { role: "menuitem", onclick: () => { closeAnyMenu(); action(); } }, label, el("kbd", { textContent: shortcut ?? "" })));
    }
    wrap.append(list);
    openMenu = list;
    button.setAttribute("aria-expanded", "true");
    // Keyboard users move straight into the menu. A mouse click has detail above 0.
    if (e.detail === 0) list.querySelector<HTMLElement>("button")?.focus();
  };
  wrap.append(button);
  menubar.append(wrap);
}
window.addEventListener("pointerdown", (e) => {
  if (openMenu && !(e.target as HTMLElement).closest(".menu")) closeAnyMenu();
});

const toolButton = (label: string, title: string, action: () => void) => el("button", { textContent: label, title, onclick: action });
toolbar.append(
  toolButton("Open", "Open a circuit, including .ms14 files", () => void openCircuit()),
  toolButton("Save", "Save as an Ohmlet circuit", () => void saveCircuit()),
  el("span", { className: "sep" }),
  toolButton("Undo", "Undo", () => undoDocument()),
  toolButton("Redo", "Redo", () => undoDocument(true)),
  toolButton("Rotate", "Rotate selection (R)", () => canvas.rotateSelected()),
  toolButton("Fit", "Fit to window (F)", () => canvas.fit()),
  el("span", { className: "sep" }),
  runButton, stopButton,
  el("label", { className: "stop-at-label" }, "Stop at ", stopAtInput),
  speedSelect,
  toolButton("Analyses", "Choose an analysis (F6)", analysesDialog),
  runState,
);

function undoDocument(redo = false): void {
  // A focused field would keep showing the value from before the undo.
  if ((document.activeElement as HTMLElement | null)?.closest(".side")) (document.activeElement as HTMLElement).blur();
  if (redo) doc.redo(); else doc.undo();
}

// On a Mac the standard Edit menu turns Cmd+C and friends into these events.
let clipboardHandledAt = 0;
const sheetClipboard = (action: () => void) => (e: Event) => {
  if ((e.target as HTMLElement).matches?.("input, textarea, select") || document.querySelector(".overlay")) return;
  e.preventDefault();
  clipboardHandledAt = e.timeStamp;
  action();
};
document.addEventListener("copy", sheetClipboard(() => canvas.copySelected()));
document.addEventListener("cut", sheetClipboard(() => { canvas.copySelected(); canvas.deleteSelected(); }));
document.addEventListener("paste", sheetClipboard(() => canvas.paste()));

// Momentary buttons stay pressed only while their key is down.
const heldButtons = new Map<string, string>();
// A window losing focus never sees the key come up, so let go then too.
window.addEventListener("blur", () => {
  if (!heldButtons.size) return;
  const letGo = [...heldButtons.keys()];
  heldButtons.clear();
  releaseButtons(letGo);
});
window.addEventListener("keyup", (e) => {
  if (!heldButtons.size) return;
  const released = e.key === " " ? "space" : e.key.toLowerCase();
  const letGo = [...heldButtons].filter(([, key]) => key === released).map(([id]) => id);
  if (!letGo.length) return;
  for (const id of letGo) heldButtons.delete(id);
  releaseButtons(letGo);
});

window.addEventListener("keydown", (e) => {
  // A dialog owns the keyboard, or letters typed at it would edit the circuit behind it.
  if (document.querySelector(".overlay")) return;
  // So does an open menu, wherever focus happens to be.
  if (openMenu) {
    const entries = [...openMenu.querySelectorAll<HTMLElement>("button")];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      entries[at < 0 ? (step > 0 ? 0 : entries.length - 1) : (at + step + entries.length) % entries.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      const opener = openMenu.parentElement?.querySelector<HTMLElement>("[aria-haspopup]");
      closeAnyMenu();
      opener?.focus();
    } else if (e.key === "Tab") {
      closeAnyMenu();
    } else if (e.key !== "Enter" && e.key !== " ") {
      e.preventDefault();
    }
    return;
  }
  const target = e.target as HTMLElement;
  const typing = target.matches?.("input, textarea, select") ?? false;
  const command = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (command && key === "o") { e.preventDefault(); void openCircuit(); return; }
  if (command && key === "s") { e.preventDefault(); void saveCircuit(e.shiftKey); return; }
  if (e.key === "F5") { e.preventDefault(); void simulateRun(); return; }
  if (e.key === "F6") { e.preventDefault(); analysesDialog(); return; }
  if (typing) return;
  // Keys shown on parts control them while the circuit runs. When stopped, they set a part up
  // only if the key isn't already an editing shortcut. Space still presses a focused button.
  const onControl = target.matches?.("button, a") ?? false;
  if (!command && !(onControl && (key === " " || key === "enter")) && (live || !"rmltf".includes(key))) {
    const pressed = e.key === " " ? "space" : key;
    const controls = doc.schematic.components.filter((c) => c.interactive?.key?.toLowerCase() === pressed);
    if (controls.length) {
      e.preventDefault();
      // Holding a key shouldn't toggle a switch over and over, though it can keep turning a knob.
      const variables = controls.filter((c) => c.interactive?.kind === "variable");
      const switches = e.repeat ? [] : controls.filter((c) => c.interactive?.kind === "switch");
      if (!variables.length && !switches.length) return;
      changeSetting(() => {
        for (const comp of switches) Object.assign(comp, applyInteractive(comp, nextPosition(comp)));
        for (const comp of variables) Object.assign(comp, applyInteractive(comp, stepVariable(comp, e.shiftKey)));
      });
      for (const comp of switches) if (comp.interactive?.kind === "switch" && comp.interactive.momentary) heldButtons.set(comp.id, pressed);
      return;
    }
  }
  // The clipboard event and the keydown can both fire for one press.
  const handled = Math.abs(e.timeStamp - clipboardHandledAt) < 50;
  const arrow = { arrowleft: [-10, 0], arrowright: [10, 0], arrowup: [0, -10], arrowdown: [0, 10] }[key];
  if (command && key === "n") { e.preventDefault(); void newFile(); }
  else if (command && key === "z") { e.preventDefault(); undoDocument(e.shiftKey); }
  else if (command && key === "y") { e.preventDefault(); undoDocument(true); }
  else if (command && key === "c") { if (!handled) canvas.copySelected(); }
  else if (command && key === "x") { if (!handled) { canvas.copySelected(); canvas.deleteSelected(); } }
  else if (command && key === "v") { e.preventDefault(); if (!handled) canvas.paste(); }
  else if (command && key === "a") { e.preventDefault(); canvas.selectAll(); }
  else if (command) return;
  else if (arrow) { e.preventDefault(); canvas.nudgeSelected(arrow[0], arrow[1]); }
  else if (key === "l") askText("Name a net", "Net name", (value) => canvas.beginAnnotation("label", value));
  else if (key === "t") askText("Add a note", "Note", (value) => canvas.beginAnnotation("text", value));
  else if (key === "r") canvas.rotateSelected();
  else if (key === "m") canvas.mirrorSelected();
  else if (key === "f") canvas.fit();
  else if (key === "delete" || key === "backspace") { e.preventDefault(); canvas.deleteSelected(); }
  else if (key === "escape") canvas.cancelTool();
  else if (key === "+" || key === "=") canvas.zoomBy(1.25);
  else if (key === "-") canvas.zoomBy(0.8);
});

doc.notify();
canvas.fit();
void offerRecovery();
void guardWindowClose(() => doc.dirty, async () => {
  const discard = await askConfirm("Unsaved changes", "Close Ohmlet and discard the changes to this circuit?", "Discard and close");
  if (discard) {
    // They chose to lose it, so the next launch shouldn't offer it back.
    doc.dirty = false;
    clearAutosave();
  }
  return discard;
});

// In the desktop app the menus move to the Mac menu bar. Items that the Edit menu's standard
// entries already cover are left out so they stay usable in text fields.
const STANDARD_EDIT = new Set(["Undo", "Redo", "Copy", "Paste", "Select all"]);
const accelerator = (shortcut: string | undefined) => (shortcut && /(Cmd|Ctrl)\+/.test(shortcut) ? shortcut.replace(/^(Cmd|Ctrl)/, "CmdOrCtrl") : undefined);
void installNativeMenu("Ohmlet", Object.fromEntries(Object.entries(MENUS).map(([title, items]) => [
  title,
  items
    .filter(([label]) => !(title === "Edit" && STANDARD_EDIT.has(label)))
    .map(([label, action, shortcut]) => ({ label, action, accelerator: accelerator(shortcut) })),
]))).then((native) => {
  if (native) menubar.hidden = true;
}).catch((error) => {
  // The in-window menus still work, so this only costs the Mac menu bar.
  console.error("Could not install the native menu", error);
});

// Lets browser-driven tests find exact on-screen positions. Removed from production builds.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ohmlet = { doc, canvas, pinWorld, buildNetlist };
}
