import {checkBoard,padPosition,validateWorkspace,type Board} from './engineering';
import type {Point} from './schematic';
/** Two copper layers, soldermask openings, board profile and plated NC drills. Units: mm. */
export function boardFabricationFiles(board:Board):Record<string,string>{
 validateWorkspace({board});
 const errors=checkBoard(board);if(errors.length)throw new Error(`Fix PCB checks before fabrication export:\n${errors.join('\n')}`);
 const pads=[...board.footprints.flatMap(f=>f.pads.map(p=>({...padPosition(f,p),diameter:p.diameter??1.6,drill:p.drill??0.8}))),...(board.vias??[])];
 const position=(p:Point)=>`X${Math.round(p.x*1e6)}Y${Math.round((board.height-p.y)*1e6)}`;
 const gerber=(kind:'F.Cu'|'B.Cu'|'F.Mask'|'B.Mask'|'Edge.Cuts')=>{
  const mask=kind.endsWith('Mask'),outline=kind==='Edge.Cuts';
  const tracks=board.tracks.filter(t=>t.layer===kind);
  const widths=[...new Set(outline?[0.05]:[...pads.map(p=>p.diameter+(mask?0.1:0)),...tracks.map(t=>t.width)])];
  const aperture=(width:number)=>`D${widths.indexOf(width)+10}*`;
  const fileFunction=outline?'Profile,NP':mask?`Soldermask,${kind[0]==='F'?'Top':'Bot'}`:`Copper,${kind[0]==='F'?'L1,Top':'L2,Bot'}`;
  const lines=['G04 Microsim PCB export*','%FSLAX46Y46*%','%MOMM*%',`%TF.FileFunction,${fileFunction}*%`,`%TF.FilePolarity,${mask?'Negative':'Positive'}*%`,'%LPD*%',...widths.map((w,i)=>`%ADD${10+i}C,${w.toFixed(6)}*%`),'G01*'];
  if(outline){lines.push(aperture(0.05));const corners=[{x:0,y:0},{x:board.width,y:0},{x:board.width,y:board.height},{x:0,y:board.height},{x:0,y:0}];corners.forEach((p,i)=>lines.push(position(p)+(i?'D01*':'D02*')));}
  else{
   for(const p of pads)lines.push(aperture(p.diameter+(mask?0.1:0)),position(p)+'D03*');
   for(const t of tracks){lines.push(aperture(t.width));t.points.forEach((p,i)=>lines.push(position(p)+(i?'D01*':'D02*')));}
  }
  return lines.concat('M02*','').join('\n');
 };
 const drills=[...new Set(pads.map(p=>p.drill))].sort((a,b)=>a-b);
 const drill=['M48',';FILE_FORMAT=4:6',';TYPE=PLATED','METRIC,LZ','G90',...drills.map((d,i)=>`T${i+1}C${d.toFixed(6)}`),'%','G05'];
 drills.forEach((d,i)=>{drill.push(`T${i+1}`);for(const p of pads.filter(p=>p.drill===d))drill.push(`X${p.x.toFixed(6)}Y${(board.height-p.y).toFixed(6)}`);});
 drill.push('M30','');
 return {'front-copper.gtl':gerber('F.Cu'),'back-copper.gbl':gerber('B.Cu'),'front-mask.gts':gerber('F.Mask'),'back-mask.gbs':gerber('B.Mask'),'outline.gko':gerber('Edge.Cuts'),'plated-drills.drl':drill.join('\n'),'README.txt':'Two-layer plated through-hole board. Coordinates and drills use millimetres. Mask openings expand copper diameter by 0.10 mm. Verify the complete set in an independent Gerber viewer and match every footprint to its physical component before ordering.\n'};
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
