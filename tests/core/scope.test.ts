import {expect,it} from 'vitest';
import {coupleScope,scopeTrigger} from '../../src/core/scope';
import {Doc} from '../../src/core/doc';
it('provides four separate Tektronix inputs and a common reference',()=>{
 const doc=new Doc(),scope=doc.addPart('tektronix-scope',0,0);expect(scope.pins.map(p=>p.name)).toEqual(['A','B','G','C','D']);
 expect(new Set(scope.pins.map(p=>`${p.x},${p.y}`)).size).toBe(5);
});
it('uses an interpolated edge on either trigger slope and retains a complete sweep',()=>{
 const axis=[0,1,2,3,4,5,6],wave=[-1,1,-1,1,-1,1,-1];
 expect(scopeTrigger(axis,wave,0,2,'rising')).toBe(2.5);
 expect(scopeTrigger(axis,wave,0,2,'falling')).toBe(3.5);
 expect(scopeTrigger(axis,wave,undefined,2)).toBe(4);
});
it('AC coupling rejects DC, has the expected RC step response, and preserves DC mode',()=>{
 const time=Float64Array.from({length:1001},(_,i)=>i/10000),dc=new Float64Array(time.length).fill(4);
 expect(coupleScope(dc,time,'DC')).toBe(dc);expect(coupleScope(dc,time,'AC').every(v=>v===0)).toBe(true);expect(coupleScope(dc,time,'GND').every(v=>v===0)).toBe(true);
 const step=dc.map((_,i)=>i?1:0),out=coupleScope(step,time,'AC');
 expect(out[501]/out[1]).toBeCloseTo(Math.exp(-2*Math.PI*10*0.05),8);
});
