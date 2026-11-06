// Original mid-range PIC16 interpreter, from Microchip DS35007 and DS39582.
export type PicVariant = 'pic16f84a' | 'pic16f877a';
export const picPortWidths = (variant:PicVariant) => variant==='pic16f84a'?[5,8]:[6,8,8,8,3];
export class Pic16 {
  readonly ram=new Uint8Array(512);
  readonly code:Uint16Array;
  readonly stack=new Uint16Array(8);
  readonly widths:number[];
  pc=0;w=0;cycles=0;sp=0;sleeping=false;
  private prescale=0;private inhibit=0;private previousB=255;private previousA=255;private mismatchB=255;
  private jumped=false;
  constructor(code:Uint16Array,readonly variant:PicVariant='pic16f84a',readonly readPort:(port:number)=>number=()=>255,readonly config?:number){
    const size=variant==='pic16f84a'?1024:8192;
    if(!code.length||code.length>size)throw new Error('PIC16: invalid program size.');
    this.code=new Uint16Array(size);this.code.fill(0x3fff);this.code.set(code);this.widths=picPortWidths(variant);this.reset();
  }
  get status(){return this.ram[3];}set status(v:number){this.ram[3]=v&(this.variant==='pic16f84a'?63:255);}
  get bank(){return (this.status>>>5)&(this.variant==='pic16f84a'?1:3);}
  get fsr(){return this.ram[4];}get pclath(){return this.ram[10];}
  latch(p:number){return this.ram[5+p];}tris(p:number){return this.ram[0x85+p];}
  reset(clearMemory=true){
    if(clearMemory)this.ram.fill(0);
    if(!clearMemory){for(let a=0;a<512;a++)if((a<256&&(a&127)<(this.variant==='pic16f84a'?12:32))||[0x10c,0x10d,0x10e,0x10f,0x18c,0x18d].includes(a))this.ram[a]=0;}
    this.pc=0;this.w=0;this.sp=0;this.cycles=0;this.sleeping=false;this.status=0x18;this.ram[10]=0;this.ram[11]=0;this.ram[0x81]=255;
    for(let p=0;p<this.widths.length;p++)this.ram[0x85+p]=(1<<this.widths[p])-1;
    this.prescale=0;this.inhibit=0;this.previousB=this.readPort(1);this.previousA=this.readPort(0);this.mismatchB=this.previousB;
  }
  copyState(old:Pic16){this.ram.set(old.ram);this.stack.set(old.stack);for(const k of ['pc','w','cycles','sp','prescale','inhibit','previousB','previousA','mismatchB'] as const)this[k]=old[k];this.sleeping=old.sleeping;}
  private address(a:number,indirect=false):number{
    a&=511;if((a&127)===0){if(indirect)return -1;return this.address(this.fsr|((this.status&128)<<1),true);}
    const f=a&127;
    if([2,3,4,10,11].includes(f))return f;
    if(this.variant==='pic16f84a'){a&=255;if(f>=12&&f<=79)return f;}
    else {if(f>=0x70)return f;if((a&0x100)&&[1,6].includes(f))a&=255;}
    return a;
  }
  private implemented(a:number):boolean{
    if(this.variant==='pic16f84a')return a>=12&&a<=79||[1,2,3,4,5,6,8,9,10,11,0x81,0x85,0x86,0x88,0x89].includes(a);
    return a>=0x20&&a<=0x7f||a>=0xa0&&a<=0xef||a>=0x110&&a<=0x16f||a>=0x190&&a<=0x1ef
      ||a>=1&&a<=0x1f||[0x81,0x85,0x86,0x87,0x88,0x89,0x8c,0x8d,0x8e,0x91,0x92,0x93,0x94,0x98,0x99,0x9c,0x9d,0x9e,0x9f,0x10c,0x10d,0x10e,0x10f,0x18c,0x18d].includes(a);
  }
  private peripheral(a:number,v?:number){
    const large=this.variant==='pic16f877a';
    let name='';
    if(!large&&([8,9].includes(a)||(a===0x88&&v!==undefined&&(v&7))))name='EEPROM';
    if(large){
      if(a===0x1f&&v!==undefined&&(v&1))name='ADC';
      if(a===0x1e||a===0x9e)name='ADC';
      if([0x19,0x1a].includes(a)||(a===0x98&&v!==undefined&&(v&0x30))||(a===0x18&&v!==undefined&&(v&0x80)))name='USART';
      if([0x17,0x1d].includes(a)&&v!==undefined&&(v&15))name='CCP';
      if(a===0x10&&v!==undefined&&(v&1))name='timer 1';
      if(a===0x12&&v!==undefined&&(v&4))name='timer 2';
      if(a===0x14&&v!==undefined&&(v&0x20)||a===0x13)name='MSSP';
      if(a===0x89&&v!==undefined&&(v&0x10))name='parallel slave port';
      if(a===0x18&&v===0)name='';
      if(a===0x18c&&v!==undefined&&(v&7)||a===0x10c||a===0x10d)name='EEPROM/program memory';
      if((a===0x8c||a===0x8d)&&v)name='peripheral interrupts';
      if(a===0x9c&&v!==undefined&&(v&7)!==7)name='comparators';
    }
    if(name)throw new Error(`PIC16: ${name} is not implemented.`);
    // Unimplemented control registers may be initialized while their peripheral remains disabled.
  }
  read(a:number):number{
    a=this.address(a);if(a<0||!this.implemented(a))return 0;if(a===2)return this.pc&255;
    if(a>=5&&a<5+this.widths.length){const p=a-5,value=this.readPort(p)&((1<<this.widths[p])-1);if(p===1)this.mismatchB=value;return value;}
    this.peripheral(a);return this.ram[a];
  }
  write(a:number,v:number){
    a=this.address(a);v&=255;if(a<0||!this.implemented(a))return;this.peripheral(a,v);
    if(a===2){this.pc=(((this.pclath&31)<<8)|v)&8191;this.jumped=true;return;}
    if(a===3){this.status=(v&0xe7)|(this.status&0x18);return;}
    if(a===6)this.mismatchB=this.readPort(1);
    if(a===10)v&=31;
    if(a===1){this.inhibit=3;if(!(this.ram[0x81]&8))this.prescale=0;}
    if(a===0x81)this.prescale=0;
    if(a>=5&&a<5+this.widths.length)v&=(1<<this.widths[a-5])-1;
    if(a>=0x85&&a<0x85+this.widths.length)v&=a===0x89?255:(1<<this.widths[a-0x85])-1;
    this.ram[a]=v;
  }
  private push(v:number){this.stack[this.sp]=v;this.sp=(this.sp+1)&7;}
  private pop(){this.sp=(this.sp+7)&7;return this.stack[this.sp];}
  private flags(v:number,mask=4,bits=0){this.status=(this.status&~mask)|bits|((mask&4)&&!(v&255)?4:0);}
  private arithmetic(a:number,b:number,sub:boolean){const v=sub?a-b:a+b;this.flags(v,7,((sub?a>=b:v>255)?1:0)|((sub?(a&15)>=(b&15):(a&15)+(b&15)>15)?2:0));return v&255;}
  private tick(count:number){
    for(let i=0;i<count;i++){
      const b=this.readPort(1),a=this.readPort(0),option=this.ram[0x81];
      if((this.previousB^b)&1&&((option&64)?!!(b&1):!(b&1)))this.ram[11]|=2;
      if((this.mismatchB^b)&this.tris(1)&0xf0)this.ram[11]|=1;
      const edge=!!((this.previousA^a)&16)&&((option&16)?!(a&16):!!(a&16));
      this.previousB=b;this.previousA=a;
      if(this.inhibit){this.inhibit--;continue;}
      if(this.sleeping||(option&32&&!edge))continue;
      if(!(option&8)&&++this.prescale<(2<<(option&7)))continue;
      this.prescale=0;this.ram[1]=(this.ram[1]+1)&255;if(!this.ram[1])this.ram[11]|=4;
    }
    this.cycles+=count;
  }
  step():number{
    if(this.config!==undefined&&(this.config&4))throw new Error('PIC16: watchdog timer is not implemented.');
    const intcon=this.ram[11],pending=!!((intcon&32&&intcon&4)||(intcon&16&&intcon&2)||(intcon&8&&intcon&1));
    if(pending){const waking=this.sleeping;this.sleeping=false;if((intcon&128)&&!waking){this.push(this.pc);this.ram[11]&=127;this.pc=4;this.tick(2);return 2;}}
    if(this.sleeping){this.tick(1);return 1;}
    const op=this.code[this.pc&(this.code.length-1)];this.pc=(this.pc+1)&8191;this.jumped=false;let cycles=1;
    const f=(this.bank<<7)|(op&127),dest=!!(op&128),k=op&255;
    const store=(v:number)=>{if(dest)this.write(f,v);else this.w=v&255;};
    const skip=()=>{this.pc=(this.pc+1)&8191;cycles=2;};
    if(op===0x0008||op===0x0009){this.pc=this.pop();if(op===9)this.ram[11]|=128;cycles=2;}
    else if(op===0x0063){this.sleeping=true;this.status=(this.status|16)&~8;if(this.ram[0x81]&8)this.prescale=0;}
    else if(op===0x0064){this.status|=24;if(this.ram[0x81]&8)this.prescale=0;}
    else if((op&0x3f9f)===0){} // NOP aliases
    else if((op&0x3f80)===0x0080)this.write(f,this.w);
    else if((op&0x3f80)===0x0180){const flags=(this.status&3)|4;this.write(f,0);this.status=(this.status&~7)|flags;}
    else if((op&0x3f80)===0x0100){this.w=0;this.flags(0);}
    else if((op&0x3000)===0){
      const v=this.read(f);let r=0,zero=true;
      switch((op>>>8)&15){
        case 2:r=this.arithmetic(v,this.w,true);zero=false;break;
        case 3:r=v-1;break;case 4:r=v|this.w;break;case 5:r=v&this.w;break;case 6:r=v^this.w;break;
        case 7:r=this.arithmetic(v,this.w,false);zero=false;break;case 8:r=v;break;case 9:r=~v;break;case 10:r=v+1;break;
        case 11:r=(v-1)&255;zero=false;if(!r)skip();break;
        case 12:r=(v>>>1)|((this.status&1)<<7);this.status=(this.status&~1)|(v&1);zero=false;break;
        case 13:r=(v<<1)|(this.status&1);this.status=(this.status&~1)|(v>>>7);zero=false;break;
        case 14:r=(v<<4)|(v>>>4);zero=false;break;
        case 15:r=(v+1)&255;zero=false;if(!r)skip();break;
        default:throw new Error('PIC16: invalid instruction.');
      }
      // STATUS destinations cannot overwrite the flags generated by the ALU.
      if(zero)this.flags(r);
      const flags=this.status&7;store(r);
      if(zero||[2,7,12,13].includes((op>>>8)&15))this.status=(this.status&~7)|flags;
    }
    else if((op&0x3000)===0x1000){const bit=1<<((op>>>7)&7),v=this.read(f);switch((op>>>10)&3){case 0:this.write(f,v&~bit);break;case 1:this.write(f,v|bit);break;case 2:if(!(v&bit))skip();break;case 3:if(v&bit)skip();break;}}
    else if((op&0x3000)===0x2000){if(!(op&0x800))this.push(this.pc);this.pc=(((this.pclath&24)<<8)|(op&0x7ff))&8191;cycles=2;}
    else if((op&0x3c00)===0x3000)this.w=k;
    else if((op&0x3c00)===0x3400){this.w=k;this.pc=this.pop();cycles=2;}
    else if((op&0x3e00)===0x3e00)this.w=this.arithmetic(this.w,k,false);
    else if((op&0x3e00)===0x3c00)this.w=this.arithmetic(k,this.w,true);
    else if(op>>>8===0x38){this.w|=k;this.flags(this.w);}
    else if(op>>>8===0x39){this.w&=k;this.flags(this.w);}
    else if(op>>>8===0x3a){this.w^=k;this.flags(this.w);}
    else throw new Error('PIC16: invalid instruction.');
    if(this.jumped)cycles=2;this.tick(cycles);return cycles;
  }
}

/** Firmware uses byte addresses in Intel HEX; PIC instruction addresses count little-endian words. */
export function picWords(bytes:Uint8Array,variant:PicVariant):Uint16Array{
  const limit=variant==='pic16f84a'?2048:16384;
  for(let i=limit;i<bytes.length;i++)if(bytes[i]!==255&&!(i>=0x4000&&i<0x4010)&&!(i>=0x4200&&i<0x4400))throw new Error('PIC16: program exceeds device memory.');
  let end=Math.min(bytes.length,limit);while(end>2&&bytes[end-1]===255&&bytes[end-2]===255)end-=2;
  if(end%2)throw new Error('PIC16: program must contain complete words.');
  return Uint16Array.from({length:end/2},(_,i)=>(bytes[i*2]|(bytes[i*2+1]<<8))&0x3fff);
}
