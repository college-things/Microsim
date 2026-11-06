import { FOOTPRINTS, changeFootprint } from '../core/footprints';
import { padDrill, padSize } from '../core/pcb-geometry';
import { boardSilkscreen } from '../core/pcb-silk';
import type { RouteResult, RouteProgress } from '../core/autoroute';
import type { Doc } from "../core/doc";
import { boardFromSchematic, boardToKicad, C_EXAMPLE, checkBoard, padPosition, VHDL_EXAMPLE, type DesignWorkspace } from "../core/engineering";
import { readComponentDatabase, registerDatabase, writeComponentDatabase, type DatabasePart } from "../core/component-database";
import { exchangeLabview,exchangeLabviewVI } from "../core/labview";
import { findVector } from "../core/analyses";
import type { RunData } from "./instruments";
import { openFile, saveFile } from "./platform";
import { PART_BY_KIND } from "../core/library";
import { niPartToDatabasePart, type NiPart } from "../core/ni-database";
import {boardFabricationFiles,fabricationZip} from '../core/fabrication';
import { FlowRuntime } from '../core/dataflow';
import { dataflowEditor } from './dataflow';
import { readIntelHex, programHex } from '../engine/ihex';
import { assemble51 } from '../engine/asm51';
import { assemblePic } from '../engine/asmpic';
import { picWords, type PicVariant } from '../engine/pic16';
import { isMcu, isMcuPic, isMcu8051 } from '../importer/mcu';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const n = document.createElement(tag); n.textContent = text; return n; };
const button = (text: string, action: () => void) => { const b = el("button", text); b.type = "button"; b.onclick = action; return b; };
const field = (host: HTMLElement, label: string, value: string, type = "text") => { const row = el("label", label); row.className = "field"; const input = el("input"); input.type = type; input.value = value; input.setAttribute("aria-label", label); row.append(input); host.append(row); return input; };
type Dialog = (title: string, build: (body: HTMLElement, close: () => void) => void, dismiss?: () => void) => void;
type BuildFile = { name: string; encoding: "text" | "base64"; contents: string };
export class DesignUI {
  database: DatabasePart[] = [];
  private token = "";
  private bridge = "http://127.0.0.1:47832";
  private stopExchange?: () => void;
  constructor(private doc: Doc, private dialog: Dialog, private paletteChanged: () => void, private latestRun: () => RunData | undefined, private updateSources: (apply: () => void) => void) {
    try { const saved = localStorage.getItem("microsim.components"); if (saved) { this.database = readComponentDatabase(saved); registerDatabase(this.database); } } catch { /* A damaged catalogue cannot prevent opening the app. */ }
  }
  private commit(change: (workspace: DesignWorkspace) => void) {
    this.doc.checkpoint();
    this.doc.schematic.workspace ??= {};
    change(this.doc.schematic.workspace);
    this.doc.notify();
  }
  reset() { this.stopExchange?.(); }
  pcb() {
    let router:Worker|undefined;
    const stopRouter=()=>{router?.terminate();router=undefined;};
    this.dialog("PCB layout", (box, close) => {
      box.classList.add("design-dialog");
      let board = boardFromSchematic(this.doc.schematic, this.doc.schematic.workspace?.board);
      let selected: { net: string; at: { x: number; y: number } } | undefined;
      const info = el("p", "Dimensions in mm. Check the selected package and pin numbers against your actual part. Supply pads absent from the symbol need explicit net assignment below. Click two same-net pads to route; empty space adds a corner. Right-click cancels.");
      const controls = el("div"); controls.className = "design-controls";
      const width = field(controls, "Width (mm)", String(board.width), "number"), height = field(controls, "Height (mm)", String(board.height), "number");
      const clearance = field(controls, "Clearance (mm)", String(board.clearance), "number");
      const layer = el("select"); layer.setAttribute("aria-label", "Copper layer");
      for (const name of ["F.Cu", "B.Cu"]) { const option = el("option", name); option.value = name; layer.append(option); }
      controls.append(layer);
      const trackWidth = field(controls, "Track width (mm)", "0.4", "number");
      const status = el("pre"); status.className = "design-status";
      const view = document.createElementNS("http://www.w3.org/2000/svg", "svg"); view.classList.add("pcb-board"); view.setAttribute("role", "group"); view.setAttribute("aria-label", "PCB pads and copper tracks");
      const table = el("div");
      let path: { x: number; y: number }[] = [];
      const routingHistory:{tracks:typeof board.tracks;vias:typeof board.vias}[]=[];
      const rememberRoute=()=>routingHistory.push(structuredClone({tracks:board.tracks,vias:board.vias}));
      const route = (net: string, at: { x: number; y: number }) => {
        if (!selected) { selected = { net, at }; path = [at]; status.textContent = `Routing ${net}. Click a same-net pad to finish.`; }
        else if (selected.net !== net) status.textContent = "Choose a pad on the same net.";
        else {
          const n = Number(trackWidth.value);
          if (!(n > 0 && Number.isFinite(n))) { status.textContent = "Track width must be positive."; return; }
          if (Math.hypot(at.x - selected.at.x, at.y - selected.at.y) < 0.001 && path.length === 1) return;
          rememberRoute();board.tracks.push({ net, layer: layer.value as "F.Cu" | "B.Cu", width: n, points: [...path, at] }); selected = undefined; path = []; draw();
        }
      };
      const shape = (tag: string, attrs: Record<string, string>) => { const n = document.createElementNS(view.namespaceURI, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); view.append(n); return n; };
      const draw = () => {
        view.replaceChildren(); view.setAttribute("viewBox", `-3 -3 ${board.width + 6} ${board.height + 6}`);
        shape("rect", { x: "0", y: "0", width: String(board.width), height: String(board.height), fill: "#143c30", stroke: "#76ad88", "stroke-width": "0.2" });
        for(const z of board.zones??[])shape('polygon',{points:z.outline.map(p=>`${p.x},${p.y}`).join(' '),fill:z.layer==='F.Cu'?'#ff897b':'#82acff',opacity:'0.15'});
        for(const k of board.keepouts??[])shape('polygon',{points:k.outline.map(p=>`${p.x},${p.y}`).join(' '),fill:'#ffcc44',opacity:'0.3',stroke:'#ffcc44','stroke-width':'0.2'});
        for(const s of boardSilkscreen(board))shape('line',{x1:String(s.a.x),y1:String(s.a.y),x2:String(s.b.x),y2:String(s.b.y),stroke:'white','stroke-width':String(s.width)});
        const pads = board.footprints.flatMap((f) => f.pads.map((p) => ({ ...padPosition(f, p), net: p.net })));
        for (const net of new Set(pads.map((p) => p.net))) {
          const group = pads.filter((p) => p.net === net);
          group.slice(1).forEach((p, i) => shape("line", { x1: String(group[i].x), y1: String(group[i].y), x2: String(p.x), y2: String(p.y), stroke: "#779d87", "stroke-width": "0.12", "stroke-dasharray": "1 1" }));
        }
        for (const t of board.tracks) shape("polyline", { points: t.points.map((p) => `${p.x},${p.y}`).join(" "), stroke: t.layer === "F.Cu" ? "#ff897b" : "#82acff", "stroke-width": String(t.width), fill: "none", "stroke-linecap": "round" });
        for(const [i,v] of (board.vias??[]).entries()){
          const dot=shape('circle',{cx:String(v.x),cy:String(v.y),r:String(v.diameter/2),fill:'#bba8ff',stroke:'#151a16','stroke-width':String(v.drill/2),tabindex:'0',role:'button','aria-label':`Via ${i+1}: ${v.net}`});
          dot.addEventListener('click',e=>{e.stopPropagation();route(v.net,v)});
          dot.addEventListener('keydown',event=>{const e=event as KeyboardEvent;if(e.key==='Enter'||e.key===' '){e.preventDefault();route(v.net,v);}});
        }
        if (path.length) shape("polyline", { points: path.map((p) => `${p.x},${p.y}`).join(" "), stroke: "white", "stroke-width": "0.3", fill: "none" });
        for (const f of board.footprints) {
          if(!f.outline){const label = shape("text", { x: String(f.x), y: String(f.y - 2), fill: "white", "font-size": "1.8" }); label.textContent = f.ref;}
          for (const p of f.pads) {
            const at = padPosition(f, p);
            const size=padSize(p),kind=p.shape??'circle';
            const attrs={fill:'#eac968',stroke:'#151a16','stroke-width':'0.1',tabindex:'0',role:'button','aria-label':`${f.ref}.${p.pin} (pad ${p.number??p.pin}): ${p.net}`};
            const dot=kind==='circle'?shape('circle',{...attrs,cx:String(at.x),cy:String(at.y),r:String(size.x/2)}):shape('rect',{...attrs,x:String(at.x-size.x/2),y:String(at.y-size.y/2),width:String(size.x),height:String(size.y),rx:String(kind==='rect'?0:Math.min(size.x,size.y)*(kind==='oval'?0.5:0.25)),transform:`rotate(${f.rotation} ${at.x} ${at.y})`});
            const drill=padDrill(p);if(drill!==undefined)shape('circle',{cx:String(at.x),cy:String(at.y),r:String(drill/2),fill:'#143c30','pointer-events':'none'});
            const title = document.createElementNS(view.namespaceURI, "title"); title.textContent = `${f.ref}.${p.pin}: ${p.net}`; dot.append(title);
            dot.addEventListener("click", (e) => { e.stopPropagation(); route(p.net, at); });
            dot.addEventListener("keydown", (event) => { const e = event as KeyboardEvent; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); route(p.net, at); } });
          }
        }
        const errors = checkBoard(board); status.textContent = errors.length ? errors.join("\n") : "Connectivity and copper clearance checks passed. Verify package dimensions before fabrication.";
      };
      view.onclick = (e) => {
        if (!selected) return;
        const matrix = view.getScreenCTM(); if (!matrix) return;
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
        path.push({ x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2 }); draw();
      };
      view.oncontextmenu = (e) => { e.preventDefault(); selected = undefined; path = []; draw(); };
      const dimensions = () => {
        const values = [width, height, clearance].map((input) => Number(input.value));
        if (values.some((n) => !(n > 0 && n <= 10000))) { status.textContent = "Dimensions must be positive and at most 10000 mm."; return; }
        [board.width, board.height, board.clearance] = values; if(pourNet.value.trim())updatePour();else draw();
      };
      width.onchange = height.onchange = clearance.onchange = dimensions;
      const placements = () => {
        table.replaceChildren();
        for (const f of board.footprints) {
          const row = el("div"); row.className = "design-controls"; row.append(el("strong", f.ref));
          const component=this.doc.schematic.components.find(c=>c.id===f.component)!;
          const pkg=el('select');pkg.setAttribute('aria-label',`${f.ref} footprint`);
          if(!f.name){const o=el('option','Saved generic pads');o.value='';pkg.append(o);}
          for(const name of Object.keys(FOOTPRINTS)){const o=el('option',name);o.value=name;pkg.append(o);}pkg.value=f.name??'';
          pkg.onchange=()=>{try{if(pkg.value){changeFootprint(f,component,pkg.value);placements();draw();}}catch(e){status.textContent=String(e);pkg.value=f.name??'';}};row.append(pkg);
          for (const key of ["x", "y", "rotation"] as const) {
            const input = field(row, `${f.ref} ${key}`, String(f[key]), "number");
            input.onchange = () => { const n = Number(input.value); if (Number.isFinite(n) && Math.abs(n) <= 10000) { f[key] = n; draw(); } };
          }
          const pads = field(row, `${f.ref} pad offsets x,y; …`, f.pads.map((p) => `${p.x},${p.y}`).join("; "));
          pads.onchange = () => {
            const coords = pads.value.split(";").map((s) => s.split(",").map(Number));
            if (coords.length !== f.pads.length || coords.some((v) => v.length !== 2 || v.some((n) => !Number.isFinite(n) || Math.abs(n) > 10000))) { status.textContent = "Provide one x,y pair per pad."; return; }
            coords.forEach(([x, y], i) => Object.assign(f.pads[i], { x, y })); draw();
          };
          for(const p of f.pads){
            const label=`${f.ref} pad ${p.number??p.pin} (${p.pin})`;
            const net=field(row,`${label} net`,p.net);net.onchange=()=>{p.net=net.value.trim()||`nc_${f.component}_${p.pin}`;draw();};
          }
          if(!f.name)for(const key of ['diameter','drill'] as const){
            const input=field(row,`${f.ref} pad ${key} (mm)`,String(f.pads[0]?.[key]??(key==='diameter'?1.6:0.8)),'number');
            input.onchange=()=>{const n=Number(input.value);if(!Number.isFinite(n)||n<=0||f.pads.some(p=>key==='diameter'?n<=(p.drill??0.8):n>=(p.diameter??1.6))){status.textContent='Pad diameter must exceed its positive drill diameter.';return;}for(const p of f.pads)p[key]=n;draw();};
          }
          table.append(row);
        }
      };
      const pourNet=field(controls,'Pour net (blank disables)',board.zones?.[0]?.net??'');
      const pourLayer=el('select');pourLayer.setAttribute('aria-label','Pour layer');
      for(const name of ['F.Cu','B.Cu']){const o=el('option',name);o.value=name;pourLayer.append(o);}pourLayer.value=board.zones?.[0]?.layer??'B.Cu';controls.append(pourLayer);
      const updatePour=()=>{const net=pourNet.value.trim(),m=board.clearance;board.zones=net?[{net,layer:pourLayer.value as 'F.Cu'|'B.Cu',outline:[{x:m,y:m},{x:board.width-m,y:m},{x:board.width-m,y:board.height-m},{x:m,y:board.height-m}]}]:[];draw();};
      pourNet.onchange=pourLayer.onchange=updatePour;
      const keepout=field(controls,'Keep-out rectangle x,y,width,height','');
      controls.append(button('Add keep-out on selected layer',()=>{const n=keepout.value.split(',').map(Number);if(n.length!==4||n.some(v=>!Number.isFinite(v))||n[2]<=0||n[3]<=0){status.textContent='Enter x,y,width,height with positive width and height.';return;}const [x,y,w,h]=n;board.keepouts??=[];board.keepouts.push({layer:layer.value as 'F.Cu'|'B.Cu',outline:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});draw();}),button('Clear keep-outs',()=>{board.keepouts=[];draw();}));
      const actions = el("div"); actions.className = "dialog-actions";
      actions.append(button('Autoroute',()=>{
        if(router)return;
        const snapshot=structuredClone(board);
        router=new Worker(new URL('../core/autoroute.worker.ts',import.meta.url),{type:'module'});
        router.onmessage=(event:MessageEvent<{progress?:RouteProgress;result?:RouteResult;error?:string}>)=>{
          const {progress,result,error}=event.data;
          if(progress)status.textContent=`Routing ${progress.completed}/${progress.total}, attempt ${progress.attempt}...`;
          if(error){stopRouter();status.textContent=error;}
          if(result){stopRouter();if(JSON.stringify(board)!==JSON.stringify(snapshot)){status.textContent='Layout changed while routing. Run Autoroute again for the current layout.';return;}rememberRoute();board=result.board;selected=undefined;path=[];draw();status.textContent+=`\nAutoroute: ${result.connections-result.unrouted.length}/${result.connections} connections in ${(result.elapsedMs/1000).toFixed(2)} s.`;if(result.unrouted.length)status.textContent+=`\nUnrouted:\n${result.unrouted.join('\n')}`;}
        };
        router.onerror=e=>{stopRouter();status.textContent=e.message||'Autorouter failed.';};
        router.postMessage({board:snapshot,options:{width:0.25}});
      }),button('Cancel autoroute',()=>{stopRouter();draw();status.textContent+='\nRouting cancelled; layout kept.';}),button('Remove all tracks',()=>{stopRouter();rememberRoute();board.tracks=[];board.vias=[];selected=undefined;path=[];draw();}));
      actions.append(button("Cancel", ()=>{stopRouter();close();}), button("Undo route", () => {const previous=routingHistory.pop();if(previous){board.tracks=previous.tracks;board.vias=previous.vias;}selected=undefined;path=[];draw();}),button('Place via / switch layer',()=>{
        if(!selected||!path.length){status.textContent='Start routing a pad and click the via position first.';return;}
        const at=path[path.length-1],n=Number(trackWidth.value);if(!(n>0&&Number.isFinite(n))){status.textContent='Track width must be positive.';return;}
        rememberRoute();board.vias??=[];board.vias.push({...at,net:selected.net,diameter:0.8,drill:0.4});
        if(path.length>1)board.tracks.push({net:selected.net,layer:layer.value as 'F.Cu'|'B.Cu',width:n,points:[...path]});
        selected={net:selected.net,at};path=[at];layer.value=layer.value==='F.Cu'?'B.Cu':'F.Cu';draw();
      }), button("Refresh from schematic", () => { board = boardFromSchematic(this.doc.schematic, board);routingHistory.length=0;selected=undefined;path=[]; placements(); draw(); }), button("Export KiCad board", () => { void saveFile(`${this.doc.schematic.name}.kicad_pcb`, "kicad_pcb", boardToKicad(board)).catch((e) => { status.textContent = String(e); }); }),button('Export Gerber / drill ZIP',()=>{try{void saveFile(`${this.doc.schematic.name}-fabrication.zip`,'zip',fabricationZip(boardFabricationFiles(board))).catch(e=>{status.textContent=String(e)});}catch(e){status.textContent=String(e);}}), button("Apply layout", () => { this.commit((w) => { w.board = structuredClone(board); }); stopRouter();close(); }));
      box.append(info, controls, view, table, status, actions); placements(); draw();
    },stopRouter);
  }
  compiler(language: "c" | "vhdl") {
    let abort: AbortController | undefined;
    this.dialog(language === "c" ? "C compiler — 8051" : "VHDL / FPGA design", (box, close) => {
      box.classList.add("design-dialog");
      box.append(el("p", "Start npm run design:bridge in this project, then paste its token below. Compilation uses installed tools. C targets 8051 via SDCC; FPGA builds target iCE40 HX1K / TQ144 via GHDL, Yosys, nextpnr and icepack."));
      const config = el("div"); config.className = "design-controls";
      const url = field(config, "Build bridge URL", this.bridge), token = field(config, "Bridge token", this.token, "password");
      const workspace = this.doc.schematic.workspace;
      const top = language === "vhdl" ? field(config, "Top entity", workspace?.vhdl?.top ?? "top") : undefined;
      const source = el("textarea"); source.className = "design-source"; source.setAttribute("aria-label", `${language} source`);
      source.value = language === "c" ? workspace?.firmware?.source ?? C_EXAMPLE : workspace?.vhdl?.source ?? VHDL_EXAMPLE;
      const constraints = el("textarea"); constraints.className = "design-source compact"; constraints.setAttribute("aria-label", "PCF pin constraints");
      constraints.value = workspace?.vhdl?.constraints ?? "# Set the pins for your HX1K TQ144 board:\n# set_io clk 21\n# set_io led 99\n";
      const output = el("pre", "No build has been run."); output.className = "design-status";
      const downloads = el("div"); downloads.className = "design-controls";
      const targetMcu=el('select');targetMcu.setAttribute('aria-label','Firmware target');
      const newMcu=el('option','Create 8051 firmware core');newMcu.value='';targetMcu.append(newMcu);
      for(const comp of this.doc.schematic.components.filter(isMcu8051)){const option=el('option',comp.refDes);option.value=comp.id;targetMcu.append(option);}
      const actions = el("div"); actions.className = "dialog-actions";
      const saveSource = () => this.commit((w) => {
        if (language === "c") w.firmware = { ...w.firmware, source: source.value, hex: w.firmware?.source === source.value ? w.firmware.hex : undefined };
        else w.vhdl = { source: source.value, top: top!.value.trim(), constraints: constraints.value };
      });
      const build = async (action: string) => {
        downloads.replaceChildren(); output.textContent = "Building…";
        this.bridge = url.value.replace(/\/$/, ""); this.token = token.value;
        saveSource();
        const snapshot = this.doc.schematic;
        abort?.abort(); abort = new AbortController();
        const timer = setTimeout(() => abort?.abort(), 600000);
        const sourceText = source.value;
        actions.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        cancel.disabled = false;
        try {
          const target = new URL(this.bridge);
          if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.protocol !== "http:") throw new Error("Use an HTTP localhost build bridge.");
          const response = await fetch(`${this.bridge}/build`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` }, body: JSON.stringify({ action, source: sourceText, top: top?.value.trim(), constraints: constraints.value }), signal: abort.signal });
          const result = await response.json();
          if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
          if (!Array.isArray(result.files) || typeof result.log !== "string") throw new Error("Invalid build response.");
          output.textContent = result.log;
          for (const file of result.files as BuildFile[]) {
            if (typeof file.name !== "string" || typeof file.contents !== "string" || !["text", "base64"].includes(file.encoding)) throw new Error("Invalid build artifact.");
            downloads.append(button(`Download ${file.name}`, () => { const data = file.encoding === "base64" ? Uint8Array.from(atob(file.contents), (s) => s.charCodeAt(0)) : file.contents; void saveFile(file.name, file.name.split(".").pop()!, data).catch((e) => { output.textContent = String(e); }); }));
            if (file.name === "firmware.hex" && this.doc.schematic === snapshot && snapshot.workspace?.firmware?.source === sourceText) this.commit((w) => { w.firmware = { source: sourceText, hex: file.contents }; });
          }
        } catch (e) { output.textContent = `Build failed: ${e instanceof Error ? e.message : e}.\nCheck that the bridge is running, its token matches, and the required tools are on PATH.`; }
        finally { clearTimeout(timer); actions.querySelectorAll("button").forEach((b) => { b.disabled = false; }); }
      };
      const cancel = button("Close", close);
      actions.append(cancel, button("Save source", saveSource), button("Export source", () => { void saveFile(language === "c" ? "main.c" : "design.vhd", language === "c" ? "c" : "vhd", source.value); }));
      actions.append(button('Check installed tools',()=>{void(async()=>{try{
        this.bridge=url.value.replace(/\/$/,'');this.token=token.value;const target=new URL(this.bridge);if(target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw new Error('Use an HTTP localhost build bridge.');
        const response=await fetch(`${this.bridge}/tools`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.token}`},body:'{}'});const result=await response.json();if(!response.ok)throw new Error(result.error??`HTTP ${response.status}`);output.textContent=Object.entries(result).map(([name,data])=>`${name}: ${JSON.stringify(data)}`).join('\n');
      }catch(e){output.textContent=String(e)}})()}));
      if (language === "c") actions.append(button("Compile C", () => void build("c")));
      else actions.append(button("Check VHDL", () => void build("vhdl-check")), button("Simulate 1 µs", () => void build("vhdl-sim")), button("Build FPGA bitstream", () => void build("fpga")));
      box.append(config, source);
      if(language==='c'){
        const firmwareActions=el('div');firmwareActions.className='design-controls';
        firmwareActions.append(targetMcu,button('Attach firmware',()=>{
          try{
            const text=this.doc.schematic.workspace?.firmware?.hex;if(!text)throw new Error('Compile C or import a HEX file first.');
            const bytes=readIntelHex(text);let end=bytes.length;while(end>1&&bytes[end-1]===255)end--;
            this.doc.checkpoint();let comp=this.doc.schematic.components.find(c=>c.id===targetMcu.value&&isMcu8051(c));
            if(targetMcu.value&&!comp)throw new Error('The target MCU was removed.');
            if(!comp){comp=this.doc.addPart('mcu8051',0,0);const option=el('option',comp.refDes);option.value=comp.id;targetMcu.append(option);targetMcu.value=comp.id;}
            comp.params.code=programHex(bytes.slice(0,end));this.doc.notify();output.textContent=`Firmware attached to ${comp.refDes}. Run a transient analysis to execute it. Oscillator defaults to 12 MHz (12 clocks per machine cycle). P0 is open drain; P1–P3 have weak pull-ups. RST is active high. UART, external bus waveforms and chip power behavior are not implemented. Imported NI MCU components are not converted.`;
          }catch(e){output.textContent=String(e);}
        }),button('Import Intel HEX',()=>{void(async()=>{try{const file=await openFile(['hex','ihx']);if(!file)return;const text=new TextDecoder().decode(file.bytes);readIntelHex(text);this.commit(w=>{w.firmware={source:'',hex:text};});source.value='';output.textContent='HEX loaded. Choose a firmware target and attach it.';}catch(e){output.textContent=String(e);}})();}));
        box.append(firmwareActions);
      }
      if (language === "vhdl") box.append(el("label", "PCF constraints (HX1K TQ144)"), constraints);
      box.append(output, downloads, actions);
    }, () => abort?.abort());
  }
  /** Loads source or Intel HEX into a supported MCU, with no external tools. */
  mcuProgram() {
    this.dialog("Microcontroller program", (box, close) => {
      box.classList.add("design-dialog");
      const parts = this.doc.schematic.components.filter(isMcu);
      if (!parts.length) {
        box.append(el("p", "This circuit has no microcontroller. Place an 8051 or PIC16 firmware core from the Digital palette, or open a circuit with a supported NI MCU."));
        const actions = el("div"); actions.className = "dialog-actions"; actions.append(button("Close", close)); box.append(actions);
        return;
      }
      box.append(el("p", "Assemble Intel-syntax 8051 or MPASM-style PIC16 source, or load Intel HEX. Assembly runs here with no other software. PIC addresses count words; HEX addresses count bytes."));
      const config = el("div"); config.className = "design-controls";
      const target = el("select"); target.setAttribute("aria-label", "Microcontroller");
      for (const comp of parts) { const option = el("option", `${comp.refDes}${comp.params.mcu ? " (imported NI part)" : ""}`); option.value = comp.id; target.append(option); }
      config.append(target);
      const expected = el("p"); expected.className = "muted";
      const source = el("textarea"); source.className = "design-source"; source.setAttribute("aria-label", "Microcontroller assembly source");
      const output = el("pre"); output.className = "design-status";
      const current = () => this.doc.schematic.components.find((c) => c.id === target.value);
      const describe = () => {
        const comp = current();
        if (!comp) return;
        const where = comp.params.workspace ? ` Its Multisim workspace is ${comp.params.workspace}${comp.params.sources ? `; the program is ${comp.params.sources.split(";").join(" or ")} in that workspace's project folder` : ""}.` : "";
        expected.textContent = `${comp.refDes} runs at ${comp.params.frequency ?? "12Meg"} Hz.${where}`;
        source.value = comp.params.asm ?? "";
        const bytes = (comp.params.code ?? "").length / 2;
        output.textContent = bytes ? `${comp.refDes} holds a ${bytes}-byte program.` : `${comp.refDes} has no program yet.`;
      };
      target.onchange = describe;
      const load = (code: Uint8Array, asm: string | undefined, note: string, config?: number) => {
        const comp = current();
        if (!comp) throw new Error("The microcontroller was removed.");
        const pic=isMcuPic(comp),variant=(comp.params.variant??comp.kind) as PicVariant;
        if(pic)picWords(code,variant);
        let end = pic?Math.min(code.length,variant==='pic16f84a'?2048:16384):code.length;
        if(pic){while(end>2&&code[end-1]===255&&code[end-2]===255)end-=2;}
        else while(end>1&&code[end-1]===255)end--;
        this.doc.checkpoint();
        comp.params.code = programHex(code.slice(0, end));
        if(pic){const word=code.length>0x400f?(code[0x400e]|(code[0x400f]<<8)):0xffff;comp.params.config=String(config??(asm===undefined&&word!==0xffff?word&0x3fff:-1));}
        if (asm === undefined) delete comp.params.asm; else comp.params.asm = asm;
        this.doc.notify();
        output.textContent = `${note} ${end} bytes loaded into ${comp.refDes}. Run the circuit to execute it.`;
      };
      const assemble = () => {
        try { const comp=current(); const result = comp&&isMcuPic(comp)?assemblePic(source.value,(comp.params.variant??comp.kind) as PicVariant):assemble51(source.value);
          load(result.code, source.value, "Program assembled.", "config" in result&&typeof result.config==="number"?result.config:undefined); }
        catch (e) { output.textContent = `Not loaded. ${e instanceof Error ? e.message : String(e)}`; }
      };
      const actions = el("div"); actions.className = "dialog-actions";
      actions.append(
        button("Close", close),
        button("Open .asm file…", () => { void (async () => { try { const file = await openFile(["asm", "a51", "s", "txt"]); if (!file) return; source.value = new TextDecoder("latin1").decode(file.bytes); assemble(); } catch (e) { output.textContent = String(e); } })(); }),
        button("Assemble and load", assemble),
        button("Load Intel HEX…", () => { void (async () => { try { const file = await openFile(["hex", "ihx"]); if (!file) return; load(readIntelHex(new TextDecoder().decode(file.bytes)), undefined, "HEX checked."); } catch (e) { output.textContent = String(e); } })(); }),
        button("Remove program", () => { const comp = current(); if (!comp) return; this.doc.checkpoint(); comp.params.code = ""; delete comp.params.asm; this.doc.notify(); describe(); }),
      );
      box.append(config, expected, source, output, actions);
      describe();
    });
  }
  components() {
    this.dialog("Component database", (box, close) => {
      box.classList.add("design-dialog");
      box.append(el("p", "Import embedded parts from .ms14 circuits, a Microsim catalogue, or your installed NI Master/User/Corporate database through the local design bridge. Imported parts appear in the searchable Analog palette. NI database models retain their source text; symbols use a labelled pin block."));
      const search = field(box, "Search catalogue", "", "search"), list = el("div"), status = el("p");
      const persist = () => {
        const text = writeComponentDatabase(this.database);
        registerDatabase(readComponentDatabase(text)); this.paletteChanged();
        try { localStorage.setItem("microsim.components", text); } catch { status.textContent = "Catalogue active this session; browser storage is full. Export it to keep a copy."; }
        draw();
      };
      const draw = () => {
        list.replaceChildren();
        for (const p of this.database.filter((p) => p.name.toLowerCase().includes(search.value.toLowerCase()))) {
          const row = el("div"); row.className = "design-controls";
          row.append(el("span", `${p.name} (${p.component.pins.length} pins)`), button("Remove", () => { this.database = this.database.filter((q) => q !== p); persist(); })); list.append(row);
        }
        if (!list.childElementCount) list.append(el("p", "No matching components."));
      };
      search.oninput = draw;
      const importParts = async () => {
        try {
          const file = await openFile(["ms14", "json"]); if (!file) return;
          const { importMs14 } = await import("../importer");
          const parts = file.name.toLowerCase().endsWith(".json") ? readComponentDatabase(new TextDecoder().decode(file.bytes)) : (() => {
            const result = importMs14(file.bytes);
            status.textContent = result.issues.map((i) => i.message).join("\n");
            return result.schematic.components.filter((c) => c.spice.trim()).map((c) => ({ name: `${c.displayValue || c.kind} — ${c.refDes}`, component: c, definitions: [result.schematic.definitions, PART_BY_KIND.get(c.kind)?.definitions ?? ""].join("\n") }));
          })();
          const existing = new Set(this.database.map((p) => p.name));
          let count = 0;
          for (const part of parts) if (!existing.has(part.name)) { this.database.push(part); existing.add(part.name); count++; }
          persist(); status.textContent = `Imported ${count} component(s).\n${status.textContent}`;
        } catch (e) { status.textContent = String(e); }
      };
      const actions = el("div"); actions.className = "dialog-actions";
      actions.append(button("Import .ms14 / catalogue", () => void importParts()), button("Export catalogue", () => { void saveFile("components.json", "json", writeComponentDatabase(this.database)).catch((e) => { status.textContent = String(e); }); }), button("Close", close));
      const ni = el("details"), summary = el("summary", "Browse an installed NI database"); ni.append(summary);
      const config = el("div"); config.className = "design-controls";
      const bridge = field(config, "Database bridge URL", this.bridge), token = field(config, "Database bridge token", this.token, "password");
      const databasePath = field(ni, "NI database path", "C:\\ProgramData\\National Instruments\\Circuit Design Suite\\14.2\\database\\MSCOMP_S.PRD");
      const query = field(ni, "Search NI database", "2N3904", "search"), results = el("div"), notice = el("p", "Run npm run design:bridge, enter its token, and open your database. Nothing is copied until you import a selected component.");
      const request = async (endpoint: string, data: Record<string, unknown>) => {
        this.bridge = bridge.value.replace(/\/$/, ""); this.token = token.value;
        const target = new URL(this.bridge);
        if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) throw new Error("Use an HTTP localhost design bridge.");
        const response = await fetch(`${this.bridge}/database/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` }, body: JSON.stringify(data) });
        const value = await response.json();
        if (!response.ok || value.error) throw new Error(value.error ?? `HTTP ${response.status}`);
        return value;
      };
      const searchNi = async () => {
        try {
          const page = await request("search", { query: query.value, limit: 30 }); results.replaceChildren();
          notice.textContent = `${page.total} matching components. Showing up to 30; refine the search to narrow the results.`;
          for (const found of page.items) {
            const row = el("div"); row.className = "design-controls";
            row.append(el("span", `${found.name} · ${found.manufacturer} · ${found.family} · ${found.pins} pins`), button("Choose model", () => void (async () => {
              try {
                let part = await request("part", { id: found.id }) as NiPart;
                const models = el("select"); models.setAttribute("aria-label", `${found.name} model`);
                for (const name of part.choices) { const option = el("option", name); option.value = name; option.selected = name === part.model; models.append(option); }
                models.onchange = () => { void (async () => { try { part = await request("part", { id: found.id, model: models.value }); } catch (e) { notice.textContent = String(e); } })(); };
                const add = button("Import selected model", () => {
                  try {
                    if (part.model !== models.value) throw new Error("Wait for the selected model to load.");
                    const imported = niPartToDatabasePart(part);
                    if (!this.database.some((p) => p.name === imported.name)) this.database.push(imported);
                    persist(); notice.textContent = `Imported ${imported.name}. Place it from the Analog palette.`;
                  } catch (e) { notice.textContent = String(e); }
                });
                row.append(models, add);
              } catch (e) { notice.textContent = String(e); }
            })()));
            results.append(row);
          }
        } catch (e) { notice.textContent = String(e); }
      };
      const niActions = el("div"); niActions.className = "design-controls";
      niActions.append(button("Open database", () => void (async () => { try { const opened = await request("open", { path: databasePath.value }); notice.textContent = `Opened ${opened.name}: ${opened.count} components.`; await searchNi(); } catch (e) { notice.textContent = String(e); } })()), button("Search database", () => void searchNi()));
      ni.append(config, niActions, notice, results);
      box.append(list, ni, status, actions); draw();
    });
  }
  labview() {
    this.stopExchange?.();
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = true, controller: AbortController | undefined;
    let nativeActive:{url:string;token:string}|undefined;
    let localRuntime:FlowRuntime|undefined;
    let generation=0;
    const stop = () => { generation++;stopped = true; clearTimeout(timer); controller?.abort();if(nativeActive){const connection=nativeActive;nativeActive=undefined;void fetch(`${connection.url.replace(/\/$/,'')}/labview/close`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`},body:'{}'}).catch(()=>{});} };
    this.stopExchange = stop;
    this.dialog("LabVIEW integration", (box, close) => {
      box.classList.add("design-dialog");
      box.append(el("p", "Run an independent local dataflow program, connect an HTTP service, or execute a native VI through the Windows design bridge. These modes exchange latest readings and update mapped DC sources; they do not negotiate analog solver timesteps. Native VI mode requires LabVIEW installed."));
      const config = this.doc.schematic.workspace?.labview;
      const mode=el('select');mode.setAttribute('aria-label','LabVIEW connection mode');for(const [value,text]of [['local','Local dataflow (no NI installation)'],['http','HTTP Web Service'],['vi','Native VI (Windows)']]){const option=el('option',text);option.value=value;mode.append(option);}mode.value=config?.mode??(config?'http':'local');box.append(mode);
      const url = field(box, "LabVIEW endpoint URL", config?.url ?? "http://127.0.0.1:8080/microsim/exchange");
      const native=el('div');const viPath=field(native,'Local VI path',config?.viPath??''),timeControl=field(native,'VI time control (optional)',config?.timeControl??''),bridge=field(native,'VI bridge URL',this.bridge),token=field(native,'VI bridge token',this.token,'password');
      const bits=el('select');bits.setAttribute('aria-label','LabVIEW bitness');for(const n of [32,64]){const option=el('option',`${n}-bit LabVIEW`);option.value=String(n);bits.append(option);}bits.value=String(config?.bits??32);native.append(bits);box.append(native);
      const local=el('div');local.className='flow-editor';const readProgram=dataflowEditor(local,config?.program,()=>{stop();status.textContent='Disconnected: program changed. Connect to restart.';});box.append(local);
      const showMode=()=>{native.hidden=mode.value!=='vi';local.hidden=mode.value!=='local';url.parentElement!.hidden=mode.value!=='http';};mode.onchange=()=>{stop();showMode();};showMode();
      const maps = el("textarea"); maps.className = "design-source compact"; maps.setAttribute("aria-label", "LabVIEW signal mappings");
      maps.value = JSON.stringify({ inputs: config?.inputs ?? {'v(out)':0}, outputs: config?.outputs ?? {} }, null, 2);
      box.append(el("p", 'Mappings: inputs maps signal names to fallback numbers; outputs maps returned signal names to DC source reference names. For live readings, include the simulator vector name, e.g. "v(out)", in inputs.'), maps);
      const status = el("pre", "Disconnected."); status.className = "design-status";
      const exchange = async () => {
        const session=generation;
        try {
          const mapping = JSON.parse(maps.value);
          if (!mapping.inputs || typeof mapping.inputs !== "object" || Array.isArray(mapping.inputs) || !Object.values(mapping.inputs).every((n) => typeof n === "number" && Number.isFinite(n)) || !mapping.outputs || typeof mapping.outputs !== "object" || Array.isArray(mapping.outputs) || !Object.values(mapping.outputs).every((n) => typeof n === "string")) throw new Error("Invalid signal mappings.");
          const current = this.doc.schematic;
          const run = this.latestRun(); const data = run?.tran ?? run?.op;
          const signals: Record<string, number> = { ...mapping.inputs };
          if (data) for (const name of Object.keys(signals)) { const v = findVector(data, name); if (v?.re.length) signals[name] = v.re[v.re.length - 1]; }
          const axis = run?.tran?.axis?.re;
          controller = new AbortController();
          const requestController=controller;
          const timeout = setTimeout(() => requestController.abort(), mode.value==='vi'?20000:5000);
          let returned: Record<string, number>;
          try { const frame={ time: axis?.[axis.length - 1] ?? 0, signals };
            if(mode.value==='local'){if(!localRuntime)throw new Error('Start a local program first.');returned=localRuntime.step(frame.time,frame.signals);}
            else if(mode.value==='vi'){this.bridge=bridge.value.replace(/\/$/,'');this.token=token.value;
              const target=new URL(this.bridge);if(target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password)throw new Error('Use an HTTP localhost design bridge.');
              nativeActive={url:this.bridge,token:this.token};returned=await exchangeLabviewVI(this.bridge,this.token,{path:viPath.value,bits:Number(bits.value) as 32|64,timeControl:timeControl.value,outputs:Object.keys(mapping.outputs)},frame,controller.signal);
            }else returned = await exchangeLabview(url.value,frame,controller.signal); }
          finally { clearTimeout(timeout); }
          if (stopped || session!==generation || current !== this.doc.schematic) return;
          const changes: { comp: typeof current.components[number]; value: number }[] = [];
          for (const [signal, ref] of Object.entries(mapping.outputs)) {
            if (returned[signal] === undefined) throw new Error(`Missing returned signal: ${signal}.`);
            const comp = current.components.find((c) => c.refDes === ref);
            if (!comp || comp.kind !== "vdc") throw new Error(`${ref}: map to a built-in DC voltage source.`);
            changes.push({ comp, value: returned[signal] });
          }
          if (changes.some(({ comp, value }) => Number(comp.params.value) !== value)) this.updateSources(() => { for (const { comp, value } of changes) comp.params.value = String(value); });
          status.textContent = JSON.stringify({ sent: signals, received: returned }, null, 2);
          if (!stopped) timer = setTimeout(() => void exchange(), 100);
        } catch (e) { if(session!==generation)return;stop(); status.textContent = `Disconnected: ${e instanceof Error ? e.message : e}`; }
      };
      const actions = el("div"); actions.className = "dialog-actions";
      actions.append(button("Connect", () => {
        stop();
        try {
          const mapping = JSON.parse(maps.value);
          // The same validator used by saved files checks settings before committing them.
          const next = { url: url.value, inputs: mapping.inputs, outputs: mapping.outputs,mode:mode.value as 'local'|'http'|'vi',viPath:viPath.value,bits:Number(bits.value) as 32|64,timeControl:timeControl.value,program:mode.value==='local'?readProgram():config?.program };
          validateWorkspace({ labview: next });
          localRuntime=next.mode==='local'?new FlowRuntime(next.program!):undefined;
          this.commit((w) => { w.labview = next; }); stopped = false; void exchange();
        } catch (e) { status.textContent = String(e); }
      }), button("Disconnect", () => { stop(); status.textContent = "Disconnected."; }), button("Close", close));
      box.append(status, actions);
    }, stop);
  }
}
import { validateWorkspace } from "../core/engineering";
