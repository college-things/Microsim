import {checkBoard,validateWorkspace,type Board} from './engineering';
import type {Point} from './schematic';
import {boardPads, padDrill, padSize, transform} from './pcb-geometry';
import {boardSilkscreen} from './pcb-silk';
/** RS-274X millimetres, six fractional digits. Apertures are declared before any drawing. */
export function boardFabricationFiles(board:Board):Record<string,string>{
 validateWorkspace({board});
 const errors=checkBoard(board).filter(s=>!s.startsWith('Warning:'));if(errors.length)throw new Error(`Fix PCB checks before fabrication export:\n${errors.join('\n')}`);
 if(board.width>=10000||board.height>=10000)throw new Error('Gerber export requires board dimensions below 10000 mm.');
 const pads=boardPads(board);
 const position=(p:Point)=>`X${Math.round(p.x*1e6)}Y${Math.round((board.height-p.y)*1e6)}`;
 const gerber=(kind:'F.Cu'|'B.Cu'|'F.Mask'|'B.Mask'|'F.Paste'|'F.SilkS'|'Edge.Cuts')=>{
  const mask=kind.endsWith('Mask'),outline=kind==='Edge.Cuts',paste=kind==='F.Paste',silk=kind==='F.SilkS',layer=kind[0]==='F'?'F.Cu':'B.Cu';
  const declarations:string[]=[],macros:string[]=[],commands:string[]=[],ids=new Map<string,number>();
  const define=(key:string,body:(id:number)=>string)=>{let id=ids.get(key);if(id===undefined){id=10+ids.size;ids.set(key,id);declarations.push(body(id));}commands.push(`D${id}*`);};
  const circle=(d:number)=>define(`C${d}`,id=>`%ADD${id}C,${d.toFixed(6)}*%`);
  const pad=(q:typeof pads[number],expand=0)=>{
   const size=padSize(q.p),w=size.x+2*expand,h=size.y+2*expand,shape=q.p.shape??'circle',angle=-q.f.rotation;
   const quarter=Math.abs(angle/90-Math.round(angle/90))<1e-8,swap=Math.abs(Math.round(angle/90)%2)===1;
   if(shape==='circle')circle(w);
   else if((shape==='rect'||shape==='oval')&&quarter)define(`${shape}${swap?h:w},${swap?w:h}`,id=>`%ADD${id}${shape==='rect'?'R':'O'},${(swap?h:w).toFixed(6)}X${(swap?w:h).toFixed(6)}*%`);
   else define(`${shape}${w},${h},${angle}`,id=>{
    const name=`PAD${id}`,r=shape==='rect'?0:shape==='oval'?Math.min(w,h)/2:Math.min(size.x,size.y)*0.25+expand;
    const primitives:string[]=[];
    if(w-2*r>0)primitives.push(`21,1,${(w-2*r).toFixed(6)},${h.toFixed(6)},0,0,${angle.toFixed(6)}*`);
    if(h-2*r>0)primitives.push(`21,1,${w.toFixed(6)},${(h-2*r).toFixed(6)},0,0,${angle.toFixed(6)}*`);
    if(r>0)for(const x of [-w/2+r,w/2-r])for(const y of [-h/2+r,h/2-r]){const p=transform({x:0,y:0,rotation:angle},{x,y});primitives.push(`1,1,${(2*r).toFixed(6)},${p.x.toFixed(6)},${p.y.toFixed(6)},0*`);}
    macros.push(`%AM${name}*${primitives.join('')}%`);return `%ADD${id}${name}*%`;
   });
   commands.push(position(q.at)+'D03*');
  };
  const stroke=(points:Point[],w:number)=>{circle(w);points.forEach((p,i)=>commands.push(position(p)+(i?'D01*':'D02*')));};
  const region=(points:Point[])=>{circle(0.01);commands.push('G36*');[...points,points[0]].forEach((p,i)=>commands.push(position(p)+(i?'D01*':'D02*')));commands.push('G37*');};
  if(outline)stroke([{x:0,y:0},{x:board.width,y:0},{x:board.width,y:board.height},{x:0,y:board.height},{x:0,y:0}],0.05);
  else if(silk)for(const s of boardSilkscreen(board))stroke([s.a,s.b],s.width);
  else{
   if(!mask&&!paste)for(const z of (board.zones??[]).filter(z=>z.layer===kind)){
    commands.push('%LPD*%');region(z.outline);commands.push('%LPC*%');
    for(const p of pads)if(p.net!==z.net&&p.layers.includes(layer))pad(p,board.clearance);
    for(const t of board.tracks)if(t.net!==z.net&&t.layer===layer)stroke(t.points,t.width+2*board.clearance);
    for(const k of board.keepouts??[])if(k.layer===layer||k.layer==='both'){region(k.outline);stroke([...k.outline,k.outline[0]],board.clearance*2);}
    commands.push('%LPD*%');
   }
   for(const p of pads)if(p.layers.includes(layer)&&(!paste||padDrill(p.p)===undefined))pad(p,mask?0.05:0);
   if(!mask&&!paste)for(const t of board.tracks.filter(t=>t.layer===kind))stroke(t.points,t.width);
  }
  const fileFunction=outline?'Profile,NP':silk?'Legend,Top':paste?'Paste,Top':mask?`Soldermask,${kind[0]==='F'?'Top':'Bot'}`:`Copper,${kind[0]==='F'?'L1,Top':'L2,Bot'}`;
  return ['G04 Microsim PCB export*','%FSLAX46Y46*%','%MOMM*%',`%TF.FileFunction,${fileFunction}*%`,`%TF.FilePolarity,${mask?'Negative':'Positive'}*%`,...macros,...declarations,'%LPD*%','G01*',...commands,'M02*',''].join('\n');
 };
 const drilled=pads.filter(p=>padDrill(p.p)!==undefined),drills=[...new Set(drilled.map(p=>padDrill(p.p)!))].sort((a,b)=>a-b);
 const drill=['M48',';FILE_FORMAT=4:6',';TYPE=PLATED','METRIC,LZ','G90',...drills.map((d,i)=>`T${i+1}C${d.toFixed(6)}`),'%','G05'];
 drills.forEach((d,i)=>{drill.push(`T${i+1}`);for(const p of drilled.filter(p=>padDrill(p.p)===d))drill.push(`X${p.at.x.toFixed(6)}Y${(board.height-p.at.y).toFixed(6)}`);});
 drill.push('M30','');
 return {'front-copper.gtl':gerber('F.Cu'),'back-copper.gbl':gerber('B.Cu'),'front-mask.gts':gerber('F.Mask'),'back-mask.gbs':gerber('B.Mask'),'front-paste.gtp':gerber('F.Paste'),'front-silkscreen.gto':gerber('F.SilkS'),'outline.gko':gerber('Edge.Cuts'),'plated-drills.drl':drill.join('\n'),'README.txt':'Two-layer board; units mm. Top SMD paste, mask openings expanded by 0.05 mm per side. Plated drills exclude SMD pads. Pours join their net directly; floating islands are retained. Check warnings, real package/pinout and the complete set in an independent viewer before ordering.\n'};
}
/** Uncompressed ZIP, with CRC32, for one browser download containing the fabrication set. */
export function fabricationZip(files:Record<string,string>):Uint8Array{
 const encoder=new TextEncoder(),chunks:Uint8Array[]=[],directory:Uint8Array[]=[];let offset=0;
 const crc=(bytes:Uint8Array)=>{let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=c>>>1^(c&1?0xedb88320:0);}return (c^0xffffffff)>>>0;};
 const header=(size:number)=>{const b=new Uint8Array(size);return {b,v:new DataView(b.buffer)};};
 for(const [name,text]of Object.entries(files)){
  if(!/^[a-zA-Z0-9_.-]+$/.test(name))throw new Error('Use a plain fabrication filename.');
  const filename=encoder.encode(name),data=encoder.encode(text),checksum=crc(data);
  const local=header(30+filename.length);local.v.setUint32(0,0x04034b50,true);local.v.setUint16(4,20,true);local.v.setUint16(12,33,true);local.v.setUint32(14,checksum,true);local.v.setUint32(18,data.length,true);local.v.setUint32(22,data.length,true);local.v.setUint16(26,filename.length,true);local.b.set(filename,30);
  const central=header(46+filename.length);central.v.setUint32(0,0x02014b50,true);central.v.setUint16(4,20,true);central.v.setUint16(6,20,true);central.v.setUint16(14,33,true);central.v.setUint32(16,checksum,true);central.v.setUint32(20,data.length,true);central.v.setUint32(24,data.length,true);central.v.setUint16(28,filename.length,true);central.v.setUint32(42,offset,true);central.b.set(filename,46);
  chunks.push(local.b,data);directory.push(central.b);offset+=local.b.length+data.length;
 }
 const size=directory.reduce((n,c)=>n+c.length,0),end=header(22);end.v.setUint32(0,0x06054b50,true);end.v.setUint16(8,directory.length,true);end.v.setUint16(10,directory.length,true);end.v.setUint32(12,size,true);end.v.setUint32(16,offset,true);
 const result=new Uint8Array(offset+size+22);let at=0;for(const chunk of [...chunks,...directory,end.b]){result.set(chunk,at);at+=chunk.length;}return result;
}
