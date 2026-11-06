import { DigitalDomain, L0, L1, LZ, type DigitalModel } from './digital';
import { Pic16, picPortWidths, type PicVariant } from './pic16';

/** PIC execution at instruction boundaries, sharing the 8051 queue/debugger contract. */
export class McuPic16 implements DigitalModel {
  readonly inputs:number[];readonly cpu:Pic16;readonly stateKey:string;
  readonly breakpoints=new Set<number>();stepOnce=false;onHalt?:()=>void;
  private armed=false;
  constructor(private readonly clock:number,private readonly echo:number,private readonly resetNet:number,pins:number[],private readonly drivers:number[],private readonly period:number,code:Uint16Array,variant:PicVariant,domain:DigitalDomain,config?:number){
    this.inputs=[clock,resetNet];this.stateKey=variant+':'+config+':'+period+':'+Array.from(code).join(',');
    const widths=picPortWidths(variant),offsets=widths.map((_,p)=>widths.slice(0,p).reduce((a,b)=>a+b,0));
    this.cpu=new Pic16(code,variant,p=>{let v=0;for(let b=0;b<widths[p];b++)if(domain.val(pins[offsets[p]+b])===L1)v|=1<<b;return v;},config);
  }
  copyState(old:DigitalModel){const m=old as McuPic16;this.cpu.copyState(m.cpu);this.armed=m.armed;}
  private drive(d:DigitalDomain){let i=0;for(let p=0;p<this.cpu.widths.length;p++)for(let b=0;b<this.cpu.widths[p];b++,i++)d.schedule(this.drivers[i],this.cpu.tris(p)&(1<<b)?LZ:this.cpu.latch(p)&(1<<b)?(p===0&&b===4?LZ:L1):L0,0);}
  evaluate(d:DigitalDomain,trig:number){
    if(d.initMode){this.cpu.reset();this.armed=false;this.drive(d);d.schedule(this.echo,L0,0);return;}
    if(this.armed&&trig!==this.clock&&trig!==this.resetNet)return;
    const reset=d.valCtl(this.resetNet)===L0;
    if(reset)this.cpu.reset(false);
    if(this.armed||reset)this.drive(d);
    if(this.armed&&trig===this.resetNet)return;
    this.armed=true;const cycles=reset?1:this.cpu.step();
    if(!reset&&(this.stepOnce||this.breakpoints.has(this.cpu.pc))){this.stepOnce=false;this.onHalt?.();}
    d.schedule(this.echo,d.val(this.clock)===L1?L0:L1,cycles*this.period);
  }
}
