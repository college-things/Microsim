// A debugger window for an 8051 running in a live simulation: source listing with breakpoints, registers,
// ports, and pause, continue and single-step. The commands travel to the simulation worker through `send`.
import type { SchComponent } from "../core/schematic";
import type { McuState } from "../core/sim";
import { assemblePic } from "../engine/asmpic";
import type { PicVariant } from "../engine/pic16";
import { isMcuPic } from "../importer/mcu";
import { assemble51 } from "../engine/asm51";
import { floatingWindow } from "./instruments";

export interface DebugCommand { watch?: boolean; breakpoints?: number[]; step?: boolean; resume?: boolean; pause?: boolean }

export interface DebuggerView {
  readonly compId: string;
  /** New state from the running simulation; `halted` is true when this device stopped the run. */
  update(state: McuState | undefined, halted: boolean): void;
  /** No run, or a run without this device: the controls wait for one. */
  idle(message: string): void;
  breakpoints(): number[];
  element: HTMLElement;
}

const hex = (value: number, digits: number) => value.toString(16).toUpperCase().padStart(digits, "0");

export function createDebugger(host: HTMLElement, comp: SchComponent, send: (command: DebugCommand) => boolean, onClose: () => void): DebuggerView {
  const win = floatingWindow(host, `Debugger ${comp.refDes}`, 560, 460, onClose);
  win.body.classList.add("debugger");
  const bar = document.createElement("div");
  bar.className = "debugger-bar";
  const status = document.createElement("span");
  status.className = "muted";
  const button = (label: string, title: string, action: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.onclick = action;
    bar.append(b);
    return b;
  };
  const pause = button("Pause", "Stop after the current instruction", () => send({ pause: true }));
  const resume = button("Continue", "Run until the next breakpoint", () => send({ resume: true }));
  const step = button("Step", "Execute one instruction", () => send({ step: true }));
  bar.append(status);

  const registers = document.createElement("pre");
  registers.className = "debugger-registers";

  // The listing comes from the source saved with the part; a part loaded from HEX takes addresses.
  const listing = document.createElement("div");
  listing.className = "debugger-listing";
  const set = new Set<number>();
  const lineOf = new Map<number, HTMLElement>();
  let source: { lines: string[]; listing: { address: number; line: number }[] } | undefined;
  if (comp.params.asm?.trim()) {
    try {
      const result = isMcuPic(comp)?assemblePic(comp.params.asm,(comp.params.variant??comp.kind) as PicVariant):assemble51(comp.params.asm);
      source = { lines: comp.params.asm.split(/\r?\n/), listing: result.listing };
    } catch (error) {
      listing.textContent = `The saved source doesn't assemble: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const addressRow = document.createElement("label");
  addressRow.className = "field";
  const addressInput = document.createElement("input");
  addressInput.placeholder = "e.g. 0013 0020";
  addressRow.append("Breakpoints (hex addresses)", addressInput);
  if (source) {
    const byLine = new Map(source.listing.map((entry) => [entry.line, entry.address]));
    source.lines.forEach((text, i) => {
      const row = document.createElement("div");
      row.className = "debugger-line";
      const address = byLine.get(i + 1);
      row.textContent = `${address === undefined ? "    " : hex(address, 4)}  ${text}`;
      if (address !== undefined) {
        lineOf.set(address, row);
        row.classList.add("code");
        row.title = "Click to set or clear a breakpoint";
        row.onclick = () => {
          if (set.has(address)) set.delete(address); else set.add(address);
          row.classList.toggle("breakpoint", set.has(address));
          send({ breakpoints: [...set] });
        };
      }
      listing.append(row);
    });
  } else if (!listing.textContent) {
    listing.textContent = "No source is saved with this part, so breakpoints are set by address.";
    addressInput.onchange = () => {
      set.clear();
      for (const token of addressInput.value.split(/[\s,;]+/).filter(Boolean)) {
        const value = parseInt(token.replace(/h$/i, ""), 16);
        if (Number.isFinite(value) && value >= 0 && value <= 0xffff) set.add(value);
      }
      send({ breakpoints: [...set] });
    };
  }
  win.body.append(bar, registers, ...(source ? [] : [addressRow]), listing);

  let current: HTMLElement | undefined;
  const show = (enabled: boolean) => { for (const b of [pause, resume, step]) b.disabled = !enabled; };
  show(false);
  return {
    compId: comp.id,
    element: win.root,
    breakpoints: () => [...set],
    idle(message) {
      show(false);
      status.textContent = message;
      registers.textContent = "";
      current?.classList.remove("current");
      current = undefined;
    },
    update(state, halted) {
      if (!state) return;
      show(true);
      pause.disabled = halted;
      resume.disabled = !halted;
      step.disabled = !halted;
      status.textContent = halted ? `Paused at ${hex(state.pc, 4)}H` : "Running";
      const flags = ["CY", "AC", "F0", "RS1", "RS0", "OV", "", "P"].map((name, i) => (name && (state.psw >> (7 - i)) & 1 ? name : "")).filter(Boolean).join(" ") || "-";
      registers.textContent = [
        `PC ${hex(state.pc, 4)}  A ${hex(state.a, 2)}  B ${hex(state.b, 2)}  SP ${hex(state.sp, 2)}  DPTR ${hex(state.dptr, 4)}  PSW ${hex(state.psw, 2)} (${flags})`,
        state.registers.map((r, i) => `R${i} ${hex(r, 2)}`).join("  "),
        `${state.ports.map((p, i) => `P${i} ${hex(p, 2)}`).join("  ")}   cycles ${state.cycles}   t = ${(state.time * 1e3).toPrecision(5)} ms`,
      ].join("\n");
      if(state.kind==='pic16')registers.textContent=[
        `PC ${hex(state.pc,4)}  W ${hex(state.w!,2)}  STATUS ${hex(state.status!,2)}  FSR ${hex(state.fsr!,2)}  PCLATH ${hex(state.pclath!,2)}  bank ${state.bank}  SP ${state.sp}`,
        state.ports.map((v,p)=>`PORT${String.fromCharCode(65+p)} ${hex(v,2)} TRIS ${hex(state.tris![p],2)}`).join('  '),
        `cycles ${state.cycles}   t = ${(state.time*1e3).toPrecision(5)} ms`,
      ].join('\n');
      current?.classList.remove("current");
      current = halted ? lineOf.get(state.pc) : undefined;
      if (current) {
        current.classList.add("current");
        current.scrollIntoView({ block: "nearest" });
      }
    },
  };
}
