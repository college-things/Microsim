/** Intel HEX reader for a 64 KiB 8051 program address space. */
export function readIntelHex(text:string):Uint8Array {
  const code=new Uint8Array(65536);code.fill(0xff);
  let base=0,eof=false,data=false;const written=new Set<number>();
  for(const [index,raw]of text.trim().split(/\r?\n/).entries()){
    const line=raw.trim();if(!line)continue;
    const fail=(message:string):never=>{throw new Error(`Intel HEX line ${index+1}: ${message}`);};
    if(eof)fail('record after end of file.');
    if(!/^:[\da-f]+$/i.test(line)||line.length%2!==1)fail('invalid record.');
    const bytes=Uint8Array.from(line.slice(1).match(/../g)!.map(b=>parseInt(b,16)));
    if(bytes.length!==bytes[0]+5)fail('invalid byte count.');
    if(bytes.reduce((a,b)=>a+b,0)%256)fail('checksum mismatch.');
    const count=bytes[0],address=(bytes[1]<<8)|bytes[2],type=bytes[3],payload=bytes.slice(4,-1);
    if(type===0){
      if(base+address+count>65536)fail('program exceeds 64 KiB.');
      payload.forEach((b,i)=>{const at=base+address+i;if(written.has(at)&&code[at]!==b)fail('conflicting overlapping data.');code[at]=b;written.add(at);});data ||= count>0;
    }else if(type===1){if(count||address)fail('invalid end record.');eof=true;}
    else if(type===2||type===4){if(count!==2||address)fail('invalid extended address.');base=((payload[0]<<8)|payload[1])*(type===2?16:65536);}
    else if(type===3||type===5){if(count!==4||address)fail('invalid start address.');/* 8051 starts at reset vector 0. */}
    else fail(`unsupported record type ${type}.`);
  }
  if(!eof||!data)throw new Error('Intel HEX: program data and an end record are required.');
  return code;
}
export function programHex(code:Uint8Array):string {
  if(!code.length||code.length>65536)throw new Error('8051 program must contain 1–65536 bytes.');
  return Array.from(code,b=>b.toString(16).padStart(2,'0')).join('');
}
