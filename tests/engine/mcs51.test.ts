import {describe,it,expect} from 'vitest';
import {Mcs51} from '../../src/engine/mcs51';
import {readIntelHex,programHex} from '../../src/engine/ihex';
import {simulate,createLiveSession} from '../../src/engine';
import {at} from './helpers';

describe('classic 8051 interpreter',()=>{
  it('decodes every defined opcode, and rejects the reserved opcode',()=>{
    for(let op=0;op<256;op++){
      const cpu=new Mcs51(Uint8Array.from([op,0,0,0]));
      if(op===0xa5)expect(()=>cpu.step()).toThrow('reserved opcode');
      else expect(cpu.step(),`opcode ${op.toString(16)}`).toBeGreaterThanOrEqual(1);
    }
  });
  it('matches carry, auxiliary carry, signed overflow and parity for all ADD/ADDC/SUBB byte pairs',()=>{
    const cpu=new Mcs51(new Uint8Array([0x34,0]));
    for(const subtract of [false,true])for(let carry=0;carry<2;carry++)for(let a=0;a<256;a++)for(let b=0;b<256;b++){
      cpu.pc=0;cpu.code[0]=subtract?0x94:0x34;cpu.code[1]=b;cpu.a=a;cpu.psw=carry<<7;cpu.step();
      const value=subtract?a-b-carry:a+b+carry,signed=(a<128?a:a-256)+(subtract?-1:1)*(b<128?b:b-256)+(subtract?-carry:carry);
      const expected=(value<0||value>255?128:0)|((subtract?(a&15)-(b&15)-carry<0:(a&15)+(b&15)+carry>15)?64:0)|(signed< -128||signed>127?4:0)|((value&255).toString(2).replace(/0/g,'').length%2);
      if(cpu.a!==(value&255)||cpu.psw!==expected)throw new Error(`flags mismatch: ${subtract?'SUBB':'ADDC'} ${a},${b},C=${carry}: A=${cpu.a}, PSW=${cpu.psw}; expected ${value&255},${expected}`);
    }
  });
  it('keeps indirect upper RAM separate from SFRs and changes register banks',()=>{
    const cpu=new Mcs51(Uint8Array.from([0x78,0x90,0x76,0x12,0x75,0x90,0x34,0x75,0xd0,0x08,0x78,0x56]));
    for(let n=0;n<5;n++)cpu.step();
    expect(cpu.ram[0x90]).toBe(0x12);expect(cpu.latch(1)).toBe(0x34);expect(cpu.ram[0]).toBe(0x90);expect(cpu.ram[8]).toBe(0x56);
  });
  it('uses pin values for reads and port latches for read-modify-write',()=>{
    const cpu=new Mcs51(Uint8Array.from([0xe5,0x90,0x43,0x90,1,0xb2,0x90]),()=>0);
    cpu.step();expect(cpu.a).toBe(0);cpu.step();expect(cpu.latch(1)).toBe(255);cpu.step();expect(cpu.latch(1)).toBe(254);
  });
  it('uses post-instruction PC pages for AJMP and returns to the byte after a call',()=>{
    const cpu=new Mcs51(Uint8Array.from([0x12,0,6,0x74,0x99,0,0x74,0x42,0x22]));
    cpu.step();cpu.step();expect(cpu.a).toBe(0x42);cpu.step();expect(cpu.pc).toBe(3);cpu.step();expect(cpu.a).toBe(0x99);expect(cpu.read(0x81)).toBe(7);
    cpu.pc=0x7ff;cpu.code[0x7ff]=1;cpu.code[0x800]=0x23;cpu.step();expect(cpu.pc).toBe(0x823);
  });
  it('corrects all packed BCD additions with decimal adjust',()=>{
    const cpu=new Mcs51(Uint8Array.from([0x24,0,0xd4]));const bcd=(x:number)=>Math.floor(x/10)*16+x%10;
    for(let a=0;a<100;a++)for(let b=0;b<100;b++){
      cpu.pc=0;cpu.a=bcd(a);cpu.psw=0;cpu.code[1]=bcd(b);cpu.step();cpu.step();
      if(cpu.a!==bcd((a+b)%100)||cpu.carry!==(a+b>=100?1:0))throw new Error(`BCD mismatch ${a}+${b}`);
    }
  });
  it('reloads timer mode 2 and services its interrupt through RETI',()=>{
    const code=new Uint8Array(64);code.set([0x75,0x89,2,0x75,0x8c,0xfe,0x75,0x8a,0xfe,0x75,0xa8,0x82,0xd2,0x8c,0x80,0xfe],0x20);code.set([0xb2,0x90,0x32],0xb);
    const cpu=new Mcs51(code);cpu.pc=0x20;for(let n=0;n<5;n++)cpu.step();expect(cpu.read(0x88)&32).toBe(0);
    cpu.step();expect(cpu.read(0x88)&32).toBe(32);cpu.step();expect(cpu.pc).toBe(0xb);cpu.step();expect(cpu.latch(1)).toBe(254);cpu.step();expect(cpu.pc).toBe(0x2e);
  });
  it('preserves RAM on external reset and copies execution state without sharing arrays',()=>{
    const cpu=new Mcs51(Uint8Array.from([0x04]));cpu.step();cpu.ram[12]=45;const next=new Mcs51(cpu.code);next.copyState(cpu);next.ram[12]=99;expect(cpu.ram[12]).toBe(45);expect(next.a).toBe(1);
    cpu.reset(false);expect(cpu.ram[12]).toBe(45);expect(cpu.a).toBe(0);expect(cpu.pc).toBe(0);expect(cpu.latch(3)).toBe(255);
  });
  it('handles PUSH SP and lets one instruction run after RETI before another interrupt',()=>{
    const cpu=new Mcs51(Uint8Array.from([0xc0,0x81]));cpu.step();expect(cpu.ram[8]).toBe(8);
    const code=new Uint8Array(64);code[0xb]=0x32;code[0x30]=0x04;const irq=new Mcs51(code);irq.pc=0x30;irq.write(0xa8,0x82);irq.step();irq.write(0x88,0x20);irq.step();expect(irq.pc).toBe(0xb);irq.step();irq.write(0x88,0x20);const before=irq.a;irq.step();expect(irq.a).toBe(before);expect(irq.pc).toBe(0x32);irq.step();expect(irq.pc).toBe(0xb);
  });
});
describe('8051 serial port',()=>{
  // TMOD=0x20, TH1=TL1=0xFF, SMOD=1, SCON=0x50 (mode 1, REN), SETB TR1: 1 bit = 16 machine cycles.
  const setup=[0x75,0x89,0x20,0x75,0x8d,0xff,0x75,0x8b,0xff,0x43,0x87,0x80,0x75,0x98,0x50,0xd2,0x8e];
  const loopback=(cpu:()=>Mcs51)=>(port:number)=>{if(port!==3)return 255;const out=cpu().output(3);return (out&~1)|((out>>>1)&1);};
  it('transmits a mode-1 frame on TXD and receives it back through RXD',()=>{
    let cpu!:Mcs51;
    cpu=new Mcs51(Uint8Array.from([...setup,0x75,0x99,0xa5,0x30,0x98,0xfd,0xe5,0x99,0x80,0xfe]),loopback(()=>cpu));
    const txd:number[]=[];let guard=0;
    while(cpu.pc!==setup.length+8&&guard++<5000){cpu.step();txd.push((cpu.output(3)>>>1)&1);}
    expect(cpu.a).toBe(0xa5);expect(cpu.read(0x98,true)&3).toBe(3);expect(cpu.transmitted).toEqual([0xa5]);
    expect(txd.indexOf(0)).toBeGreaterThan(-1);expect(cpu.cycles).toBeGreaterThan(150);expect(cpu.cycles).toBeLessThan(200);
  });
  it('ignores a mode-3 frame with a clear ninth bit when SM2 is set, and accepts one with it set',()=>{
    for(const tb8 of [0,1]){
      let cpu!:Mcs51;
      // SCON=0xF0|TB8<<3: mode 3, SM2, REN. Wait for TI, then wait long enough for a reception.
      const code=[...setup.slice(0,12),0x75,0x98,0xf0|(tb8<<3),0xd2,0x8e,0x75,0x99,0x3c,0x30,0x99,0xfd,0x7f,0x40,0xdf,0xfe,0x80,0xfe];
      cpu=new Mcs51(Uint8Array.from(code),loopback(()=>cpu));
      for(let n=0;n<600;n++)cpu.step();
      expect(cpu.read(0x98,true)&1).toBe(tb8);
      if(tb8)expect(cpu.read(0x99)).toBe(0x3c);
    }
  });
  it('completes a mode-0 shift in eight machine cycles',()=>{
    const cpu=new Mcs51(Uint8Array.from([0x75,0x99,0x81,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]));
    cpu.step();expect(cpu.read(0x98,true)&2).toBe(0);for(let n=0;n<8;n++)cpu.step();expect(cpu.read(0x98,true)&2).toBe(2);
  });
  it('produces a decodable UART waveform on the P3.1 circuit pin',()=>{
    const pins=Array.from({length:32},(_,i)=>`p${i}`).join(' ');
    const hex=[...setup,0x75,0x99,0x4b,0x80,0xfe].map(b=>b.toString(16).padStart(2,'0')).join('');
    const data=simulate(`* UART
A1 [${pins}] 0 cpu
.model cpu d_mcu8051(program="${hex}" frequency=12Meg)
Rload p25 0 100k
.end`,{type:'tran',tstep:.5e-6,tstop:220e-6,tmax:.5e-6});
    let start=0;for(let t=0;t<60e-6;t+=.5e-6)if(at(data,'v(p25)',t)<1){start=t;break;}
    expect(start).toBeGreaterThan(0);
    const bits:number[]=Array.from({length:10},(_,n)=>at(data,'v(p25)',start+(n+.5)*16e-6)>2.5?1:0);
    expect(bits[0]).toBe(0);expect(bits[9]).toBe(1);
    expect(bits.slice(1,9).reduce((v,b,n)=>v|(b<<n),0)).toBe(0x4b);
  });
});
describe('Intel HEX and circuit execution',()=>{
  const record=(address:number,type:number,data:number[])=>{const b=[data.length,address>>>8,address&255,type,...data];b.push((-b.reduce((a,b)=>a+b,0))&255);return ':'+b.map(v=>v.toString(16).padStart(2,'0')).join('');};
  it('checks checksums, segment addresses, overlapping data and EOF',()=>{
    const text=record(0,2,[0,1])+'\n'+record(0,0,[0x74,42])+'\n'+record(0,1,[]);const program=readIntelHex(text);expect(program[16]).toBe(0x74);expect(program[17]).toBe(42);expect(programHex(program).length).toBe(131072);
    expect(()=>readIntelHex(text.replace('742a','742b'))).toThrow('checksum');
    expect(()=>readIntelHex(record(0,0,[1])+'\n'+record(0,0,[2])+'\n'+record(0,1,[]))).toThrow('overlap');
    expect(()=>readIntelHex(record(0,0,[1]))).toThrow('end record');
    expect(()=>readIntelHex(record(0,4,[0,1])+'\n'+record(0,0,[1])+'\n'+record(0,1,[]))).toThrow('64 KiB');
  });
  it('executes firmware at instruction boundaries and drives a real resistor-connected circuit',()=>{
    const pins=Array.from({length:32},(_,i)=>`p${i}`).join(' ');
    const result=simulate(`* firmware test\nA1 [${pins}] 0 cpu\n.model cpu d_mcu8051(program="759000b29080fc" frequency=12Meg)\nRload p8 0 100k\n.end`,{type:'tran',tstep:0.2e-6,tstop:12e-6,tmax:0.2e-6});
    expect(result.warnings.filter(s=>/unsupported|ignored/i.test(s))).toEqual([]);
    expect(at(result,'v(p8)',2.5e-6)).toBeLessThan(0.1);
    expect(at(result,'v(p8)',3.5e-6)).toBeGreaterThan(4);
    expect(at(result,'v(p8)',6.5e-6)).toBeLessThan(0.1);
  });
  it('preserves firmware state during live analog updates, and restarts after firmware changes',()=>{
    const pins=Array.from({length:32},(_,i)=>`p${i}`).join(' ');
    const deck=(resistor:string,code='759000b29080fc')=>`* MCU live\nA1 [${pins}] 0 cpu\n.model cpu d_mcu8051(program="${code}" frequency=12Meg)\nRload p8 0 ${resistor}\n.end`;
    const session=createLiveSession(deck('100k'),{tmax:.2e-6});session.advance(4e-6,1000);
    expect(session.update(deck('200k'))).toBe(true);const after=session.advance(8e-6,1000);expect(after.time[after.time.length-1]).toBeGreaterThanOrEqual(8e-6);
    expect(session.update(deck('200k','020000'))).toBe(false);
  });
  it('samples analog input pins and releases ports while active-high reset is asserted',()=>{
    const pins=Array.from({length:32},(_,i)=>`p${i}`).join(' ');
    const data=simulate(`* GPIO input and reset\nA1 [${pins}] reset cpu\n.model cpu d_mcu8051(program="e590f5a080fa" frequency=12Meg)\nVin p8 0 PULSE(0 5 5u 1n 1n 10u 30u)\nVreset reset 0 PULSE(0 5 20u 1n 1n 10u 60u)\nRout p16 0 100k\n.end`,{type:'tran',tstop:35e-6,tstep:.1e-6,tmax:.1e-6});
    expect(at(data,'v(p16)',4e-6)).toBeLessThan(.1);expect(at(data,'v(p16)',14e-6)).toBeGreaterThan(4);expect(at(data,'v(p16)',19.5e-6)).toBeLessThan(.1);expect(at(data,'v(p16)',25e-6)).toBeGreaterThan(4);
  });
});
