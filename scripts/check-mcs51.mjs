// Independent differential check against SDCC's uCsim (not used by the app).
import {spawn} from 'node:child_process';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
const executable=process.env.MICROSIM_UCSIM??'C:/Program Files/SDCC/bin/s51.exe';
const reference=commands=>new Promise((resolve,reject)=>{
  const child=spawn(executable,['-q','-t','C52','-c','-'],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';
  const timeout=setTimeout(()=>{child.kill();reject(new Error('uCsim timeout'));},10000);
  child.stdout.on('data',data=>{output+=data.toString().replace(/\r/g,'');});child.stderr.on('data',data=>{output+=data.toString();});
  child.on('error',reject);child.on('close',()=>{clearTimeout(timeout);resolve(output);});child.stdin.end(commands.join('\r\n')+'\r\n');
});
const server=await createServer({configFile:false,server:{middlewareMode:true}});
let seed=12345;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
try{
  const {Mcs51}=await server.ssrLoadModule('/src/engine/mcs51.ts');let cases=0;
  for(let sample=0;sample<8;sample++)for(let first=0;first<256;first+=8){
    await Promise.all(Array.from({length:8},async(_,offset)=>{
      const op=first+offset;if(op===0xa5)return;
      const operand=[0x20,0x21,0x81,0xe0,0xd0,0x90,0xf0,0x88][sample];
      const code=new Uint8Array(65536);code.fill(255);code.set([op,operand,0x21],0x100);
      const cpu=new Mcs51(code);cpu.pc=0x100;for(let i=0;i<256;i++)cpu.ram[i]=random();
      const addresses=[0x80,0x90,0xa0,0xb0,0x81,0x82,0x83,0xd0,0xe0,0xf0];
      for(const address of addresses)cpu.write(address,address===0x81?0x3f:random());
      const commands=['reset','fill rom 0 65535 255','fill xram 0 65535 0','set memory iram 0 '+[...cpu.ram].join(' '),...addresses.map(a=>`set memory sfr ${a} ${cpu.read(a,true)}`),`set memory rom 256 ${op} ${operand} 33`,'pc 256','step 1'];
      const result=await reference(commands),context=`sample ${sample}, opcode 0x${op.toString(16)}`;
      const pc=/Stop at 0x([\da-f]+): .*stepped (\d+) ticks/i.exec(result),a=/ACC= 0x([\da-f]+)/i.exec(result),b=/ B= 0x([\da-f]+)/i.exec(result),psw=/PSW= 0x([\da-f]+)/i.exec(result),sp=/SP 0x([\da-f]+)/i.exec(result),dptr=/DPTR= 0x([\da-f]+)/i.exec(result),regs=/R0 R1 R2 R3 R4 R5 R6 R7\n\s+([\da-f ]+)\n/i.exec(result);
      assert.ok(pc&&a&&b&&psw&&sp&&dptr&&regs,context+' missing reference state: '+result.slice(-700));
      const cycles=cpu.step(),hex=m=>parseInt(m[1],16);
      assert.equal(cpu.pc,hex(pc),context+' PC');assert.equal(cycles*12,Number(pc[2]),context+' cycles');assert.equal(cpu.a,hex(a),context+' A');assert.equal(cpu.read(0xf0),hex(b),context+' B');assert.equal(cpu.psw,hex(psw),context+' PSW');assert.equal(cpu.read(0x81),hex(sp),context+' SP');assert.equal((cpu.read(0x83)<<8)|cpu.read(0x82),hex(dptr),context+' DPTR');
      const bank=cpu.psw&0x18;assert.deepEqual([...cpu.ram.slice(bank,bank+8)],regs[1].trim().split(/\s+/).map(x=>parseInt(x,16)),context+' R0–R7');
      cases++;
    }));
    if((first+8)%64===0)console.log(`Compared ${cases} instructions.`);
  }
  console.log(`PASS: ${cases} randomized one-instruction comparisons against uCsim C52 (PC, cycles, A/B, PSW, SP, DPTR, R0–R7).`);
}finally{await server.close();}
