import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NiCatalog,openNiDatabase} from './ni-database.mjs';
const rows={
 SYS_COMPONENT:[{Component_ID:1,Component_Name:'DUAL',Manufacturer:'Example',Family_ID:2,Pinout:'A\nB\nGND\nC\nD\nGND',Pin_Number:6,Sec_Number:2}],
 SYS_CONFIGURATION:[{Family_ID:2,Family_Name:'Amplifiers',Template:'U%d'}],
 SYS_MAPPING_COMP_MODEL:[{Component_ID:1,Model_ID:'DUAL',Sec_Order:2,Template:'x%pB %tC %tD %tGND %m'},{Component_ID:1,Model_ID:'DUAL',Sec_Order:1,Template:'x%pA %tA %tB %tGND %m'}],
 SYS_MODEL:[{MODEL_ID:'DUAL',Manufacturer:'Example',DATA:'.subckt DUAL 1 2 3\nD1 1 2 CHILD\n.ends DUAL'},{MODEL_ID:'CHILD',Manufacturer:'Generic',DATA:'.model CHILD D(Is=1n)'}],
};
test('NI catalogue searches and retains model dependencies and all sections',()=>{
 const db=new NiCatalog(name=>rows[name]??[]);
 assert.equal(db.search('dual amplifiers').total,1);
 assert.equal(db.search('absent').total,0);
 const part=db.part(1);
 assert.deepEqual(part.pinNames,['A','B','GND','C','D']);
 assert.match(part.templates[0],/%pA/);
 assert.equal(part.templates.length,2);
 assert.match(part.definitions,/model CHILD/);
 assert.throws(()=>db.part(1,'unknown'),/variants/);
 rows.SYS_MAPPING_COMP_MODEL[0].Template='x%p #1 %m';
 assert.throws(()=>db.part(1),/instance parameters/);
 rows.SYS_MAPPING_COMP_MODEL[0].Template='x%pB %tC %tD %tGND %m';
});
test('installed NI database, when explicitly selected', {skip:!process.env.MICROSIM_TEST_NI_DB},async()=>{
 const db=await openNiDatabase(process.env.MICROSIM_TEST_NI_DB);
 assert.ok(db.summary().count>1000);
 for(const name of ['2N3904','1N4148','LM358N']){
  const match=db.search(name).items.find(p=>p.name===name);
  assert.ok(match,name); const part=db.part(match.id);
  assert.ok(part.templates.length);assert.match(part.definitions,/\.(model|subckt)/i);
 }
});
