import {expect,it} from 'vitest';
import {boardFabricationFiles,fabricationZip} from '../../src/core/fabrication';
import {boardToKicad,checkBoard,validateWorkspace,type Board} from '../../src/core/engineering';
function board():Board{return {width:60,height:40,clearance:0.25,footprints:[{component:'a',ref:'J1',x:10,y:10,rotation:0,pads:[{pin:'1',net:'signal',x:0,y:0,diameter:2,drill:1}]},{component:'b',ref:'J2',x:40,y:10,rotation:0,pads:[{pin:'1',net:'signal',x:0,y:0}]}],vias:[],tracks:[{net:'signal',layer:'F.Cu',width:0.4,points:[{x:10,y:10},{x:25,y:10}]},{net:'signal',layer:'B.Cu',width:0.4,points:[{x:25,y:10},{x:40,y:10}]}]};}
it('requires a plated via to connect copper on different layers',()=>{
 const b=board();expect(checkBoard(b).join()).toMatch(/unconnected/);
 b.vias!.push({x:25,y:10,net:'signal',diameter:0.8,drill:0.4});expect(checkBoard(b)).toEqual([]);
 const pcb=boardToKicad(b);expect(pcb).toContain('(via (at 25 10) (size 0.8) (drill 0.4)');expect(pcb).toContain('(size 2 2) (drill 1)');
});
it('exports the same rotated pad and via positions in copper, mask and NC drills',()=>{
 const b=board();b.vias!.push({x:25,y:10,net:'signal',diameter:0.8,drill:0.4});
 const files=boardFabricationFiles(b);
 expect(Object.keys(files)).toHaveLength(7);
 expect(files['front-copper.gtl']).toContain('X25000000Y30000000D03*');
 expect(files['back-copper.gbl']).toContain('X25000000Y30000000D03*');
 expect(files['front-mask.gts']).toContain('C,0.900000');
 expect(files['plated-drills.drl']).toContain('X25.000000Y30.000000');
 expect(files['plated-drills.drl']).toContain('C1.000000');
 expect(fabricationZip(files).slice(0,4)).toEqual(new Uint8Array([0x50,0x4b,3,4]));
 b.vias![0].drill=1;expect(()=>validateWorkspace({board:b})).toThrow();
});
it('rejects fabrication of boards with disconnected pads or clearance failures',()=>{
 const b=board();expect(()=>boardFabricationFiles(b)).toThrow(/unconnected/);
 b.vias!.push({x:25,y:10,net:'signal',diameter:0.8,drill:0.4});b.footprints[1].pads[0].net='other';
 expect(()=>boardFabricationFiles(b)).toThrow(/clearance/);
});
