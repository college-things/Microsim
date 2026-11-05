import {createServer} from 'vite';
import {openNiDatabase} from './ni-database.mjs';
const server=await createServer({configFile:false,server:{middlewareMode:true}});
try {
 const {niPartToDatabasePart}=await server.ssrLoadModule('/src/core/ni-database.ts');
 const {registerDatabase,databaseKind}=await server.ssrLoadModule('/src/core/component-database.ts');
 const {Doc}=await server.ssrLoadModule('/src/core/doc.ts');
 const {buildNetlist}=await server.ssrLoadModule('/src/core/netlist.ts');
 const {simulate}=await server.ssrLoadModule('/src/engine/index.ts');
 const db=await openNiDatabase(process.argv[2]);
 for(const name of ['2N3904','1N4148','LM358N']){
  const row=db.search(name).items.find(p=>p.name===name);
  const part=niPartToDatabasePart(db.part(row.id));
  registerDatabase([part]);const doc=new Doc();const c=doc.addPart(databaseKind(part),0,0);
  for(const p of c.pins)p.net='0';
  const net=buildNetlist(doc.schematic);
  const result=simulate(net.text,{type:'op'});
  console.log(JSON.stringify({name,pins:c.pins.length,errors:net.errors,warnings:result.warnings}));
 }
}finally{await server.close()}
