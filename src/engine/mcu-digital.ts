import { DigitalDomain, L0, L1, LZ, type DigitalModel } from './digital';
import { Mcs51 } from './mcs51';

/** Instruction-boundary execution using the existing accepted-time digital event queue. */
export class Mcu8051 implements DigitalModel {
  readonly inputs:number[];
  readonly cpu:Mcs51;
  readonly stateKey:string;
  private armed=false;
  constructor(private readonly clock:number,private readonly echo:number,private readonly resetNet:number,pins:number[],private readonly lows:number[],private readonly highs:number[],private readonly period:number,code:Uint8Array,domain:DigitalDomain){
    this.inputs=[clock,resetNet];
    this.stateKey=period+':'+Array.from(code,b=>b.toString(16).padStart(2,'0')).join('');
    this.cpu=new Mcs51(code,port=>{let value=0;for(let bit=0;bit<8;bit++)if(domain.val(pins[port*8+bit])===L1)value|=1<<bit;return value;});
  }
  copyState(old:DigitalModel){const model=old as Mcu8051;this.cpu.copyState(model.cpu);this.armed=model.armed;}
  private drive(d:DigitalDomain){
    for(let port=0;port<4;port++)for(let bit=0;bit<8;bit++){
      const index=port*8+bit,high=!!(this.cpu.output(port)&(1<<bit));
      d.schedule(this.lows[index],high?LZ:L0,0);
      if(port>0)d.schedule(this.highs[index],high?L1:LZ,0);
    }
  }
  evaluate(d:DigitalDomain,trig:number){
    if(d.initMode){this.cpu.reset();this.armed=false;this.drive(d);d.schedule(this.echo,L0,0);return;}
    if(this.armed&&trig!==this.clock&&trig!==this.resetNet)return;
    const reset=d.valCtl(this.resetNet)===L1;
    if(reset)this.cpu.reset(false);
    if(this.armed||reset)this.drive(d);
    // Inputs changing alone never execute firmware. A reset edge can release outputs immediately.
    if(this.armed&&trig===this.resetNet)return;
    this.armed=true;
    const cycles=reset?1:this.cpu.step();
    d.schedule(this.echo,d.val(this.clock)===L1?L0:L1,cycles*this.period);
  }
}
