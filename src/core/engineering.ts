import { buildNetlist } from "./netlist";
import type { Point, Schematic } from "./schematic";
import { validateFlowProgram, type FlowProgram } from './dataflow';

export interface Pad extends Point { pin: string; net: string; diameter?: number; drill?: number }
export interface Footprint extends Point { component: string; ref: string; rotation: number; pads: Pad[] }
export interface Track { net: string; layer: "F.Cu" | "B.Cu"; width: number; points: Point[] }
export interface Via extends Point { net: string; diameter: number; drill: number }
export interface Board { width: number; height: number; clearance: number; footprints: Footprint[]; tracks: Track[]; vias?: Via[] }
export interface DesignWorkspace {
  board?: Board;
  vhdl?: { source: string; top: string; constraints: string };
  firmware?: { source: string; hex?: string };
  labview?: { url: string; inputs: Record<string, number>; outputs: Record<string, string>;mode?:'local'|'http'|'vi';viPath?:string;bits?:32|64;timeControl?:string;program?:FlowProgram };
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 100000;
const point = (v: unknown): v is Point => !!v && typeof v === "object" && finite((v as Point).x) && finite((v as Point).y);
export function validateWorkspace(value: unknown): void {
  const bad = () => { throw new Error("Invalid engineering workspace."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const w = value as DesignWorkspace;
  if (w.board) {
    const b = w.board;
    if (![b.width, b.height, b.clearance].every((n) => finite(n) && n > 0) || !Array.isArray(b.footprints) || !Array.isArray(b.tracks)) bad();
    for (const f of b.footprints) {
      if (!point(f) || typeof f.component !== "string" || typeof f.ref !== "string" || !finite(f.rotation) || !Array.isArray(f.pads)) bad();
      for (const p of f.pads) if (!point(p) || typeof p.pin !== "string" || typeof p.net !== "string" || !validDrill(p.diameter??1.6,p.drill??0.8)) bad();
    }
    for (const t of b.tracks) if (typeof t.net !== "string" || !["F.Cu", "B.Cu"].includes(t.layer) || !finite(t.width) || t.width <= 0 || !Array.isArray(t.points) || t.points.length < 2 || !t.points.every(point)) bad();
    if(b.vias!==undefined){if(!Array.isArray(b.vias))bad();for(const v of b.vias)if(!point(v)||typeof v.net!=='string'||!validDrill(v.diameter,v.drill))bad();}
  }
  if (w.vhdl && (typeof w.vhdl.source !== "string" || typeof w.vhdl.top !== "string" || typeof w.vhdl.constraints !== "string")) bad();
  if (w.firmware && (typeof w.firmware.source !== "string" || (w.firmware.hex !== undefined && typeof w.firmware.hex !== "string"))) bad();
  if (w.labview) {
    if (typeof w.labview.url !== "string" || !w.labview.inputs || typeof w.labview.inputs !== "object" || Array.isArray(w.labview.inputs) || !Object.values(w.labview.inputs).every(finite) || !w.labview.outputs || typeof w.labview.outputs !== "object" || Array.isArray(w.labview.outputs) || !Object.values(w.labview.outputs).every((s) => typeof s === "string")) bad();
    if(w.labview.mode!==undefined&&!['local','http','vi'].includes(w.labview.mode)||w.labview.viPath!==undefined&&typeof w.labview.viPath!=='string'||w.labview.bits!==undefined&&![32,64].includes(w.labview.bits)||w.labview.timeControl!==undefined&&typeof w.labview.timeControl!=='string')bad();
    if(w.labview.program!==undefined)validateFlowProgram(w.labview.program);
    if(w.labview.mode==='local'&&!w.labview.program)bad();
  }
}
const validDrill=(diameter:number,drill:number)=>finite(diameter)&&finite(drill)&&drill>0&&diameter>drill;

/** Starting through-hole footprints; the user must set dimensions to the real package. */
export function boardFromSchematic(s: Schematic, previous?: Board): Board {
  const nets = buildNetlist(s).pinNets;
  return {
    width: previous?.width ?? 100, height: previous?.height ?? 80, clearance: previous?.clearance ?? 0.25,
    footprints: s.components.filter((c) => c.pins.length && !c.instrument && c.kind !== "ground").map((c, i) => {
      const existing = previous?.footprints.find((f) => f.component === c.id);
      return {
        component: c.id, ref: c.refDes, x: existing?.x ?? 10 + i % 6 * 14, y: existing?.y ?? 10 + Math.floor(i / 6) * 12, rotation: existing?.rotation ?? 0,
        pads: c.pins.map((p, j) => ({ ...existing?.pads.find(q=>q.pin===p.name), pin: p.name, net: nets.get(c.id)?.get(p.name) ?? `nc_${c.id}_${p.name}`, x: existing?.pads.find((q) => q.pin === p.name)?.x ?? j * 2.54, y: existing?.pads.find((q) => q.pin === p.name)?.y ?? 0 })),
      };
    }),
    tracks: previous?.tracks ?? [],
    vias: previous?.vias??[],
  };
}
export function padPosition(f: Footprint, p: Pad): Point {
  const a = f.rotation * Math.PI / 180;
  return { x: f.x + p.x * Math.cos(a) - p.y * Math.sin(a), y: f.y + p.x * Math.sin(a) + p.y * Math.cos(a) };
}
function distance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (u: Point, v: Point, w: Point) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0 && Math.max(a.x, b.x) >= Math.min(c.x, d.x) && Math.max(c.x, d.x) >= Math.min(a.x, b.x) && Math.max(a.y, b.y) >= Math.min(c.y, d.y) && Math.max(c.y, d.y) >= Math.min(a.y, b.y)) return 0;
  return Math.min(distance(a, c, d), distance(b, c, d), distance(c, a, b), distance(d, a, b));
}
export function checkBoard(b: Board): string[] {
  const issues: string[] = [];
  const pads = [...b.footprints.flatMap((f) => f.pads.map((p) => ({ ...padPosition(f, p), radius:(p.diameter??1.6)/2, net: p.net, name: `${f.ref}.${p.pin}` }))),...(b.vias??[]).map((v,i)=>({...v,radius:v.diameter/2,name:`Via ${i+1}`}))];
  const segments = b.tracks.flatMap((t) => t.points.slice(1).map((p, i) => ({ a: t.points[i], b: p, ...t })));
  for (const p of pads) if (p.x < p.radius + b.clearance || p.y < p.radius + b.clearance || p.x > b.width - p.radius - b.clearance || p.y > b.height - p.radius - b.clearance) issues.push(`${p.name}: pad too close to board edge.`);
  for (let i = 0; i < pads.length; i++) for (const q of pads.slice(i + 1)) if (pads[i].net !== q.net && Math.hypot(pads[i].x - q.x, pads[i].y - q.y) < pads[i].radius+q.radius + b.clearance) issues.push(`${pads[i].name} / ${q.name}: pad clearance.`);
  for (const [i, a] of segments.entries()) {
    if ([a.a, a.b].some((p) => p.x < a.width / 2 + b.clearance || p.y < a.width / 2 + b.clearance || p.x > b.width - a.width / 2 - b.clearance || p.y > b.height - a.width / 2 - b.clearance)) issues.push(`Track ${i + 1}: board edge clearance.`);
    for (const p of pads) if (p.net !== a.net && distance(p, a.a, a.b) < p.radius + a.width / 2 + b.clearance) issues.push(`Track ${i + 1} / ${p.name}: copper clearance.`);
    for (const c of segments.slice(i + 1)) if (a.layer === c.layer && a.net !== c.net && segmentDistance(a.a, a.b, c.a, c.b) < (a.width + c.width) / 2 + b.clearance) issues.push(`Tracks on ${a.layer}: short or clearance violation (${a.net}, ${c.net}).`);
  }
  // Connected-component check catches a net routed as disconnected islands.
  for (const net of new Set(pads.map((p) => p.net))) {
    const group = pads.filter((p) => p.net === net);
    if (group.length < 2) continue;
    const copper = segments.filter((s) => s.net === net);
    const seen = new Set<number>();
    const reachedPads = new Set([0]);
    let changed = true;
    while (changed) {
      changed = false;
      copper.forEach((s, i) => {
        if (seen.has(i)) return;
        if (group.some((p, j) => reachedPads.has(j) && distance(p, s.a, s.b) <= p.radius + s.width / 2) || copper.some((t, j) => seen.has(j) && s.layer === t.layer && segmentDistance(s.a, s.b, t.a, t.b) <= (s.width + t.width) / 2)) {
          seen.add(i); changed = true;
          group.forEach((p, j) => { if (distance(p, s.a, s.b) <= p.radius + s.width / 2) reachedPads.add(j); });
        }
      });
    }
    if (reachedPads.size < group.length) issues.push(`${net}: ${group.length - reachedPads.size} unconnected pad(s).`);
  }
  return [...new Set(issues)];
}
const quote = (s: string) => JSON.stringify(s);
export function boardToKicad(b: Board): string {
  validateWorkspace({ board: b });
  const nets = ["", ...new Set(b.footprints.flatMap((f) => f.pads.map((p) => p.net)).concat(b.tracks.map((t) => t.net),(b.vias??[]).map(v=>v.net)).filter(Boolean))];
  return `(kicad_pcb (version 20240108) (generator "microsim") (general (thickness 1.6)) (paper "A4")
    (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (36 "B.SilkS" user) (39 "F.Mask" user) (38 "B.Mask" user))
    (setup (pad_to_mask_clearance 0))
    ${nets.map((n, i) => `(net ${i} ${quote(n)})`).join("\n")}
    (gr_rect (start 0 0) (end ${b.width} ${b.height}) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
    ${b.footprints.map((f) => `(footprint "Microsim:Custom" (layer "F.Cu") (at ${f.x} ${f.y} ${-f.rotation}) (attr through_hole)
      (fp_text reference ${quote(f.ref)} (at 0 -2) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
      ${f.pads.map((p) => `(pad ${quote(p.pin)} thru_hole circle (at ${p.x} ${p.y} ${-f.rotation}) (size ${p.diameter??1.6} ${p.diameter??1.6}) (drill ${p.drill??0.8}) (layers "*.Cu" "*.Mask") (net ${nets.indexOf(p.net)} ${quote(p.net)}))`).join("\n")})`).join("\n")}
    ${(b.vias??[]).map(v=>`(via (at ${v.x} ${v.y}) (size ${v.diameter}) (drill ${v.drill}) (layers "F.Cu" "B.Cu") (net ${nets.indexOf(v.net)}))`).join('\n')}
    ${b.tracks.flatMap((t) => t.points.slice(1).map((p, i) => `(segment (start ${t.points[i].x} ${t.points[i].y}) (end ${p.x} ${p.y}) (width ${t.width}) (layer ${quote(t.layer)}) (net ${nets.indexOf(t.net)}))`)).join("\n")})\n`;
}

export const VHDL_EXAMPLE = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is port(clk : in std_logic; led : out std_logic); end;
architecture rtl of top is
  signal counter : unsigned(23 downto 0) := (others => '0');
begin
  process(clk) begin if rising_edge(clk) then counter <= counter + 1; end if; end process;
  led <= counter(23);
end;
`;
export const C_EXAMPLE = `#include <8051.h>
void main(void) {
  volatile unsigned int delay;
  while (1) { P1 ^= 1; for (delay = 0; delay < 50000; ++delay) {} }
}
`;
