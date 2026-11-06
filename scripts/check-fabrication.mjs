import {createServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
if(!process.argv[2])throw new Error('Usage: node scripts/check-fabrication.mjs output-directory');
const server=await createServer({configFile:false,server:{middlewareMode:true}});
try{
 const {boardFabricationFiles,fabricationZip}=await server.ssrLoadModule('/src/core/fabrication.ts');
 const {boardToKicad}=await server.ssrLoadModule('/src/core/engineering.ts');
 const {FOOTPRINTS}=await server.ssrLoadModule('/src/core/footprints.ts');
 const b={width:60,height:40,clearance:0.25,footprints:[{component:'a',ref:'J1',x:10,y:10,rotation:90,pads:[{pin:'1',net:'signal',x:0,y:0,diameter:2,drill:1}]},{component:'b',ref:'J2',x:40,y:10,rotation:0,pads:[{pin:'1',net:'signal',x:0,y:0}]}],vias:[{x:25,y:10,net:'signal',diameter:0.8,drill:0.4}],tracks:[{net:'signal',layer:'F.Cu',width:0.4,points:[{x:10,y:10},{x:25,y:10}]},{net:'signal',layer:'B.Cu',width:0.4,points:[{x:25,y:10},{x:40,y:10}]}]};
 // Exercise a rotated rounded SMD aperture, stroke silk and dark/clear back pour as well as legacy pads.
 const chip=FOOTPRINTS['0603'];
 b.footprints.push({component:'smd',ref:'R1',name:chip.name,x:10,y:25,rotation:30,outline:chip.outline,pads:chip.pads.map(p=>({...p,net:`smd_${p.number}`}))});
 b.footprints.push({component:'ground',ref:'J3',x:40,y:30,rotation:0,pads:[{pin:'1',net:'gnd',x:0,y:0}]});
 b.zones=[{net:'gnd',layer:'B.Cu',outline:[{x:1,y:1},{x:59,y:1},{x:59,y:39},{x:1,y:39}]}];
 const files=boardFabricationFiles(b);await mkdir(process.argv[2],{recursive:true});
 for(const [name,text]of Object.entries(files))await writeFile(join(process.argv[2],name),text);
 await writeFile(join(process.argv[2],'fabrication.zip'),fabricationZip(files));
 await writeFile(join(process.argv[2],'board.kicad_pcb'),boardToKicad(b));
 console.log('Wrote fabrication fixture and ZIP.');
}finally{await server.close()}
