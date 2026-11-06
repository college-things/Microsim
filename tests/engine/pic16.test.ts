import { describe, expect, it } from 'vitest';
import { readIntelHex } from '../../src/engine/ihex';
import { Pic16, picWords } from '../../src/engine/pic16';
const cpu=(...words:number[])=>new Pic16(Uint16Array.from(words));
const run=(op:number,f=0,w=0,status=0x18)=>{const c=cpu(op);c.ram[0x20]=f;c.w=w;c.status=status;c.step();return c;};
describe('PIC16 instruction set',()=>{
  it('checks every ADDWF/SUBWF operand pair, including digit carry and no-borrow carry',()=>{
    const c=cpu(0x0720),s=cpu(0x0220);
    for(let a=0;a<256;a++)for(let b=0;b<256;b++)for(const [chip,sub] of [[c,false],[s,true]] as const){
      chip.pc=0;chip.status=0x18;chip.ram[0x20]=a;chip.w=b;chip.step();
      const r=sub?a-b:a+b,flags=((sub?a>=b:r>255)?1:0)|((sub?(a&15)>=(b&15):(a&15)+(b&15)>15)?2:0)|(!(r&255)?4:0);
      if(chip.w!==(r&255)||(chip.status&7)!==flags)throw new Error('arithmetic/flag mismatch');
    }
  });
  it.each([
    ['ANDWF',0x0520,0x55,0x0f,5,0],['IORWF',0x0420,0x50,0x0f,0x5f,0],['XORWF',0x0620,0x55,0x55,0,4],
    ['COMF',0x0920,255,0,0,4],['DECF',0x0320,0,0,255,0],['INCF',0x0a20,255,0,0,4],['MOVF',0x0820,0,255,0,4],
    ['RLF',0x0d20,0x80,0,0,1],['RRF',0x0c20,1,0,0,1],['SWAPF',0x0e20,0xab,0,0xba,0],
  ])('%s computes its result and flags',(name,op,f,w,result,flags)=>{void name;const c=run(op as number,f as number,w as number);expect(c.w).toBe(result);expect(c.status&7).toBe(flags);});
  it('rotates through carry without changing Z or DC',()=>{expect(run(0x0d20,1,0,0x1f).w).toBe(3);expect(run(0x0c20,2,0,0x1f).w).toBe(129);expect(run(0x0c20,2,0,0x1f).status&7).toBe(6);});
  it('writes both destinations, MOVWF, CLRF and CLRW; preserves protected STATUS flags',()=>{
    const c=run(0x07a0,7,3);expect(c.ram[0x20]).toBe(10);expect(c.w).toBe(3);
    expect(run(0xa0,5,9).ram[0x20]).toBe(9);expect(run(0x1a0,8).ram[0x20]).toBe(0);expect(run(0x100,0,9).w).toBe(0);
    expect(run(0x183).status).toBe(0x1c);expect(run(0x83,0,0xff).status).toBe(63);
    const s=run(0x0783,0,0xe8);expect(s.status&7).toBe(7);
  });
  it('protects all ALU flag bits when STATUS is the destination',()=>{
    expect(run(0x183,0,0,0x1b).status).toBe(0x1f);
    expect(run(0x0983,0,0,0x1b).status).toBe(0x3b);
    const r=run(0x0c83,0,0,0x1f);expect(r.status&7).toBe(7);
  });
  it.each([['DECFSZ',0x0b20,1,2],['DECFSZ',0x0ba0,2,1],['INCFSZ',0x0f20,255,2],['INCFSZ',0x0fa0,1,1],['BTFSC',0x1820,0,2],['BTFSC',0x1820,1,1],['BTFSS',0x1c20,1,2],['BTFSS',0x1c20,0,1]])('%s skips with a pipeline cycle',(name,op,f,cycles)=>{void name;const c=cpu(op as number,0,0);c.ram[0x20]=f as number;c.status=0x1f;expect(c.step()).toBe(cycles);expect(c.pc).toBe(cycles);expect(c.status).toBe(0x1f);});
  it('sets and clears bits using pin/register reads',()=>{expect(run(0x1420,0).ram[0x20]).toBe(1);expect(run(0x1020,255).ram[0x20]).toBe(254);});
  it.each([['MOVLW',0x3042,3,0x42,0],['ANDLW',0x390f,0xf0,0,4],['IORLW',0x380f,0xf0,255,0],['XORLW',0x3a42,0x42,0,4],['ADDLW',0x3e01,255,0,7],['SUBLW',0x3c01,2,255,0],['SUBLW',0x3c10,1,15,1]])('%s literals',(name,op,w,result,flags)=>{void name;const c=run(op as number,0,w as number);expect(c.w).toBe(result);expect(c.status&7).toBe(flags);});
  it('CALL/RETURN/RETLW/GOTO use two cycles and the circular stack',()=>{
    const c=cpu(0x2003,0x2801,0,0x3442);expect(c.step()).toBe(2);expect(c.pc).toBe(3);expect(c.step()).toBe(2);expect(c.w).toBe(0x42);expect(c.pc).toBe(1);expect(c.step()).toBe(2);expect(c.pc).toBe(1);
    const r=cpu(0x2002,0,8);r.step();r.step();expect(r.pc).toBe(1);
    const code=new Uint16Array(32);for(let i=0;i<18;i+=2)code[i]=0x2000|(i+2);code[18]=8;const wrap=new Pic16(code);for(let i=0;i<9;i++)wrap.step();expect(wrap.sp).toBe(1);expect(Array.from(wrap.stack)).toEqual([17,3,5,7,9,11,13,15]);wrap.step();expect(wrap.pc).toBe(17);
  });
  it('NOP and CLRWDT leave W intact; SLEEP sets PD and TO',()=>{const c=cpu(0,0x64,0x63);c.w=9;c.status=0;c.step();expect(c.w).toBe(9);c.step();expect(c.status).toBe(24);c.step();expect(c.sleeping).toBe(true);expect(c.status).toBe(16);});
});
describe('PIC16 memory, ports, timer and interrupts',()=>{
  it('banks F84 RAM and mirrors its common SFRs; supports zero and indirect INDF',()=>{const c=cpu(0);c.write(0x20,42);expect(c.read(0xa0)).toBe(42);c.write(0x83,0x38);expect(c.bank).toBe(1);c.write(4,0xa0);expect(c.read(0)).toBe(42);c.write(0,9);expect(c.read(0x20)).toBe(9);c.write(4,0);c.write(0,255);expect(c.read(0)).toBe(0);});
  it('banks 877A RAM with IRP and common RAM, with A-E TRIS and pins',()=>{const c=new Pic16(new Uint16Array([0]),'pic16f877a',p=>[0x15,0xaa,0x42,0x24,5][p]);c.write(0x20,1);c.write(0xa0,2);c.write(0x120,3);expect([c.read(0x20),c.read(0xa0),c.read(0x120)]).toEqual([1,2,3]);c.write(3,0x98);c.write(4,0x20);expect(c.read(0)).toBe(3);c.write(0x1f0,7);expect(c.read(0x70)).toBe(7);for(let p=0;p<5;p++){c.write(0x85+p,0);c.write(5+p,255);expect(c.read(5+p)).toBe([0x15,0xaa,0x42,0x24,5][p]);expect(c.tris(p)).toBe(0);}});
  it('computed PCL writes use all five PCLATH bits and cost two cycles',()=>{const c=new Pic16(new Uint16Array([0x0082]),'pic16f877a');c.w=0x42;c.write(10,0x12);expect(c.step()).toBe(2);expect(c.pc).toBe(0x1242);const g=new Pic16(new Uint16Array([0x2005]),'pic16f877a');g.write(10,0x18);g.step();expect(g.pc).toBe(0x1805);expect(g.stack[0]).toBe(1);});
  it('TMR0 prescaler and write inhibition are measured in instruction cycles',()=>{const c=cpu(0x2800);c.write(0x81,0);for(let i=0;i<10;i++)c.step();expect(c.ram[1]).toBe(10);c.write(1,255);c.step();expect(c.ram[1]).toBe(255);c.step();expect(c.ram[1]).toBe(255);c.step();expect(c.ram[1]).toBe(0);expect(c.ram[11]&4).toBe(4);});
  it('RB0 edge vectors to 004, RETFIE restores GIE and the return address',()=>{let b=0;const c=new Pic16(new Uint16Array([0,0,0,0,9]),'pic16f84a',p=>p===1?b:255);c.write(11,0x90);c.write(0x81,0x48);b=1;c.step();expect(c.ram[11]&2).toBe(2);expect(c.step()).toBe(2);expect(c.pc).toBe(4);expect(c.ram[11]&128).toBe(0);c.write(11,0);c.step();expect(c.pc).toBe(1);expect(c.ram[11]&128).toBe(128);});
  it('wakes from SLEEP without GIE and stops the internal timer while asleep',()=>{let b=0;const c=new Pic16(new Uint16Array([0x63,0x3042]),'pic16f84a',p=>p===1?b:255);c.write(11,16);c.write(0x81,0x48);c.step();const t=c.ram[1];b=1;c.step();expect(c.sleeping).toBe(true);expect(c.ram[1]).toBe(t);c.step();expect(c.sleeping).toBe(false);expect(c.w).toBe(0x42);});
  it('executes the prefetched instruction on SLEEP wake before vectoring with GIE',()=>{let b=0;const c=new Pic16(new Uint16Array([0x63,0x3042,0,0,9]),'pic16f84a',p=>p===1?b:255);c.write(11,0x90);c.write(0x81,0x48);c.step();b=1;c.step();c.step();expect(c.w).toBe(0x42);expect(c.pc).toBe(2);c.step();expect(c.pc).toBe(4);expect(c.stack[0]).toBe(2);});
  it('retains the 13-bit PC and page bits while F84 program memory mirrors',()=>{const c=cpu(0x2802);c.write(10,8);c.step();expect(c.pc).toBe(0x802);});
  it('RB4-7 mismatch and TMR0 external clock work independently',()=>{let a=0,b=0;const c=new Pic16(new Uint16Array([0x2800]),'pic16f84a',p=>p===0?a:b);c.write(0x81,0x28);b=0x10;a=0x10;c.step();expect(c.ram[11]&1).toBe(1);expect(c.ram[1]).toBe(1);c.read(6);c.write(11,0);c.step();expect(c.ram[11]&1).toBe(0);});
  it('ignores unimplemented file locations and preserves bank 2/3 RAM on MCLR',()=>{const c=cpu(0);c.write(0x50,42);expect(c.read(0x50)).toBe(0);const large=new Pic16(new Uint16Array([0]),'pic16f877a');large.write(0x110,42);large.write(0x190,99);large.write(0x90,7);expect(large.read(0x90)).toBe(0);large.reset(false);expect(large.read(0x110)).toBe(42);expect(large.read(0x190)).toBe(99);});
  it('errors only when an unsupported peripheral is used',()=>{const c=new Pic16(new Uint16Array([0]),'pic16f877a');c.write(0x1f,0);c.write(0x9f,6);c.write(0x98,0);c.step();expect(()=>c.write(0x1f,1)).toThrow(/ADC.*not implemented/);expect(()=>c.write(0x17,12)).toThrow(/CCP.*not implemented/);expect(()=>c.write(0x19,42)).toThrow(/USART.*not implemented/);expect(()=>new Pic16(new Uint16Array([0x63]),'pic16f84a',()=>255,0x3fff).step()).toThrow(/watchdog.*not implemented/);});
});


it('loads Intel HEX as little-endian words and keeps configuration outside program memory',()=>{
  const record=(a:number,data:number[])=>{const b=[data.length,a>>>8,a&255,0,...data];b.push(-b.reduce((x,y)=>x+y,0)&255);return ':'+b.map(v=>v.toString(16).padStart(2,'0')).join('');};
  const bytes=readIntelHex(record(0,[0x42,0x30,0,0x28])+'\n'+record(0x400e,[0xfb,0x3f])+'\n:00000001FF');
  expect(Array.from(picWords(bytes,'pic16f84a'))).toEqual([0x3042,0x2800]);
  expect(()=>picWords(new Uint8Array([1]),'pic16f84a')).toThrow(/complete words/);
  bytes[2048]=0;expect(()=>picWords(bytes,'pic16f84a')).toThrow(/exceeds device/);
});
