import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildDesign} from './design-bridge.mjs';
import {resolveTool} from './toolchain.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const integration={skip:process.env.MICROSIM_TEST_TOOLS!=='1',timeout:300000};
test('tool overrides win and invalid tool keys cannot launch executables',()=>{
 assert.equal(resolveTool('ghdl',{MICROSIM_GHDL:'custom-ghdl'}),'custom-ghdl');
 assert.throws(()=>resolveTool('shell'),/Unsupported/);
});
test('installed SDCC compiles headers and produces checksummed executable Intel HEX',integration,async()=>{
 const result=await buildDesign({action:'c',source:'#include <8051.h>\nvoid main(void){volatile unsigned int i;while(1){P1^=1;for(i=0;i<500;i++){}}}'});
 const text=result.files[0].contents;let code=0;
 for(const line of text.trim().split(/\r?\n/)){assert.match(line,/^:[0-9A-Fa-f]+$/);const bytes=Buffer.from(line.slice(1),'hex');assert.equal([...bytes].reduce((a,b)=>a+b,0)&255,0);if(bytes[3]===0)code+=bytes[0];}
 assert.ok(code>50);assert.match(text,/:00000001FF/i);
});
test('installed GHDL simulates to 1 us and rejects invalid VHDL',integration,async()=>{
 const result=await buildDesign({action:'vhdl-sim',top:'tb',source:"entity tb is end; architecture sim of tb is signal clk: bit := '0'; begin clk <= not clk after 5 ns; end;"});
 assert.match(result.files[0].contents,/\$enddefinitions/);assert.match(result.files[0].contents,/#1000000000/);
 await assert.rejects(buildDesign({action:'vhdl-check',top:'bad',source:'entity bad is port;'}),/ghdl:/);
});
test('installed FPGA tools produce a packed HX1K bitstream',integration,async()=>{
 const result=await buildDesign({action:'fpga',top:'top',source:'library ieee; use ieee.std_logic_1164.all; entity top is port(a:in std_logic; b:out std_logic); end; architecture rtl of top is begin b<=not a; end;',constraints:'set_io a 1\nset_io b 2\n'});
 assert.ok(JSON.parse(result.files[0].contents).modules.top);
 const binary=Buffer.from(result.files.find(f=>f.name==='design.bin').contents,'base64');assert.ok(binary.length>1000);assert.ok(binary.includes(Buffer.from([0x7e,0xaa,0x99,0x7e])));
 if(process.env.MICROSIM_TEST_ARTIFACTS){await mkdir(process.env.MICROSIM_TEST_ARTIFACTS,{recursive:true});for(const f of result.files)await writeFile(join(process.env.MICROSIM_TEST_ARTIFACTS,f.name),f.encoding==='base64'?Buffer.from(f.contents,'base64'):f.contents);await writeFile(join(process.env.MICROSIM_TEST_ARTIFACTS,'build.log'),result.log);}
});
