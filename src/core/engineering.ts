import { defaultFootprint, packagePads, FOOTPRINTS } from './footprints';
import { boardPads, boardSegments, padDrill, padSize, shapeDistance, lineShape, inside, transform } from './pcb-geometry';
import { boardSilkscreen, type SilkLine } from './pcb-silk';
import { zoneAnalysis } from './pcb-zones';
import { buildNetlist } from "./netlist";
import type { Point, Schematic } from "./schematic";
import { validateFlowProgram, type FlowProgram } from './dataflow';

export interface Pad extends Point { pin: string; net: string; diameter?: number; drill?: number; number?: string; shape?: "circle"|"rect"|"oval"|"roundrect"; size?: Point }
export interface Footprint extends Point { component: string; ref: string; rotation: number; pads: Pad[]; name?: string; outline?: Point[][] }
export interface Track { net: string; layer: "F.Cu" | "B.Cu"; width: number; points: Point[] }
export interface Via extends Point { net: string; diameter: number; drill: number }
export interface Zone { net: string; layer: "F.Cu"|"B.Cu"; outline: Point[] }
export interface Keepout { layer: "F.Cu"|"B.Cu"|"both"; outline: Point[] }
export interface Board { width: number; height: number; clearance: number; footprints: Footprint[]; tracks: Track[]; vias?: Via[]; zones?: Zone[]; keepouts?: Keepout[]; silkscreen?: SilkLine[] }
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
      if(f.name!==undefined&&typeof f.name!=='string'||f.outline!==undefined&&(!Array.isArray(f.outline)||!f.outline.every(path=>Array.isArray(path)&&path.length>=2&&path.every(point))))bad();
      for (const p of f.pads) {
        if(!p||!point(p))bad();
        const size=padSize(p),drill=padDrill(p);
        if (!point(p) || typeof p.pin !== "string" || typeof p.net !== "string" || p.number!==undefined&&typeof p.number!=='string' || p.shape!==undefined&&!['circle','rect','oval','roundrect'].includes(p.shape) || p.size!==undefined&&!point(p.size) || ![size.x,size.y].every(n=>finite(n)&&n>0) || drill!==undefined&&(!validDrill(Math.min(size.x,size.y),drill)) || p.shape==='circle'&&size.x!==size.y) bad();
      }
    }
    for(const list of [b.zones,b.keepouts])if(list!==undefined){if(!Array.isArray(list))bad();for(const z of list)if(!z||!['F.Cu','B.Cu',...(list===b.keepouts?['both']:[])].includes(z.layer)||!Array.isArray(z.outline)||z.outline.length<3||!z.outline.every(point)||list===b.zones&&typeof (z as Zone).net!=='string')bad();}
    if(b.zones)for(const z of b.zones)if(z.outline.some(p=>p.x<b.clearance||p.y<b.clearance||p.x>b.width-b.clearance||p.y>b.height-b.clearance))bad();
    if(b.zones?.some((z,i)=>b.zones!.slice(i+1).some(q=>q.layer===z.layer&&q.net!==z.net)))bad();
    if(b.silkscreen!==undefined&&(!Array.isArray(b.silkscreen)||b.silkscreen.some(s=>!point(s.a)||!point(s.b)||!finite(s.width)||s.width<=0||typeof s.ref!=='string')))bad();
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

/** New parts use package geometry; saved pads and package selections are preserved. */
export function boardFromSchematic(s: Schematic, previous?: Board): Board {
  const nets=buildNetlist(s).pinNets;
  return {
    ...structuredClone(previous),width:previous?.width??100,height:previous?.height??80,clearance:previous?.clearance??0.25,
    footprints:s.components.filter(c=>c.pins.length&&!c.instrument&&c.kind!=='ground').map((c,i)=>{
      const old=previous?.footprints.find(f=>f.component===c.id);
      if(old)return {...structuredClone(old),ref:c.refDes,pads:old.pads.map(p=>({...structuredClone(p),net:nets.get(c.id)?.get(p.pin)??p.net}))};
      const name=defaultFootprint(c.kind,c.pins.length);
      return {component:c.id,ref:c.refDes,x:10+i%5*18,y:10+Math.floor(i/5)*24,rotation:0,name,outline:structuredClone(FOOTPRINTS[name].outline),pads:packagePads(c,name,nets.get(c.id)??new Map())};
    }),tracks:structuredClone(previous?.tracks??[]),vias:structuredClone(previous?.vias??[]),
  };
}
export function padPosition(f: Footprint, p: Pad): Point {
  const a = f.rotation * Math.PI / 180;
  return { x: f.x + p.x * Math.cos(a) - p.y * Math.sin(a), y: f.y + p.x * Math.sin(a) + p.y * Math.cos(a) };
}
export function checkBoard(b: Board): string[] {
  const issues:string[]=[],pads=boardPads(b),segments=boardSegments(b);
  const touches=(a:typeof pads[number],s:typeof segments[number])=>a.layers.includes(s.layer)&&shapeDistance(a.shape,s.shape)<=1e-7;
  for(const p of pads){
    const d=padDrill(p.p),size=padSize(p.p);
    if(['VCC','GND','V+','V-'].includes(p.p.pin)&&p.net.startsWith('nc_'))issues.push(`${p.name}: assign the physical supply pad to its real net.`);
    if(d!==undefined&&d<0.3)issues.push(`${p.name}: drill below minimum 0.3 mm.`);
    if(d!==undefined&&(Math.min(size.x,size.y)-d)/2<0.15-1e-7)issues.push(`${p.name}: annular ring below minimum 0.15 mm.`);
    if(p.shape.core.some(q=>q.x<p.shape.radius+b.clearance-1e-7||q.y<p.shape.radius+b.clearance-1e-7||q.x>b.width-p.shape.radius-b.clearance+1e-7||q.y>b.height-p.shape.radius-b.clearance+1e-7))issues.push(`${p.name}: pad too close to board edge.`);
    if(p.name.startsWith('Via '))for(const k of b.keepouts??[])if(inside(p.at,k.outline)||k.outline.some((a,i)=>shapeDistance(p.shape,lineShape(a,k.outline[(i+1)%k.outline.length]))<b.clearance-1e-7))issues.push(`${p.name}: keep-out clearance.`);
  }
  for(let i=0;i<pads.length;i++)for(const q of pads.slice(i+1))if(pads[i].net!==q.net&&pads[i].layers.some(l=>q.layers.includes(l))&&shapeDistance(pads[i].shape,q.shape)<b.clearance-1e-7)issues.push(`${pads[i].name} / ${q.name}: pad clearance.`);
  for(const [i,a] of segments.entries()){
    if(a.width<0.15)issues.push(`Track ${i+1}: width below minimum 0.15 mm.`);
    if([a.a,a.b].some(p=>p.x<a.width/2+b.clearance-1e-7||p.y<a.width/2+b.clearance-1e-7||p.x>b.width-a.width/2-b.clearance+1e-7||p.y>b.height-a.width/2-b.clearance+1e-7))issues.push(`Track ${i+1}: board edge clearance.`);
    for(const p of pads)if(p.net!==a.net&&p.layers.includes(a.layer)&&shapeDistance(p.shape,a.shape)<b.clearance-1e-7)issues.push(`Track ${i+1} / ${p.name}: copper clearance.`);
    for(const c of segments.slice(i+1))if(a.layer===c.layer&&a.net!==c.net&&shapeDistance(a.shape,c.shape)<b.clearance-1e-7)issues.push(`Tracks on ${a.layer}: short or clearance violation (${a.net}, ${c.net}).`);
    for(const k of b.keepouts??[])if((k.layer===a.layer||k.layer==='both')&&(inside(a.a,k.outline)||inside(a.b,k.outline)||k.outline.some((p,j)=>shapeDistance(a.shape,lineShape(p,k.outline[(j+1)%k.outline.length]))<b.clearance)))issues.push(`Track ${i+1}: keep-out clearance.`);
  }
  const zones=zoneAnalysis(b);
  issues.push(...zones.warnings);
  for(const net of new Set(pads.map(p=>p.net))){
    const group=pads.filter(p=>p.net===net),copper=segments.filter(s=>s.net===net);
    if(group.length<2)continue;
    const reached=new Set([0]),seen=new Set<number>();let changed=true;
    while(changed){changed=false;
      for(let i=0;i<group.length;i++)if(!reached.has(i)&&group.some((p,j)=>reached.has(j)&&(p.layers.some(l=>group[i].layers.includes(l))&&shapeDistance(p.shape,group[i].shape)<=1e-7||zones.connected(p.at,group[i].at,net,p.layers,group[i].layers)))){reached.add(i);changed=true;}
      copper.forEach((s,i)=>{if(seen.has(i))return;if(group.some((p,j)=>reached.has(j)&&touches(p,s))||copper.some((t,j)=>seen.has(j)&&s.layer===t.layer&&shapeDistance(s.shape,t.shape)<=1e-7)){seen.add(i);changed=true;}});
      group.forEach((p,j)=>{if(!reached.has(j)&&copper.some((s,i)=>seen.has(i)&&touches(p,s))){reached.add(j);changed=true;}});
    }
    if(reached.size<group.length)issues.push(`${net}: ${group.length-reached.size} unconnected pad(s).`);
  }
  for(const s of boardSilkscreen(b))for(const p of pads)if(p.layers.includes('F.Cu')&&shapeDistance(lineShape(s.a,s.b,s.width),p.shape)<0.05-1e-7)issues.push(`${s.ref} / ${p.name}: silkscreen over pad.`);
  return [...new Set(issues)];
}
const quote = (s: string) => JSON.stringify(s);
export function boardToKicad(b: Board): string {
  validateWorkspace({ board: b });
  const nets = ["", ...new Set(b.footprints.flatMap((f) => f.pads.map((p) => p.net)).concat(b.tracks.map((t) => t.net),(b.vias??[]).map(v=>v.net),(b.zones??[]).map(z=>z.net)).filter(Boolean))];
  const silk=boardSilkscreen(b);
  return `(kicad_pcb (version 20240108) (generator "microsim") (general (thickness 1.6)) (paper "A4")
    (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (35 "F.Paste" user) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (36 "B.SilkS" user) (49 "F.Fab" user) (39 "F.Mask" user) (38 "B.Mask" user))
    (setup (pad_to_mask_clearance 0))
    ${nets.map((n, i) => `(net ${i} ${quote(n)})`).join("\n")}
    (gr_rect (start 0 0) (end ${b.width} ${b.height}) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
    ${b.footprints.map(f=>`(footprint ${quote('Microsim:'+(f.name??'Custom'))} (layer "F.Cu") (at ${f.x} ${f.y} ${-f.rotation})
      (fp_text reference ${quote(f.ref)} (at 0 -2) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
      ${silk.filter(s=>s.ref===f.ref&&!b.silkscreen?.includes(s)).map(s=>{const inverse=(p:Point)=>transform({x:0,y:0,rotation:-f.rotation},{x:p.x-f.x,y:p.y-f.y}),a=inverse(s.a),c=inverse(s.b);return `(fp_line (start ${a.x} ${a.y}) (end ${c.x} ${c.y}) (stroke (width ${s.width}) (type default)) (layer "F.SilkS"))`;}).join('\n')}
      ${f.pads.map(p=>{const size=padSize(p),drill=padDrill(p),smd=drill===undefined;return `(pad ${quote(p.number??p.pin)} ${smd?'smd':'thru_hole'} ${p.shape??'circle'} (at ${p.x} ${p.y} ${-f.rotation}) (size ${size.x} ${size.y})${smd?'':` (drill ${drill})`} (layers ${smd?'"F.Cu" "F.Paste" "F.Mask"':'"*.Cu" "*.Mask"'}) ${p.shape==='roundrect'?'(roundrect_rratio 0.25)':''} (net ${nets.indexOf(p.net)} ${quote(p.net)}))`;}).join('\n')})`).join('\n')}
    ${(b.silkscreen??[]).map(s=>`(gr_line (start ${s.a.x} ${s.a.y}) (end ${s.b.x} ${s.b.y}) (stroke (width ${s.width}) (type default)) (layer "F.SilkS"))`).join('\n')}
    ${(b.zones??[]).map(z=>`(zone (net ${nets.indexOf(z.net)}) (net_name ${quote(z.net)}) (layer ${quote(z.layer)}) (hatch edge 0.5) (connect_pads yes (clearance ${b.clearance})) (min_thickness 0.1) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.3)) (polygon (pts ${z.outline.map(p=>`(xy ${p.x} ${p.y})`).join(' ')})))`).join('\n')}
    ${(b.keepouts??[]).map(k=>`(zone (net 0) (net_name "") (layers ${k.layer==='both'?'"F.Cu" "B.Cu"':quote(k.layer)}) (hatch edge 0.5) (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (polygon (pts ${k.outline.map(p=>`(xy ${p.x} ${p.y})`).join(' ')})))`).join('\n')}
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
