import { describe, expect, it } from 'vitest';
import { FLOW_EXAMPLE, FlowRuntime, validateFlowProgram, type FlowProgram } from '../../src/core/dataflow';
import { buildExample, EXAMPLES } from '../../src/core/examples';
import { serializeCircuit, parseCircuit } from '../../src/core/file';
import { serializeMs14 } from '../../src/importer/writer';
import { importMs14 } from '../../src/importer';
import { validateWorkspace } from '../../src/core/engineering';

describe('independent numeric dataflow',()=>{
  it('evaluates dependencies regardless of block order, with real inputs and finite fallbacks',()=>{
    const p=structuredClone(FLOW_EXAMPLE);p.nodes.reverse();const runtime=new FlowRuntime(p);
    expect(runtime.step(0,{'v(out)':2})).toEqual({drive:1});
    expect(runtime.step(0,{'v(out)':1})).toEqual({drive:3});
    expect(runtime.step(1,{})).toEqual({drive:5});
    // Changing the editor document cannot mutate a running program.
    p.nodes.find(n=>n.id==='gain')!.value=99;
    expect(runtime.step(2,{})).toEqual({drive:5});
  });
  it('supports feedback through a unit delay, but never advances on duplicate timestamps',()=>{
    const runtime=new FlowRuntime({version:1,nodes:[{id:'sum',op:'add',inputs:['memory','one']},{id:'memory',op:'delay',inputs:['sum'],value:0},{id:'one',op:'constant',value:1}],outputs:{count:'sum',previous:'memory'}});
    expect(runtime.step(0,{})).toEqual({count:1,previous:0});
    expect(runtime.step(0,{})).toEqual({count:1,previous:0});
    expect(runtime.step(1,{})).toEqual({count:2,previous:1});
    expect(runtime.step(2,{})).toEqual({count:3,previous:2});
    expect(runtime.step(0,{})).toEqual({count:1,previous:0});
  });
  it('integrates the previous sample with actual elapsed simulation time and resets cleanly',()=>{
    const runtime=new FlowRuntime({version:1,nodes:[{id:'speed',op:'input',signal:'speed'},{id:'distance',op:'integrate',inputs:['speed'],value:10}],outputs:{distance:'distance'}});
    expect(runtime.step(0,{speed:2})).toEqual({distance:10});
    expect(runtime.step(0.5,{speed:4})).toEqual({distance:11});
    expect(runtime.step(0.5,{speed:4})).toEqual({distance:11});
    expect(runtime.step(2,{speed:0})).toEqual({distance:17});
    runtime.reset();expect(runtime.step(2,{speed:8})).toEqual({distance:10});
  });
  it('does not commit time or memory after an invalid arithmetic result',()=>{
    const runtime=new FlowRuntime({version:1,nodes:[{id:'source',op:'input',signal:'u'},{id:'memory',op:'delay',inputs:['source'],value:3},{id:'bad',op:'divide',inputs:['memory','source']}],outputs:{value:'bad'}});
    expect(runtime.step(0,{u:2})).toEqual({value:1.5});
    expect(()=>runtime.step(1,{u:0})).toThrow('division by zero');
    expect(runtime.step(2,{u:4})).toEqual({value:0.5});
    expect(()=>runtime.step(0,{u:0})).toThrow('division by zero');
    expect(runtime.step(3,{u:2})).toEqual({value:2});
  });
  it('implements numeric selection, comparisons, time and elementary functions',()=>{
    const p:FlowProgram={version:1,nodes:[{id:'time',op:'time'},{id:'one',op:'constant',value:1},{id:'minus',op:'subtract',inputs:['time','one']},{id:'positive',op:'greater',inputs:['minus','one']},{id:'absolute',op:'abs',inputs:['minus']},{id:'sine',op:'sin',inputs:['time']},{id:'minimum',op:'min',inputs:['absolute','one']},{id:'maximum',op:'max',inputs:['absolute','one']},{id:'choice',op:'select',inputs:['positive','minimum','maximum']}],outputs:{choice:'choice',sine:'sine'}};
    const runtime=new FlowRuntime(p);
    expect(runtime.step(0,{})).toEqual({choice:1,sine:0});
    expect(runtime.step(3,{})).toEqual({choice:1,sine:Math.sin(3)});
  });
  it('rejects missing wires, combinational feedback, malformed operations and excessive graphs',()=>{
    expect(()=>validateFlowProgram({version:1,nodes:[{id:'x',op:'add',inputs:['x','x']}],outputs:{x:'x'}})).toThrow('feedback');
    expect(()=>validateFlowProgram({version:1,nodes:[{id:'x',op:'delay',value:0,inputs:['missing']}],outputs:{x:'x'}})).toThrow('missing block');
    expect(()=>validateFlowProgram({version:1,nodes:[{id:'x',op:'constructor'}],outputs:{x:'x'}})).toThrow('unknown operation');
    expect(()=>validateFlowProgram({...FLOW_EXAMPLE,nodes:Array(513).fill(FLOW_EXAMPLE.nodes[0])})).toThrow('512');
    expect(()=>validateFlowProgram({...FLOW_EXAMPLE,outputs:{bad:'missing'}})).toThrow('invalid output');
    const runtime=new FlowRuntime(FLOW_EXAMPLE);
    expect(()=>runtime.step(NaN,{})).toThrow('finite');
    expect(()=>runtime.step(0,{bad:Infinity})).toThrow('finite');
  });
  it('saves the editable local program in both project formats and validates loaded programs',()=>{
    const schematic=buildExample(EXAMPLES[0]);
    schematic.workspace={labview:{mode:'local',url:'',inputs:{'v(out)':0},outputs:{drive:'V1'},program:structuredClone(FLOW_EXAMPLE)}};
    const file={schematic,analyses:[],issues:[]};
    expect(parseCircuit(serializeCircuit(file)).schematic.workspace).toEqual(schematic.workspace);
    expect(importMs14(serializeMs14(file)).schematic.workspace).toEqual(schematic.workspace);
    expect(()=>validateWorkspace({labview:{mode:'local',url:'',inputs:{},outputs:{}}})).toThrow('workspace');
    schematic.workspace.labview!.program!.nodes[0].op='unknown' as never;
    expect(()=>validateWorkspace(schematic.workspace)).toThrow('unknown operation');
  });
});
