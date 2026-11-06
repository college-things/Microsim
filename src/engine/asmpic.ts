// Original MPASM-style assembler. Register/bit definitions are written from DS35007/DS39582.
import type { PicVariant } from './pic16';
export interface PicListing {address:number;line:number;size:number;mnemonic:string}
export interface PicAssembly {code:Uint8Array;symbols:Map<string,number>;listing:PicListing[];config:number|undefined}
export class PicAsmError extends Error {constructor(readonly line:number,message:string){super(`PIC assembly line ${line}: ${message}`);}}
const byteOps:Record<string,number>={SUBWF:0x200,DECF:0x300,IORWF:0x400,ANDWF:0x500,XORWF:0x600,ADDWF:0x700,MOVF:0x800,COMF:0x900,INCF:0xa00,DECFSZ:0xb00,RRF:0xc00,RLF:0xd00,SWAPF:0xe00,INCFSZ:0xf00};
const bitOps:Record<string,number>={BCF:0x1000,BSF:0x1400,BTFSC:0x1800,BTFSS:0x1c00};
const literalOps:Record<string,number>={MOVLW:0x3000,RETLW:0x3400,IORLW:0x3800,ANDLW:0x3900,XORLW:0x3a00,SUBLW:0x3c00,ADDLW:0x3e00,CALL:0x2000,GOTO:0x2800};
const fixed:Record<string,number>={NOP:0,RETURN:8,RETFIE:9,SLEEP:0x63,CLRWDT:0x64,CLRW:0x100};
const directives=['CONSTANT','VARIABLE','EQU','SET','CBLOCK','ENDC','ORG','END','__CONFIG','BANKSEL','PAGESEL','DT','DW','RADIX','LIST','PROCESSOR','ERRORLEVEL','#INCLUDE','INCLUDE'];
const known=new Set([...Object.keys(byteOps),...Object.keys(bitOps),...Object.keys(literalOps),...Object.keys(fixed),'MOVWF','CLRF',...directives]);
function definitions(variant:PicVariant):Map<string,number>{
  const s:Record<string,number>={W:0,F:1,INDF:0,TMR0:1,PCL:2,STATUS:3,FSR:4,PORTA:5,PORTB:6,PCLATH:10,INTCON:11,OPTION_REG:0x81,TRISA:0x85,TRISB:0x86,C:0,DC:1,Z:2,NOT_PD:3,NOT_TO:4,PD:3,TO:4,RP0:5,RP1:6,IRP:7,RBIF:0,INTF:1,T0IF:2,RBIE:3,INTE:4,T0IE:5,EEIE:6,PEIE:6,GIE:7,PS0:0,PS1:1,PS2:2,PSA:3,T0SE:4,T0CS:5,INTEDG:6,NOT_RBPU:7,RBPU:7};
  if(variant==='pic16f84a')Object.assign(s,{EEDATA:8,EEADR:9,EECON1:0x88,EECON2:0x89,RD:0,WR:1,WREN:2,WRERR:3,EEIF:4});
  else Object.assign(s,{PORTC:7,PORTD:8,PORTE:9,TRISC:0x87,TRISD:0x88,TRISE:0x89,PIR1:0xc,PIR2:0xd,TMR1L:0xe,TMR1H:0xf,T1CON:0x10,TMR2:0x11,T2CON:0x12,SSPBUF:0x13,SSPCON:0x14,CCPR1L:0x15,CCPR1H:0x16,CCP1CON:0x17,RCSTA:0x18,TXREG:0x19,RCREG:0x1a,CCPR2L:0x1b,CCPR2H:0x1c,CCP2CON:0x1d,ADRESH:0x1e,ADCON0:0x1f,PIE1:0x8c,PIE2:0x8d,PCON:0x8e,SSPCON2:0x91,PR2:0x92,SSPADD:0x93,SSPSTAT:0x94,TXSTA:0x98,SPBRG:0x99,CMCON:0x9c,CVRCON:0x9d,ADRESL:0x9e,ADCON1:0x9f,EEDATA:0x10c,EEADR:0x10d,EEDATH:0x10e,EEADRH:0x10f,EECON1:0x18c,EECON2:0x18d,ADON:0,GO:2,GO_DONE:2,ADFM:7,SPEN:7,TXEN:5,CREN:4,TXIF:4,RCIF:5,TMR1ON:0,TMR2ON:2,SSPEN:5});
  if(variant==='pic16f877a'){
    const fields:Record<string,string[]>={
      PIR1:['TMR1IF','TMR2IF','CCP1IF','SSPIF','TXIF','RCIF','ADIF','PSPIF'],
      PIR2:['CCP2IF','','','BCLIF','EEIF','','CMIF'],
      PIE1:['TMR1IE','TMR2IE','CCP1IE','SSPIE','TXIE','RCIE','ADIE','PSPIE'],
      PIE2:['CCP2IE','','','BCLIE','EEIE','','CMIE'],
      T1CON:['TMR1ON','TMR1CS','NOT_T1SYNC','T1OSCEN','T1CKPS0','T1CKPS1'],
      T2CON:['T2CKPS0','T2CKPS1','TMR2ON','TOUTPS0','TOUTPS1','TOUTPS2','TOUTPS3'],
      SSPCON:['SSPM0','SSPM1','SSPM2','SSPM3','CKP','SSPEN','SSPOV','WCOL'],
      SSPCON2:['SEN','RSEN','PEN','RCEN','ACKEN','ACKDT','ACKSTAT','GCEN'],
      SSPSTAT:['BF','UA','R_NOT_W','S','P','D_NOT_A','CKE','SMP'],
      CCP1CON:['CCP1M0','CCP1M1','CCP1M2','CCP1M3','DC1B0','DC1B1'],
      CCP2CON:['CCP2M0','CCP2M1','CCP2M2','CCP2M3','DC2B0','DC2B1'],
      RCSTA:['RX9D','OERR','FERR','ADDEN','CREN','SREN','RX9','SPEN'],
      TXSTA:['TX9D','TRMT','BRGH','','SYNC','TXEN','TX9','CSRC'],
      ADCON0:['ADON','','GO_DONE','CHS0','CHS1','CHS2','ADCS0','ADCS1'],
      ADCON1:['PCFG0','PCFG1','PCFG2','PCFG3','','','ADCS2','ADFM'],
      CMCON:['CM0','CM1','CM2','CIS','C1INV','C2INV','C1OUT','C2OUT'],
      CVRCON:['CVR0','CVR1','CVR2','CVR3','','CVRR','CVROE','CVREN'],
      EECON1:['RD','WR','WREN','WRERR','','','','EEPGD'],
      TRISE:['TRISE0','TRISE1','TRISE2','','PSPMODE','IBOV','OBF','IBF'],
      PCON:['NOT_BOR','NOT_POR'],
    };
    for(const bits of Object.values(fields))bits.forEach((name,bit)=>{if(name)s[name]=bit;});
    Object.assign(s,{R_W:2,D_A:5,CCP1X:5,CCP1Y:4,CCP2X:5,CCP2Y:4});
  }
  for(const [p,width]of (variant==='pic16f84a'?[5,8]:[6,8,8,8,3]).entries())for(let b=0;b<width;b++){s[`R${String.fromCharCode(65+p)}${b}`]=b;s[`TRIS${String.fromCharCode(65+p)}${b}`]=b;}
  Object.assign(s,{_CP_ON:0x000f,_CP_OFF:0x3fff,_WDT_OFF:0x3ffb,_WDT_ON:0x3fff,_PWRTE_ON:0x3ff7,_PWRTE_OFF:0x3fff,_LP_OSC:0x3ffc,_XT_OSC:0x3ffd,_HS_OSC:0x3ffe,_RC_OSC:0x3fff,_BODEN_OFF:0x3fbf,_BODEN_ON:0x3fff,_LVP_OFF:0x3f7f,_LVP_ON:0x3fff,_DEBUG_OFF:0x3fff,_CPD_OFF:0x3fff,_WRT_OFF:0x3fff});
  if(variant==='pic16f877a')Object.assign(s,{_CP_ON:0x1fff,_CPD_ON:0x3eff,_BOREN_ON:0x3fff,_BOREN_OFF:0x3fbf,_DEBUG_ON:0x37ff,_WRT_HALF:0x39ff,_WRT_1FOURTH:0x3bff,_WRT_256:0x3dff});
  return new Map(Object.entries(s));
}
function operands(s:string){return s.match(/(?:[^,"']|'[^']*'|"[^"]*")+/g)?.map(x=>x.trim())??[];}
/** A small integer expression parser; no JavaScript execution and no source text in errors. */
function expression(text:string,symbols:Map<string,number>,radix:number,pc:number,strict:boolean):number{
  const input=text;const tokens:string[]=[];let at=0;
  while(at<input.length){if(/\s/.test(input[at])){at++;continue;}const m=/^(?:[HBDO]'[^']*'|'[^']'|0X[0-9A-F]+|\.[0-9]+|[0-9][0-9A-F]*H?|[0-9][01]*B|[A-Z_][\w]*|<<|>>|[()+\-*/%&|^~$])/i.exec(input.slice(at));if(!m)throw new Error('invalid expression.');tokens.push(m[0][0]==="'"?m[0]:m[0].toUpperCase());at+=m[0].length;}
  let pos=0;const precedence:Record<string,number>={'|':1,OR:1,'^':2,XOR:2,'&':3,AND:3,'<<':4,SHL:4,'>>':4,SHR:4,'+':5,'-':5,'*':6,'/':6,'%':6,MOD:6};
  const parse=(level=0):number=>{
    const t=tokens[pos++];if(!t)throw new Error('missing expression.');let v:number;
    if(t==='('){v=parse();if(tokens[pos++]!==')')throw new Error('unbalanced parentheses.');}
    else if(['+','-','~','NOT','HIGH','LOW'].includes(t)){const n=parse(7);v=t==='-'?-n:t==='~'||t==='NOT'?~n:t==='HIGH'?(n>>>8)&255:t==='LOW'?n&255:n;}
    else if(t==='$')v=pc;
    else if(/^[HBDO]'/i.test(t)){const base={H:16,B:2,D:10,O:8}[t[0]]!;const digits=t.slice(2,-1);if(!digits||[...digits].some(c=>parseInt(c,16)>=base||!/[0-9A-F]/.test(c)))throw new Error('invalid number.');v=parseInt(digits,base);}
    else if(t[0]==="'")v=t.charCodeAt(1);
    else if(/^[0-9][0-9A-F]*H$/.test(t))v=parseInt(t.slice(0,-1),16);
    else if(/^0X/.test(t))v=parseInt(t.slice(2),16);
    else if(t[0]==='.')v=parseInt(t.slice(1),10);
    else if(/^\d/.test(t)){if(radix===10&&/[A-F]/.test(t))throw new Error('invalid decimal number.');v=parseInt(t,radix);}
    else if(symbols.has(t))v=symbols.get(t)!;
    else {if(strict)throw new Error('undefined symbol.');v=0;}
    while(pos<tokens.length){const op=tokens[pos],p=precedence[op];if(p===undefined||p<level)break;pos++;const b=parse(p+1);switch(op){case '+':v+=b;break;case '-':v-=b;break;case '*':v*=b;break;case '/':if(!b)throw new Error('division by zero.');v=Math.trunc(v/b);break;case '%':case 'MOD':v%=b;break;case '&':case 'AND':v&=b;break;case '|':case 'OR':v|=b;break;case '^':case 'XOR':v^=b;break;case '<<':case 'SHL':v<<=b;break;case '>>':case 'SHR':v>>>=b;break;}}
    return v;
  };
  const result=parse();if(pos!==tokens.length||!Number.isFinite(result))throw new Error('invalid expression.');return result;
}
export function assemblePic(source:string,variant:PicVariant='pic16f84a'):PicAssembly{
  const statements=source.split(/\r?\n/).map((raw,i)=>{
    const text=(raw.match(/(?:[^;"']|"[^"]*"|'[^']*')*/)?.[0]??'').trim();let rest=text,label:string|undefined;
    const first=/^([\w.$]+):?\s*/.exec(rest);
    if(first&&(rest.startsWith(first[1]+':')||(!known.has(first[1].toUpperCase())&&!rest.startsWith('#')))){label=first[1].toUpperCase();rest=rest.slice(first[0].length);}
    const m=/^(#?\w+)\b\s*(.*)$/.exec(rest);if(rest&&!m)throw new PicAsmError(i+1,'invalid statement.');
    return {line:i+1,label,op:m?.[1].toUpperCase()??'',args:m?.[2]??''};
  });
  const symbols=definitions(variant);let listing:PicListing[]=[],config:number|undefined;let image=new Map<number,number>();
  for(let pass=0;pass<3;pass++){
    let pc=0,radix=16,block:number|undefined;image=new Map();listing=[];const defined=new Set<string>();
    for(const st of statements){try{
      const {line,label,op,args}=st;
      const value=(s:string)=>expression(s,symbols,radix,pc,pass===2);
      const define=(name:string,v:number)=>{if(defined.has(name))throw new Error('duplicate symbol.');defined.add(name);symbols.set(name,v);};
      if(block!==undefined&&op!=='ENDC'){if(!label||op)throw new Error('invalid CBLOCK entry.');define(label,block++);continue;}
      if(label&&op!=='EQU'&&op!=='SET')define(label,pc);
      if(!op)continue;
      if(op==='END')break;
      if(op==='CONSTANT'||op==='VARIABLE'){for(const a of operands(args)){const m=/^([A-Z_]\w*)\s*=\s*(.*)$/i.exec(a);if(!m)throw new Error('invalid constant definition.');define(m[1].toUpperCase(),value(m[2]));}continue;}
      if(op==='EQU'||op==='SET'){if(!label)throw new Error('a symbol name is required.');define(label,value(args));continue;}
      if(op==='CBLOCK'){block=value(args);continue;}if(op==='ENDC'){if(block===undefined)throw new Error('ENDC without CBLOCK.');block=undefined;continue;}
      if(op==='ORG'){pc=value(args);continue;}
      if(op==='RADIX'){if(!/^(DEC|HEX)$/i.test(args))throw new Error('RADIX requires DEC or HEX.');radix=/DEC/i.test(args)?10:16;continue;}
      if(op==='LIST'){const r=/\bR\s*=\s*(DEC|HEX)/i.exec(args);if(r)radix=/DEC/i.test(r[1])?10:16;continue;}
      if(op==='PROCESSOR'||op==='ERRORLEVEL')continue;
      if(op==='#INCLUDE'||op==='INCLUDE'){if(!/^[<"]p16f(?:84a?|877a?)\.inc[>"]$/i.test(args))throw new Error('only the standard PIC16F84A and PIC16F877A includes are available.');continue;}
      if(op==='__CONFIG'){config=value(args)&0x3fff;continue;}
      const start=pc;
      const emit=(word:number)=>{if(pc<0||pc>= (variant==='pic16f84a'?1024:8192))throw new Error('program address is outside device memory.');if(image.has(pc))throw new Error('overlapping program data.');image.set(pc++,word&0x3fff);};
      const a=operands(args),need=(n:number)=>{if(a.length!==n)throw new Error('wrong operand count.');};
      const bounded=(s:string,min:number,max:number)=>{const v=value(s);if(pass===2&&(v<min||v>max))throw new Error('operand is out of range.');return v;};
      if(op==='DW'||op==='DT'){for(const item of a){if(/^(["']).*\1$/.test(item)&&item.length>3){for(const ch of item.slice(1,-1))emit((op==='DT'?0x3400:0)|ch.charCodeAt(0));}else emit((op==='DT'?0x3400:0)|bounded(item,0,op==='DT'?255:0x3fff));}}
      else if(op==='BANKSEL'||op==='PAGESEL'){need(1);const v=value(a[0]),bank=op==='BANKSEL';for(let b=0;b<(bank?(variant==='pic16f84a'?1:2):(variant==='pic16f84a'?0:2));b++){const bit=(bank?5:3)+b;emit(((v&(1<<((bank?7:11)+b)))?0x1400:0x1000)|(bit<<7)|(bank?3:10));}}
      else if(fixed[op]!==undefined){need(0);emit(fixed[op]);}
      else if(op==='MOVWF'||op==='CLRF'){need(1);emit((op==='MOVWF'?0x80:0x180)|(bounded(a[0],0,511)&127));}
      else if(byteOps[op]!==undefined){if(a.length<1||a.length>2)throw new Error('wrong operand count.');const d=a.length===1?1:bounded(a[1],0,1);emit(byteOps[op]|(d<<7)|(bounded(a[0],0,511)&127));}
      else if(bitOps[op]!==undefined){need(2);emit(bitOps[op]|(bounded(a[1],0,7)<<7)|(bounded(a[0],0,511)&127));}
      else if(literalOps[op]!==undefined){need(1);const jump=op==='CALL'||op==='GOTO';emit(literalOps[op]|(bounded(a[0],jump?0:-128,jump?8191:255)&(jump?2047:255)));}
      else throw new Error('unknown instruction or directive.');
      listing.push({address:start,line,size:pc-start,mnemonic:op});
    }catch(e){throw new PicAsmError(st.line,e instanceof Error?e.message:'invalid statement.');}}
    if(block!==undefined)throw new PicAsmError(statements.length,'CBLOCK is missing ENDC.');
  }
  if(!image.size)throw new PicAsmError(0,'the program contains no code.');
  const top=Math.max(...image.keys())+1,code=new Uint8Array(top*2);code.fill(255);for(const [a,w]of image){code[2*a]=w&255;code[2*a+1]=w>>>8;}
  return {code,symbols,listing,config};
}
