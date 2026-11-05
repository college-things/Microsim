import {expect,it} from 'vitest';
import {niPartToDatabasePart} from '../../src/core/ni-database';
import {buildNetlist} from '../../src/core/netlist';
import {emptySchematic} from '../../src/core/schematic';
import {simulate} from '../../src/engine';
it('converts NI pin templates and multi-section devices into executable component text',()=>{
 const part=niPartToDatabasePart({id:'1',name:'Dual diode',manufacturer:'Test',family:'Diodes',prefix:'D',model:'TEST_D',choices:['TEST_D'],pinNames:['A','B','GND'],templates:['d%pA %tA %tGND %m','d%pB %tB %tGND %m'],definitions:'.model TEST_D D(Is=1n)',source:'fixture'});
 part.component.pins.forEach(p=>p.net='0');
 const schematic=emptySchematic('Test');schematic.components=[part.component];schematic.definitions=part.definitions;
 const net=buildNetlist(schematic);
 expect(net.errors).toEqual([]);
 expect(net.text.match(/TEST_D/g)!.length).toBe(3);
 expect(simulate(net.text,{type:'op'}).warnings).toEqual([]);
});
