import { describe, expect, it } from 'vitest';
import { assemblePic } from '../../src/engine/asmpic';
import { programHex } from '../../src/engine/ihex';
import { createLiveSession, simulate } from '../../src/engine';
const source=`
BANKSEL TRISB
CLRF TRISB
BANKSEL PORTB
loop: MOVLW 1
XORWF PORTB,F
NOP
GOTO loop`;
const code=programHex(assemblePic(source).code);
const pins=Array.from({length:13},(_,i)=>'p'+i).join(' ');
const deck=(r='1k')=>`* PIC circuit
Vreset reset 0 5
A1 [${pins}] reset cpu
.model cpu d_mcupic16(program="${code}" frequency=4Meg)
R1 p5 led ${r}
D1 led 0 light
.model light D(is=1e-18 n=2)
.end`;
describe('PIC digital model and debugger',()=>{
  it('blinks an LED on RB0 at 100 kHz (five instruction cycles per toggle)',()=>{
    const result=simulate(deck(),{type:'tran',tstep:0.1e-6,tstop:60e-6,tmax:0.1e-6});
    const pin=result.vectors.find(v=>v.name==='v(p5)')!.re,led=result.vectors.find(v=>v.name==='v(led)')!.re;
    const times=result.axis!.re;const edges:number[]=[];
    for(let i=1;i<pin.length;i++)if(pin[i]>2.5&&pin[i-1]<=2.5)edges.push(times[i]);
    expect(edges.length).toBeGreaterThan(4);for(let i=1;i<edges.length;i++)expect(edges[i]-edges[i-1]).toBeCloseTo(10e-6,6);
    expect(Math.max(...led)).toBeGreaterThan(1);expect(Math.max(...pin)).toBeGreaterThan(4.5);
  });
  it('halts, reports PIC registers, steps, continues and retains state through value changes',()=>{
    const live=createLiveSession(deck(),{tmax:0.1e-6});live.debug('a1',{breakpoints:[3]});live.advance(1e-3,1e9);
    expect(live.halted).toBe('a1');const s=live.mcuState('a1')!;expect(s).toMatchObject({kind:'pic16',pc:3,bank:0,pclath:0,fsr:0});expect(s.tris![1]).toBe(0);
    expect(live.advance(1e-3,1e9).time.length).toBe(0);expect(live.update(deck('2k'))).toBe(true);
    live.debug('a1',{breakpoints:[],step:true});live.resume();live.advance(1e-3,1e9);expect(live.mcuState('a1')!.pc).toBe(4);expect(live.mcuState('a1')!.w).toBe(1);
    live.debug('a1',{breakpoints:[3]});live.resume();live.advance(1e-3,1e9);expect(live.halted).toBe('a1');expect(live.mcuState('a1')!.pc).toBe(3);
    const changed=deck().replace(code,programHex(assemblePic('GOTO 0').code));expect(live.update(changed)).toBe(false);
  });
  it('drives the additional C-E ports on the 877A',()=>{
    const code=programHex(assemblePic('BANKSEL TRISC\nCLRF TRISC\nCLRF TRISD\nCLRF TRISE\nBANKSEL PORTC\nBSF PORTC,0\nBSF PORTD,1\nBSF PORTE,2\nhere: GOTO here','pic16f877a').code);
    const pins=Array.from({length:33},(_,i)=>'p'+i).join(' ');
    const result=simulate(`* large PIC\nVreset reset 0 5\nA1 [${pins}] reset cpu\n.model cpu d_mcupic16(program="${code}" frequency=4Meg variant="pic16f877a")\nR1 p14 0 100k\nR2 p23 0 100k\nR3 p32 0 100k\n.end`,{type:'tran',tstep:1e-6,tstop:30e-6});
    for(const n of [14,23,32])expect(result.vectors.find(v=>v.name===`v(p${n})`)!.re.at(-1)).toBeGreaterThan(4.5);
  });
  it('leaves input pins high impedance and MCLR holds the part in reset',()=>{
    const d=`* input/reset\nVreset reset 0 5\nVpin input 0 3\nA1 [${['input',...Array.from({length:12},(_,i)=>'x'+i)].join(' ')}] reset cpu\n.model cpu d_mcupic16(program="${code}" frequency=4Meg)\n.end`;
    const live=createLiveSession(d);const chunk=live.advance(10e-6,1e9);const current=live.names.indexOf('i(vpin)');expect(Math.max(...chunk.values[current].map(Math.abs))).toBeLessThan(1e-8);expect(live.update(d.replace('Vreset reset 0 5','Vreset reset 0 0'))).toBe(true);live.advance(20e-6,1e9);expect(live.mcuState('a1')!.pc).toBe(0);expect(live.mcuState('a1')!.tris).toEqual([31,255]);
  });
});
