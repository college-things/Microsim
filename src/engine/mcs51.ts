// Original classic 12-clock MCS-51 interpreter, based on the published instruction set.
// RAM and SFR spaces are separate: indirect addresses >= 0x80 never alias SFRs.
const SP=0x81,DPL=0x82,DPH=0x83,PCON=0x87,TCON=0x88,SCON=0x98,SBUF=0x99,TMOD=0x89,TL0=0x8a,TH0=0x8c,IE=0xa8,IP=0xb8,PSW=0xd0,ACC=0xe0,B=0xf0;
export class Mcs51 {
  readonly ram=new Uint8Array(256);
  readonly sfr=new Uint8Array(128);
  readonly xram=new Uint8Array(65536);
  readonly code:Uint8Array;
  pc=0;cycles=0;
  private priority:number[]=[];
  private previousP3=255;
  private interruptDelay=0;
  /** Serial port state. `txFrame` holds the remaining output bits, LSB first; `tick16` counts the 16x baud clock. */
  private serial={txd:1,rxd:1,txFrame:[] as number[],txPending:undefined as number[]|undefined,txPhase:0,mode0Tx:0,rxActive:false,rxPhase:0,rxBits:[] as number[],mode0Rx:0,divider:0,previousRxd:1};
  /** Every byte written to SBUF, in order, for terminals and tests. */
  transmitted:number[]=[];
  constructor(code:Uint8Array,readonly readPort:(port:number)=>number=()=>255){
    if(!code.length||code.length>65536)throw new Error('8051: invalid code memory.');
    this.code=new Uint8Array(65536);this.code.fill(255);this.code.set(code);this.reset();
  }
  reset(clearMemory=true){if(clearMemory){this.ram.fill(0);this.xram.fill(0);}this.sfr.fill(0);this.pc=0;this.cycles=0;this.priority=[];this.previousP3=255;this.interruptDelay=0;this.serial={txd:1,rxd:1,txFrame:[],txPending:undefined,txPhase:0,mode0Tx:0,rxActive:false,rxPhase:0,rxBits:[],mode0Rx:0,divider:0,previousRxd:1};this.sfr[SP-128]=7;for(let p=0;p<4;p++)this.sfr[p*16]=255;}
  copyState(old:Mcs51){this.ram.set(old.ram);this.sfr.set(old.sfr);this.xram.set(old.xram);this.pc=old.pc;this.cycles=old.cycles;this.priority=[...old.priority];this.previousP3=old.previousP3;this.interruptDelay=old.interruptDelay;this.serial={...old.serial,txFrame:[...old.serial.txFrame],txPending:old.serial.txPending&&[...old.serial.txPending],rxBits:[...old.serial.rxBits]};this.transmitted=[...old.transmitted];}
  latch(port:number){return this.sfr[port*16];}
  /** Port output after alternate functions: the serial port pulls RXD (P3.0) or TXD (P3.1) low while shifting. */
  output(port:number){const value=this.sfr[port*16];return port===3?value&(this.serial.rxd?255:254)&(this.serial.txd?255:253):value;}
  get a(){return this.sfr[ACC-128];} set a(value:number){this.sfr[ACC-128]=value;this.parity();}
  get psw(){return this.sfr[PSW-128];}set psw(value:number){this.sfr[PSW-128]=value;}
  get carry(){return this.psw>>>7;}set carry(value:number){this.psw=(this.psw&127)|((value&1)<<7);}
  private get dptr(){return (this.read(DPH)<<8)|this.read(DPL);}private set dptr(value:number){this.write(DPH,value>>>8);this.write(DPL,value);}
  read(address:number,latch=false):number{
    if(address<128)return this.ram[address];
    const value=this.sfr[address-128];
    return !latch&&(address&0xcf)===0x80?value&this.readPort((address-128)>>>4):value;
  }
  write(address:number,value:number){
    if(address<128)this.ram[address]=value;
    else {
      if(address===SBUF){this.transmit(value&255);return;}
      if(address===IE||address===IP)this.interruptDelay=1;
      this.sfr[address-128]=value;
      if(address===ACC)this.parity();
    }
  }
  private reg(index:number){return this.ram[(this.psw&0x18)+(index&7)];}
  private setReg(index:number,value:number){this.ram[(this.psw&0x18)+(index&7)]=value;}
  private fetch(){const value=this.code[this.pc];this.pc=(this.pc+1)&65535;return value;}
  private word(){return (this.fetch()<<8)|this.fetch();}
  private relative(offset:number){this.pc=(this.pc+(offset<128?offset:offset-256))&65535;}
  private push(value:number){this.sfr[SP-128]=(this.sfr[SP-128]+1)&255;this.ram[this.sfr[SP-128]]=value;}
  private pop(){const value=this.ram[this.sfr[SP-128]];this.sfr[SP-128]=(this.sfr[SP-128]-1)&255;return value;}
  private call(address:number){this.push(this.pc&255);this.push(this.pc>>>8);this.pc=address;}
  private bit(address:number,latch=false){const byte=address<128?0x20+(address>>>3):address&0xf8;return (this.read(byte,latch)>>>(address&7))&1;}
  private setBit(address:number,value:number){const byte=address<128?0x20+(address>>>3):address&0xf8,mask=1<<(address&7);this.write(byte,(this.read(byte,true)&~mask)|(value?mask:0));}
  private operand(op:number){const mode=op&15;return mode===4?this.fetch():mode===5?this.read(this.fetch()):mode<8?this.ram[this.reg(mode&1)]:this.reg(mode&7);}
  private arithmetic(value:number,carry:number,subtract=false){
    const a=this.a,result=subtract?a-value-carry:a+value+carry;
    const c=subtract?result<0:result>255,ac=subtract?(a&15)<(value&15)+carry:(a&15)+(value&15)+carry>15;
    const ov=subtract?((a^value)&(a^result)&128)!==0:((~(a^value))&(a^result)&128)!==0;
    this.a=result;this.psw=(this.psw&0x3b)|(c?128:0)|(ac?64:0)|(ov?4:0);
  }
  /** Timer/counter modes 0, 1, 2 and timer-0 split mode 3. */
  private tick(count:number){
    for(let i=0;i<count;i++){
      let overflow1=false;
      const p3=this.read(0xb0),fall=this.previousP3&~p3;this.previousP3=p3;
      let control=this.read(TCON,true);
      for(let n=0;n<2;n++){
        const it=1<<(n*2),flag=it<<1,pin=1<<(n+2);
        control=control&it?(fall&pin?control|flag:control):(p3&pin?control&~flag:control|flag);
      }
      this.write(TCON,control);
      const mode=this.read(TMOD,true);
      for(let n=0;n<2;n++){
        const config=(mode>>>(n*4))&15,kind=config&3;
        if(kind===3&&n===1)continue;
        // With timer 0 in split mode 3, TR1 belongs to TH0: timer 1 runs freely and cannot set TF1 (baud generation only).
        const split=n===1&&(mode&3)===3;
        if(!split&&!(this.read(TCON,true)&(0x10<<(n*2)))||(config&8)&&!(p3&(4<<n))||(config&4)&&!(fall&(16<<n)))continue;
        const lo=TL0+n,hi=TH0+n,flag=split?0:0x20<<(n*2);let over=false;
        if(kind===0){const value=((this.read(hi)<<5)|(this.read(lo)&31))+1;this.write(lo,(this.read(lo)&224)|(value&31));this.write(hi,value>>>5);over=value>8191;}
        else if(kind===1){const value=((this.read(hi)<<8)|this.read(lo))+1;this.write(lo,value);this.write(hi,value>>>8);over=value>65535;}
        else {const value=this.read(lo)+1;this.write(lo,value>255&&kind===2?this.read(hi):value);over=value>255;}
        if(over){this.write(TCON,this.read(TCON,true)|flag);if(n===1)overflow1=true;}
      }
      if((mode&3)===3&&(this.read(TCON,true)&0x40)){const value=this.read(TH0)+1;this.write(TH0,value);if(value>255)this.write(TCON,this.read(TCON,true)|0x80);}
      this.serialCycle(overflow1,p3);
    }
    this.cycles+=count;
  }
  private transmit(value:number){
    this.transmitted.push(value);
    const control=this.read(SCON,true),mode=control>>>6,frame=[0];
    if(mode===0){this.serial.mode0Tx=8;this.serial.txFrame=Array.from({length:8},(_,n)=>(value>>>n)&1);return;}
    for(let n=0;n<8;n++)frame.push((value>>>n)&1);
    if(mode>=2)frame.push((control>>>3)&1);
    frame.push(1);
    // Shifting starts at the next rollover of the divide-by-16 counter, so a frame never cuts the previous stop bit short.
    this.serial.txPending=frame;
  }
  /**
   * One machine cycle of serial port activity. Modes 1-3 run from a 16x baud clock: timer-1 overflows
   * (divided by two unless SMOD) or fosc/4 (fosc/2 with SMOD) in mode 2. Mode 0 shifts once per machine cycle.
   */
  private serialCycle(overflow1:boolean,p3:number){
    const s=this.serial,control=this.read(SCON,true),mode=control>>>6,smod=(this.read(PCON,true)&128)!==0;
    if(mode===0){
      if(s.mode0Tx){s.rxd=s.txFrame[8-s.mode0Tx];s.txd=0;s.mode0Tx--;if(!s.mode0Tx){s.rxd=1;s.txd=1;this.write(SCON,this.read(SCON,true)|2);}return;}
      s.txd=1;
      if(s.mode0Rx){s.rxBits.push(p3&1);s.mode0Rx--;if(!s.mode0Rx){this.sfr[SBUF-128]=s.rxBits.reduce((v,b,n)=>v|(b<<n),0);this.write(SCON,this.read(SCON,true)|1);}return;}
      if((control&0x10)&&!(control&1)){s.mode0Rx=8;s.rxBits=[];}
      return;
    }
    let ticks=0;
    if(mode===2)ticks=smod?6:3;
    else if(overflow1){if(smod)ticks=1;else{s.divider^=1;ticks=s.divider?0:1;}}
    for(let t=0;t<ticks;t++){
      s.txPhase=(s.txPhase+1)&15;
      if(!s.txPhase){
        if(s.txFrame.length){s.txFrame.shift();if(s.txFrame.length===1)this.write(SCON,this.read(SCON,true)|2);}
        if(!s.txFrame.length&&s.txPending){s.txFrame=s.txPending;s.txPending=undefined;}
        s.txd=s.txFrame.length?s.txFrame[0]:1;
      }
      const rxd=p3&1;
      if(!s.rxActive){if((control&0x10)&&s.previousRxd&&!rxd){s.rxActive=true;s.rxPhase=0;s.rxBits=[];}}
      else if(++s.rxPhase===8){
        s.rxBits.push(rxd);
        if(s.rxBits.length===1&&rxd){s.rxActive=false;}
        else if(s.rxBits.length===(mode===1?10:11)){
          s.rxActive=false;const data=s.rxBits.slice(1,9).reduce((v,b,n)=>v|(b<<n),0),ninth=s.rxBits[9],sm2=(control&0x20)!==0,now=this.read(SCON,true);
          if(!(now&1)&&(!sm2||ninth)){this.sfr[SBUF-128]=data;this.write(SCON,(now&~4)|(ninth?4:0)|1);}
        }
      }else if(s.rxPhase>=16)s.rxPhase=0;
      s.previousRxd=rxd;
    }
  }
  private interrupt():boolean {
    const enabled=this.read(IE,true);if(!(enabled&128)||this.priority.at(-1)===1)return false;
    const t=this.read(TCON,true),serial=this.read(0x98,true),pending=[t&2,t&32,t&8,t&128,serial&3],ip=this.read(IP,true);
    for(const priority of [1,0]){
      if(this.priority.length&&priority<=this.priority[this.priority.length-1])continue;
      for(let n=0;n<5;n++)if((enabled&(1<<n))&&pending[n]&&((ip>>>n)&1)===priority){
        if(n===1)this.write(TCON,t&~32);if(n===3)this.write(TCON,t&~128);
        if(n===0&&(t&1))this.write(TCON,t&~2);if(n===2&&(t&4))this.write(TCON,t&~8);
        this.priority.push(priority);this.write(PCON,this.read(PCON)&~1);this.call(3+n*8);this.tick(2);return true;
      }
    }
    return false;
  }
  private parity(){let bits=this.a;bits^=bits>>>4;bits^=bits>>>2;bits^=bits>>>1;this.psw=(this.psw&254)|(bits&1);}
  /** Execute one instruction (or interrupt entry); returns classic machine cycles. */
  step():number {
    this.parity();
    if(this.read(PCON)&2){this.cycles++;return 1;}
    if(this.interruptDelay)this.interruptDelay--;else if(this.interrupt())return 2;
    if(this.read(PCON)&1){this.tick(1);return 1;}
    const at=this.pc,op=this.fetch();let cycles=1;
    if((op&31)===1){const low=this.fetch();this.pc=(this.pc&0xf800)|((op&224)<<3)|low;cycles=2;}
    else if((op&31)===17){const low=this.fetch(),target=(this.pc&0xf800)|((op&224)<<3)|low;this.call(target);cycles=2;}
    else if((op>=0x24&&op<=0x2f)||(op>=0x34&&op<=0x3f))this.arithmetic(this.operand(op),op<0x30?0:this.carry);
    else if(op>=0x94&&op<=0x9f)this.arithmetic(this.operand(op),this.carry,true);
    else if((op>=0x44&&op<=0x4f)||(op>=0x54&&op<=0x5f)||(op>=0x64&&op<=0x6f)){const value=this.operand(op);this.a=op<0x50?this.a|value:op<0x60?this.a&value:this.a^value;}
    else if(op>=0x78&&op<=0x7f)this.setReg(op&7,this.fetch());
    else if(op>=0x88&&op<=0x8f){this.write(this.fetch(),this.reg(op&7));cycles=2;}
    else if(op>=0xa8&&op<=0xaf){this.setReg(op&7,this.read(this.fetch()));cycles=2;}
    else if(op>=0xe8&&op<=0xef)this.a=this.reg(op&7);
    else if(op>=0xf8)this.setReg(op&7,this.a);
    else if(op>=0x08&&op<=0x0f)this.setReg(op&7,this.reg(op&7)+1);
    else if(op>=0x18&&op<=0x1f)this.setReg(op&7,this.reg(op&7)-1);
    else if(op>=0xc8&&op<=0xcf){const value=this.reg(op&7);this.setReg(op&7,this.a);this.a=value;}
    else if(op>=0xd8&&op<=0xdf){const rel=this.fetch(),value=(this.reg(op&7)-1)&255;this.setReg(op&7,value);if(value)this.relative(rel);cycles=2;}
    else if(op>=0xb4&&op<=0xbf){
      const left=op<0xb6?this.a:op<0xb8?this.ram[this.reg(op&1)]:this.reg(op&7),right=op===0xb5?this.read(this.fetch()):this.fetch(),rel=this.fetch();this.carry=left<right?1:0;if(left!==right)this.relative(rel);cycles=2;
    }else switch(op){
      case 0x00:break;
      case 0x02:this.pc=this.word();cycles=2;break;
      case 0x12:{const address=this.word();this.call(address);cycles=2;break;}
      case 0x22:case 0x32:{const hi=this.pop();this.pc=(hi<<8)|this.pop();if(op===0x32){this.priority.pop();this.interruptDelay=1;}cycles=2;break;}
      case 0x03:this.a=(this.a>>>1)|(this.a<<7);break;
      case 0x13:{const old=this.carry;this.carry=this.a&1;this.a=(this.a>>>1)|(old<<7);break;}
      case 0x23:this.a=(this.a<<1)|(this.a>>>7);break;
      case 0x33:{const old=this.carry;this.carry=this.a>>>7;this.a=(this.a<<1)|old;break;}
      case 0x04:this.a++;break;case 0x14:this.a--;break;
      case 0x05:case 0x15:{const address=this.fetch();this.write(address,this.read(address,true)+(op===5?1:-1));break;}
      case 0x06:case 0x07:case 0x16:case 0x17:{const address=this.reg(op&1);this.ram[address]+=op<16?1:-1;break;}
      case 0x10:case 0x20:case 0x30:{const address=this.fetch(),rel=this.fetch(),bit=this.bit(address,op===0x10);if(op===0x30?!bit:bit){if(op===0x10)this.setBit(address,0);this.relative(rel);}cycles=2;break;}
      case 0x40:case 0x50:case 0x60:case 0x70:case 0x80:{const rel=this.fetch();if(op===0x80||(op===0x40?this.carry:op===0x50?!this.carry:op===0x60?!this.a:this.a))this.relative(rel);cycles=2;break;}
      case 0x42:case 0x52:case 0x62:case 0x43:case 0x53:case 0x63:{const address=this.fetch(),a=this.read(address,true),b=op&1?this.fetch():this.a;this.write(address,op<0x50?a|b:op<0x60?a&b:a^b);cycles=op&1?2:1;break;}
      case 0x72:case 0x82:case 0xa0:case 0xb0:{const bit=this.bit(this.fetch())^(op>=0xa0?1:0);this.carry=op===0x72||op===0xa0?this.carry|bit:this.carry&bit;cycles=2;break;}
      case 0x73:this.pc=(this.dptr+this.a)&65535;cycles=2;break;
      case 0x74:this.a=this.fetch();break;
      case 0x75:{const address=this.fetch();this.write(address,this.fetch());cycles=2;break;}
      case 0x76:case 0x77:this.ram[this.reg(op&1)]=this.fetch();break;
      case 0x83:this.a=this.code[(this.pc+this.a)&65535];cycles=2;break;
      case 0x84:{const a=this.a,b=this.read(B);this.carry=0;this.psw=(this.psw&~4)|(b?0:4);if(b){this.a=Math.floor(a/b);this.write(B,a%b);}cycles=4;break;}
      case 0x85:{const source=this.fetch(),destination=this.fetch();this.write(destination,this.read(source));cycles=2;break;}
      case 0x86:case 0x87:this.write(this.fetch(),this.ram[this.reg(op&1)]);cycles=2;break;
      case 0x90:this.dptr=this.word();cycles=2;break;
      case 0x92:this.setBit(this.fetch(),this.carry);cycles=2;break;
      case 0x93:this.a=this.code[(this.dptr+this.a)&65535];cycles=2;break;
      case 0xa2:this.carry=this.bit(this.fetch());break;
      case 0xa3:this.dptr=(this.dptr+1)&65535;cycles=2;break;
      case 0xa4:{const result=this.a*this.read(B);this.a=result;this.write(B,result>>>8);this.psw=(this.psw&~132)|(result>255?4:0);cycles=4;break;}
      case 0xa6:case 0xa7:this.ram[this.reg(op&1)]=this.read(this.fetch());cycles=2;break;
      case 0xb2:{const address=this.fetch();this.setBit(address,1-this.bit(address,true));break;}
      case 0xb3:this.carry=1-this.carry;break;
      case 0xc0:{const address=this.fetch();this.push(address===SP?(this.read(SP)+1)&255:this.read(address));cycles=2;break;}
      case 0xc2:this.setBit(this.fetch(),0);break;case 0xc3:this.carry=0;break;
      case 0xc4:this.a=(this.a<<4)|(this.a>>>4);break;
      case 0xc5:{const address=this.fetch(),value=this.read(address,true),a=this.a;this.a=value;this.write(address,a);break;}
      case 0xc6:case 0xc7:{const address=this.reg(op&1),value=this.ram[address];this.ram[address]=this.a;this.a=value;break;}
      case 0xd0:{const address=this.fetch();this.write(address,this.pop());cycles=2;break;}
      case 0xd2:this.setBit(this.fetch(),1);break;case 0xd3:this.carry=1;break;
      case 0xd4:{let value=this.a,c=this.carry;if((value&15)>9||(this.psw&64))value+=6;if(value>255)c=1;if((value&0xf0)>0x90||c)value+=0x60;if(value>255)c=1;this.a=value;this.carry=c;break;}
      case 0xd5:{const address=this.fetch(),rel=this.fetch(),value=(this.read(address,true)-1)&255;this.write(address,value);if(value)this.relative(rel);cycles=2;break;}
      case 0xd6:case 0xd7:{const address=this.reg(op&1),value=this.ram[address];this.ram[address]=(value&240)|(this.a&15);this.a=(this.a&240)|(value&15);break;}
      case 0xe0:this.a=this.xram[this.dptr];cycles=2;break;
      case 0xe2:case 0xe3:this.a=this.xram[(this.latch(2)<<8)|this.reg(op&1)];cycles=2;break;
      case 0xe4:this.a=0;break;
      case 0xe5:this.a=this.read(this.fetch());break;
      case 0xe6:case 0xe7:this.a=this.ram[this.reg(op&1)];break;
      case 0xf0:this.xram[this.dptr]=this.a;cycles=2;break;
      case 0xf2:case 0xf3:this.xram[(this.latch(2)<<8)|this.reg(op&1)]=this.a;cycles=2;break;
      case 0xf4:this.a^=255;break;
      case 0xf5:this.write(this.fetch(),this.a);break;
      case 0xf6:case 0xf7:this.ram[this.reg(op&1)]=this.a;break;
      default:throw new Error(`8051: reserved opcode 0x${op.toString(16)} at 0x${at.toString(16)}.`);
    }
    this.tick(cycles);return cycles;
  }
}
