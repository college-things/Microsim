/** Independent numeric dataflow engine. No NI runtime, VI code or dynamic JS evaluation. */
export type FlowOp = 'input' | 'constant' | 'time' | 'add' | 'subtract' | 'multiply' | 'divide' | 'sin' | 'abs' | 'min' | 'max' | 'greater' | 'select' | 'delay' | 'integrate';
export interface FlowNode { id: string; op: FlowOp; inputs?: string[]; value?: number; signal?: string }
export interface FlowProgram { version: 1; nodes: FlowNode[]; outputs: Record<string, string> }
export const FLOW_ARITY: Record<FlowOp, number> = {input:0,constant:0,time:0,add:2,subtract:2,multiply:2,divide:2,sin:1,abs:1,min:2,max:2,greater:2,select:3,delay:1,integrate:1};
export const FLOW_EXAMPLE: FlowProgram = {version:1,nodes:[{id:'measured',op:'input',signal:'v(out)',value:0},{id:'setpoint',op:'constant',value:2.5},{id:'error',op:'subtract',inputs:['setpoint','measured']},{id:'gain',op:'constant',value:2},{id:'drive',op:'multiply',inputs:['error','gain']}],outputs:{drive:'drive'}};

function compile(value: unknown): {program: FlowProgram; order: FlowNode[]} {
  const fail = (message: string): never => { throw new Error(`Dataflow: ${message}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected a program.');
  const p = value as FlowProgram;
  if (p.version !== 1 || !Array.isArray(p.nodes) || !p.nodes.length || p.nodes.length > 512) fail('use version 1 and 1–512 blocks.');
  const nodes = new Map<string, FlowNode>();
  for (const node of p.nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !/^[a-zA-Z_][\w-]{0,63}$/.test(node.id) || nodes.has(node.id)) fail('block names must be unique identifiers.');
    if (!Object.hasOwn(FLOW_ARITY,node.op)) fail(`${node.id}: unknown operation.`);
    if (node.inputs !== undefined && (!Array.isArray(node.inputs) || !node.inputs.every(x=>typeof x==='string'))) fail(`${node.id}: invalid connections.`);
    if ((node.inputs?.length ?? 0) !== FLOW_ARITY[node.op]) fail(`${node.id}: ${node.op} needs ${FLOW_ARITY[node.op]} connections.`);
    if (['constant','delay','integrate'].includes(node.op) && (typeof node.value !== 'number' || !Number.isFinite(node.value))) fail(`${node.id}: supply a finite initial value.`);
    if (node.value !== undefined && (typeof node.value !== 'number' || !Number.isFinite(node.value))) fail(`${node.id}: invalid fallback value.`);
    if (node.op === 'input' && (typeof node.signal !== 'string' || !node.signal.length || node.signal.length > 256)) fail(`${node.id}: supply an input signal name.`);
    nodes.set(node.id,node);
  }
  for (const node of p.nodes) for (const ref of node.inputs ?? []) if (!nodes.has(ref)) fail(`${node.id}: missing block ${ref}.`);
  if (!p.outputs || typeof p.outputs !== 'object' || Array.isArray(p.outputs) || !Object.keys(p.outputs).length || Object.keys(p.outputs).length > 256) fail('supply 1–256 output signals.');
  for (const [name,id] of Object.entries(p.outputs)) if (!name.length || name.length > 256 || typeof id !== 'string' || !nodes.has(id)) fail(`invalid output ${name}.`);
  const order: FlowNode[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const visit = (node: FlowNode) => {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) fail(`${node.id}: feedback needs a delay or integrator block.`);
    visiting.add(node.id);
    // State is read before combinational evaluation; feedback crosses a frame boundary.
    if (node.op !== 'delay' && node.op !== 'integrate') for (const ref of node.inputs ?? []) visit(nodes.get(ref)!);
    visiting.delete(node.id); visited.add(node.id); order.push(node);
  };
  p.nodes.forEach(visit);
  return {program:p,order};
}
export function validateFlowProgram(value: unknown): asserts value is FlowProgram { compile(value); }

export class FlowRuntime {
  private readonly program: FlowProgram;
  private readonly order: FlowNode[];
  private state = new Map<string,number>();
  private staged = new Map<string,number>();
  private time: number | undefined;
  constructor(program: FlowProgram) {
    const compiled=compile(structuredClone(program)); this.program=compiled.program; this.order=compiled.order;
    this.reset();
  }
  reset() {
    this.time=undefined;this.state.clear();this.staged.clear();
    for (const node of this.program.nodes) if (node.op==='delay'||node.op==='integrate') this.state.set(node.id,node.value!);
  }
  step(time: number, signals: Record<string,number>): Record<string,number> {
    if (!Number.isFinite(time) || time < 0 || !signals || typeof signals !== 'object' || Array.isArray(signals) || !Object.values(signals).every(Number.isFinite)) throw new Error('Dataflow: time and input signals must be finite; time must be nonnegative.');
    // Work on copies: a failed arithmetic operation must not partially advance state.
    const rewound=this.time !== undefined && time < this.time;
    const previousTime=rewound?undefined:this.time;
    const state=rewound?new Map(this.program.nodes.filter(n=>n.op==='delay'||n.op==='integrate').map(n=>[n.id,n.value!])):new Map(this.state),staged=new Map<string,number>();
    if (previousTime !== undefined && time > previousTime) for (const node of this.program.nodes) {
      if (node.op==='delay') state.set(node.id,this.staged.get(node.id)!);
      if (node.op==='integrate') state.set(node.id,state.get(node.id)!+(time-previousTime)*this.staged.get(node.id)!);
    }
    const values=new Map<string,number>();
    for (const node of this.order) {
      const a=(node.inputs??[]).map(id=>values.get(id)!);
      let result: number;
      switch(node.op) {
        case 'input': result=Object.hasOwn(signals,node.signal!)?signals[node.signal!]:node.value??0;break;
        case 'constant': result=node.value!;break;
        case 'time': result=time;break;
        case 'delay': case 'integrate': result=state.get(node.id)!;break;
        case 'add': result=a[0]+a[1];break;
        case 'subtract': result=a[0]-a[1];break;
        case 'multiply': result=a[0]*a[1];break;
        case 'divide': if(a[1]===0)throw new Error(`Dataflow: ${node.id}: division by zero.`);result=a[0]/a[1];break;
        case 'sin': result=Math.sin(a[0]);break;
        case 'abs': result=Math.abs(a[0]);break;
        case 'min': result=Math.min(a[0],a[1]);break;
        case 'max': result=Math.max(a[0],a[1]);break;
        case 'greater': result=a[0]>a[1]?1:0;break;
        case 'select': result=a[0]!==0?a[1]:a[2];break;
      }
      if (!Number.isFinite(result)) throw new Error(`Dataflow: ${node.id}: non-finite result.`);
      values.set(node.id,result);
    }
    for (const node of this.program.nodes) if(node.op==='delay'||node.op==='integrate') staged.set(node.id,values.get(node.inputs![0])!);
    this.state=state;this.staged=staged;this.time=time;
    return Object.fromEntries(Object.entries(this.program.outputs).map(([name,id])=>[name,values.get(id)!]));
  }
}
