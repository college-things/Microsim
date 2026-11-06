import { describe, expect, it } from 'vitest';
import { assemblePic } from '../../src/engine/asmpic';
import { picWords } from '../../src/engine/pic16';
import { gpasm, compareGpasm } from './pic-tools';
const words=(s:string)=>Array.from(picWords(assemblePic(s).code,'pic16f84a'));
describe('PIC assembler',()=>{
  it('encodes all 35 instructions with independently specified words',()=>{
    const source=['ADDWF 20,W','ANDWF 20,F','CLRF 20','CLRW','COMF 20,0','DECF 20,1','DECFSZ 20,0','INCF 20,1','INCFSZ 20,0','IORWF 20,1','MOVF 20,0','MOVWF 20','NOP','RLF 20,1','RRF 20,0','SUBWF 20,1','SWAPF 20,0','XORWF 20,1','BCF 20,2','BSF 20,2','BTFSC 20,2','BTFSS 20,2','ADDLW 42','ANDLW 42','CALL 42','CLRWDT','GOTO 42','IORLW 42','MOVLW 42','RETFIE','RETLW 42','RETURN','SLEEP','SUBLW 42','XORLW 42'].join('\n');
    expect(words(source)).toEqual([0x720,0x5a0,0x1a0,0x100,0x920,0x3a0,0xb20,0xaa0,0xf20,0x4a0,0x820,0xa0,0,0xda0,0xc20,0x2a0,0xe20,0x6a0,0x1120,0x1520,0x1920,0x1d20,0x3e42,0x3942,0x2042,0x64,0x2842,0x3842,0x3042,9,0x3442,8,0x63,0x3c42,0x3a42]);
  });
  it('supports MPASM radixes, decimal dot notation, and decimal or hexadecimal defaults',()=>{expect(words("MOVLW 10\nMOVLW H'10'\nMOVLW 0x10\nMOVLW B'10'\nMOVLW D'10'\nMOVLW .10\nRADIX DEC\nMOVLW 10\nRADIX HEX\nMOVLW 10h")).toEqual([0x3010,0x3010,0x3010,0x3002,0x300a,0x300a,0x300a,0x3010]);});
  it('resolves labels, EQU, CBLOCK, BANKSEL, PAGESEL, ORG and listing word addresses',()=>{
    const r=assemblePic('#include <p16f877a.inc>\nCBLOCK 20\ncounter\ntemp\nENDC\nlimit EQU D\'10\'\nBANKSEL TRISB\nCLRF TRISB\nBANKSEL counter\nPAGESEL target\nGOTO target\nORG 810\ntarget: MOVLW limit\nEND\ninvalid', 'pic16f877a');
    expect(r.symbols.get('COUNTER')).toBe(0x20);expect(r.symbols.get('TEMP')).toBe(0x21);expect(r.symbols.get('TARGET')).toBe(0x810);
    expect(Array.from(picWords(r.code,'pic16f877a').slice(0,8))).toEqual([0x1683,0x1303,0x186,0x1283,0x1303,0x158a,0x120a,0x2810]);expect(r.listing.at(-1)).toMatchObject({address:0x810,line:13,size:1,mnemonic:'MOVLW'});
  });
  it('records configuration and emits DT strings, DW words, expressions and character case',()=>{const r=assemblePic("__CONFIG _CP_OFF & _WDT_OFF\nvalue EQU (2+3)*4\nDT \"Ab\",value,LOW H'1234'\nDW H'1234'\nMOVLW 'a'");expect(r.config).toBe(0x3ffb);expect(Array.from(picWords(r.code,'pic16f84a'))).toEqual([0x3441,0x3462,0x3414,0x3434,0x1234,0x3061]);});
  it('recognizes F84 includes and initialization constants',()=>{expect(words('include "p16f84a.inc"\nCONSTANT count=20, mask=1\nMOVLW count\nBSF STATUS,RP0\nMOVWF TRISB')).toEqual([0x3020,0x1683,0x86]);});
  it.each(['MOVLW missing','MOVLW 100','BCF 20,8','MOVWF 20,0','NOP 1','ORG 400\nNOP','NOP\nORG 0\nNOP','CBLOCK 20\nx','INCLUDE "other.inc"','MOVLW D\'AB\'','ORG -1\nNOP','CBLOCK 20\nx\nx\nENDC\nNOP','DW 4000'])('reports a line without echoing source (%#)',source=>{try{assemblePic(source);throw new Error('expected an error');}catch(e){expect((e as Error).message).toMatch(/^PIC assembly line \d+:/);expect((e as Error).message).not.toContain(source);}});
});

it.skipIf(!gpasm)('agrees with installed gpasm on the instruction set and bank/page directives',()=>{
  const source=`LIST P=16F877A
#include <p16f877a.inc>
__CONFIG _CP_OFF & _WDT_OFF
CBLOCK 20
counter
ENDC
BANKSEL TRISB
CLRF TRISB
BANKSEL counter
MOVLW H'42'
MOVWF counter
ADDWF counter,F
SUBWF counter,W
ANDWF counter,F
IORWF counter,F
XORWF counter,W
MOVF counter,W
COMF counter,F
DECF counter,W
INCF counter,F
DECFSZ counter,F
INCFSZ counter,W
SWAPF counter,W
RLF counter,F
RRF counter,W
BCF STATUS,C
BSF STATUS,DC
BTFSC STATUS,Z
BTFSS STATUS,C
CLRW
NOP
CLRWDT
ADDLW 1
SUBLW H'80'
ANDLW 3
IORLW 1
XORLW 2
PAGESEL target
CALL target
GOTO target
ORG H'810'
target: RETLW 1
RETURN
RETFIE
SLEEP
DT "Ab",0
DW H'1234'
END`;
  compareGpasm(assemblePic(source,'pic16f877a'),'pic16f877a',{source});
});
