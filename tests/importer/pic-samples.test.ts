// Installed samples are read only during tests; no vendor source or circuit is stored or printed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Doc } from '../../src/core/doc';
import { unsimulatedParts } from '../../src/core/limits';
import { convertNiMcus } from '../../src/importer/mcu';
import { programHex } from '../../src/engine/ihex';
import { serializeMs14 } from '../../src/importer/writer';
import { importMs14 } from '../../src/importer';
import { assemblePic } from '../../src/engine/asmpic';
import { Pic16, picWords, type PicVariant } from '../../src/engine/pic16';
import { gpasm, compareGpasm } from '../engine/pic-tools';
const root='C:/Users/Public/Documents/National Instruments/Circuit Design Suite 14.2/samples/MCU/PIC samples';
const walk=(dir:string):string[]=>readdirSync(dir).flatMap(n=>{const p=join(dir,n);return statSync(p).isDirectory()?walk(p):[p];});
describe('NI PIC pin conversion',()=>{
  it.each(['pic16f84a','pic16f877a'])('maps %s by port name and keeps the workspace and frequency',kind=>{
    const doc=new Doc(),comp=doc.addPart(kind,0,0);comp.kind='imported';comp.params={};
    comp.pins.forEach(p=>{p.name+='/ALT';});
    comp.spice=`a{ref} [] [] cpu\n.model cpu d_cpupic (cpu_part_id="${kind}" clock_freq=8000000)`;
    convertNiMcus([comp],'Value="&amp;ASCDemo\\Demo.mcuws" <SWsTreeItem Name="&amp;ASCdemo.asm">',[]);
    expect(comp.params).toMatchObject({mcu:'pic16',variant:kind,frequency:'8000000',workspace:'Demo\\Demo.mcuws',sources:'demo.asm'});
    expect(comp.spice).toContain('d_mcupic16');expect(comp.spice).toContain('{pin:MCLR/ALT}');expect(comp.spice).toContain('{pin:RB7/ALT}');
    expect(unsimulatedParts(doc.schematic).some(s=>/has no program loaded/.test(s))).toBe(true);
  });
});
describe.skipIf(!existsSync(root))('installed NI PIC samples',()=>{
  const files=existsSync(root)?walk(root):[];
  for(const file of files.filter(f=>/\.ms14$/i.test(f)))it(basename(file)+': converts and assembles',()=>{
    const result=importMs14(new Uint8Array(readFileSync(file)),{retainSource:true});
    const mcus=result.schematic.components.filter(c=>c.params.mcu==='pic16');
    expect(mcus.length,'PIC conversion').toBeGreaterThan(0);
    for(const comp of mcus){
      const workspace=join(dirname(file),(comp.params.workspace??'').replace(/\\/g,'/'));
      const names=(comp.params.sources??'').split(';');
      const sources=files.filter(f=>/\.asm$/i.test(f)&&names.some(n=>basename(f).toLowerCase()===n.toLowerCase())&&f.startsWith(dirname(workspace)));
      expect(sources.length,'workspace source count').toBeGreaterThan(0);
      for(const source of sources){
        const variant=comp.params.variant as PicVariant;
        const text=readFileSync(source,'latin1');
        const assembly=assemblePic(text,variant);
        if(gpasm)compareGpasm(assembly,variant,{file:source});
        comp.params.code=programHex(assembly.code);comp.params.asm=text;
        if(assembly.config!==undefined)comp.params.config=String(assembly.config);
        const reopened=importMs14(serializeMs14({schematic:result.schematic,analyses:[],issues:[]}));
        const saved=reopened.schematic.components.find(c=>c.id===comp.id)!;
        expect(saved.params.code===comp.params.code,'firmware round trip').toBe(true);
        expect(saved.params.asm===text,'source round trip').toBe(true);
        expect(saved.params.config===comp.params.config,'configuration round trip').toBe(true);
        const cpu=new Pic16(picWords(assembly.code,variant),variant,()=>255,assembly.config);
        let unsupported='';
        try{for(let i=0;i<100000;i++)cpu.step();}catch(e){const message=e instanceof Error?e.message:'';if(!/not implemented/.test(message))throw e;unsupported=message;}
        const expected=/LCDDisplay|WriteReadEEDATA/i.test(file)?'PIC16: EEPROM is not implemented.':/WatchdogTimerWakeup/i.test(file)?'PIC16: watchdog timer is not implemented.':'';
        expect(unsupported,'required peripheral boundary').toBe(expected);
        console.info(`${basename(file)} / ${basename(source)}: ${assembly.listing.length} listing entries; ${unsupported||'supported execution (100000 steps)'}`);
      }
    }
  });
});
