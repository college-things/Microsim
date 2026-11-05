import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {buildDesign} from './design-bridge.mjs';
const server=await createServer({configFile:false,server:{middlewareMode:true}});
try{
  const {readIntelHex,programHex}=await server.ssrLoadModule('/src/engine/ihex.ts');
  const {simulate}=await server.ssrLoadModule('/src/engine/index.ts');
  const {Doc}=await server.ssrLoadModule('/src/core/doc.ts');
  const {buildNetlist}=await server.ssrLoadModule('/src/core/netlist.ts');
  const {serializeMs14}=await server.ssrLoadModule('/src/importer/writer.ts');
  const {importMs14}=await server.ssrLoadModule('/src/importer/index.ts');
  const source='#include <8051.h>\nvoid main(void){unsigned char i;P1=0;while(1){P1^=1;for(i=0;i<8;i++){__asm nop __endasm;}}}';
  const result=await buildDesign({action:'c',source});const hex=result.files.find(f=>f.name==='firmware.hex').contents;
  const code=readIntelHex(hex);let end=code.length;while(end>1&&code[end-1]===255)end--;
  const doc=new Doc(),mcu=doc.addPart('mcu8051',0,0);mcu.params.code=programHex(code.slice(0,end));mcu.pins.find(p=>p.name==='P1.0').net='out';mcu.pins.find(p=>p.name==='RST').net='0';
  const resistor=doc.addPart('resistor',200,0,{value:'100k'});resistor.pins[0].net='out';resistor.pins[1].net='0';
  const restored=importMs14(serializeMs14({schematic:doc.schematic,analyses:[],issues:[]})).schematic;
  const netlist=buildNetlist(restored);assert.deepEqual(netlist.errors,[]);
  const data=simulate(netlist.text,{type:'tran',tstop:5e-3,tstep:1e-6,tmax:1e-6});
  assert.deepEqual(data.warnings.filter(s=>/unsupported|ignored/i.test(s)),[]);
  const waveform=data.vectors.find(v=>v.name==='v(out)').re;
  let edges=0;for(let i=1;i<waveform.length;i++)if((waveform[i]>2.5)!==(waveform[i-1]>2.5))edges++;
  assert.ok(Math.min(...waveform)<.1);assert.ok(Math.max(...waveform)>4);assert.ok(edges>=4,`expected GPIO switching, got ${edges} edges`);
  console.log(`PASS: real SDCC C → Intel HEX → saved/reopened .ms14 → transient GPIO driving a resistor (${end} program bytes, ${edges} edges).`);
}finally{await server.close();}
