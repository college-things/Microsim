import { FLOW_ARITY, FLOW_EXAMPLE, validateFlowProgram, type FlowProgram, type FlowOp } from '../core/dataflow';

const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};
/** Editable blocks and connections; programs remain ordinary saved document data. */
export function dataflowEditor(host:HTMLElement,initial:FlowProgram|undefined,changed:()=>void):()=>FlowProgram {
  let program=structuredClone(initial??FLOW_EXAMPLE);
  const description=el('p','Local numeric dataflow runs in this app without NI software. Connect blocks by name. Select uses condition, true, false inputs. Delay and integrate break feedback loops; state advances only when simulation time advances.');
  const graph=document.createElementNS('http://www.w3.org/2000/svg','svg');
  graph.classList.add('flow-diagram');graph.setAttribute('role','img');graph.setAttribute('aria-label','Dataflow block connections');
  const table=el('table');table.className='flow-table';
  const outputTable=el('table');outputTable.className='flow-table';
  const diagram=()=>{
    graph.replaceChildren();const count=program.nodes.length,height=Math.max(70,count*45+15);graph.setAttribute('viewBox',`0 0 640 ${height}`);
    const ns='http://www.w3.org/2000/svg';
    const shape=(tag:string,attrs:Record<string,string>)=>{const node=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);graph.append(node);return node;};
    program.nodes.forEach((node,i)=>{
      (node.inputs??[]).forEach((id,port)=>{const from=program.nodes.findIndex(n=>n.id===id);if(from<0)return;const lane=400+port*28;
        shape('path',{d:`M 370 ${from*45+32} H ${lane} V ${i*45+32} H 370`,fill:'none',stroke:node.op==='delay'||node.op==='integrate'?'#b57412':'#357ac5','stroke-width':'2'});
      });
    });
    program.nodes.forEach((node,i)=>{
      shape('rect',{x:'10',y:String(i*45+15),width:'360',height:'34',rx:'5',fill:'var(--bg, #fff)',stroke:'#357ac5'});
      const text=shape('text',{x:'20',y:String(i*45+37),fill:'var(--fg, #222)','font-size':'14'});text.textContent=`${node.id}: ${node.op}${node.op==='input'?` (${node.signal})`:node.op==='constant'?` (${node.value})`:''}`;
      const names=Object.entries(program.outputs).filter(([,id])=>id===node.id).map(([name])=>name);
      if(names.length){const label=shape('text',{x:'490',y:String(i*45+37),fill:'#357ac5','font-size':'12'});label.textContent=`→ ${names.join(', ')}`;}
    });
  };
  const input=(label:string,value:string,change:(value:string)=>void)=>{const field=el('input');field.value=value;field.setAttribute('aria-label',label);field.onchange=()=>{changed();change(field.value);diagram();};return field;};
  const select=(label:string,value:string,options:string[],change:(value:string)=>void)=>{const field=el('select');field.setAttribute('aria-label',label);for(const name of [...new Set([value,...options])]){const opt=el('option',name||'Choose block');opt.value=name;field.append(opt);}field.value=value;field.onchange=()=>{changed();change(field.value);diagram();};return field;};
  const action=(text:string,fn:()=>void)=>{const button=el('button',text);button.type='button';button.onclick=()=>{changed();fn();render();};return button;};
  const cell=(row:HTMLTableRowElement,node:HTMLElement)=>{const td=el('td');td.append(node);row.append(td);};
  const render=()=>{
    table.replaceChildren();const head=el('tr');for(const title of ['Block name','Operation','Connections / settings',''])head.append(el('th',title));table.append(head);
    for(const node of program.nodes){
      const row=el('tr');
      cell(row,input(`Block ${node.id} name`,node.id,value=>{const old=node.id;node.id=value;for(const n of program.nodes)n.inputs=n.inputs?.map(id=>id===old?value:id);for(const name of Object.keys(program.outputs))if(program.outputs[name]===old)program.outputs[name]=value;render();}));
      cell(row,select(`Block ${node.id} operation`,node.op,Object.keys(FLOW_ARITY),value=>{node.op=value as FlowOp;node.inputs=Array.from({length:FLOW_ARITY[node.op]},(_,i)=>node.inputs?.[i]??'');if(['constant','input','delay','integrate'].includes(node.op))node.value??=0;if(node.op==='input')node.signal??='v(out)';render();}));
      const settings=el('div');
      if(node.op==='input')settings.append(input(`${node.id} signal`,node.signal??'',value=>{node.signal=value;}));
      if(['constant','input','delay','integrate'].includes(node.op)){const value=input(`${node.id} ${node.op==='input'?'fallback':node.op==='constant'?'value':'initial value'}`,String(node.value??0),value=>{node.value=Number(value);});value.type='number';value.step='any';settings.append(value);}
      (node.inputs??[]).forEach((ref,index)=>settings.append(select(`${node.id} input ${index+1}`,ref,program.nodes.map(n=>n.id),value=>{node.inputs![index]=value;})));
      cell(row,settings);cell(row,action(`Remove ${node.id}`,()=>{program.nodes=program.nodes.filter(n=>n!==node);}));table.append(row);
    }
    outputTable.replaceChildren();const outHead=el('tr');for(const title of ['Output signal','Block',''])outHead.append(el('th',title));outputTable.append(outHead);
    for(const [name,id]of Object.entries(program.outputs)){const row=el('tr');cell(row,input(`Output ${name} name`,name,value=>{if(value!==name){if(!Object.hasOwn(program.outputs,value))program.outputs=Object.fromEntries(Object.entries(program.outputs).map(([key,id])=>[key===name?value:key,id]));render();}}));cell(row,select(`Output ${name} block`,id,program.nodes.map(n=>n.id),value=>{program.outputs[name]=value;}));cell(row,action(`Remove output ${name}`,()=>{delete program.outputs[name];}));outputTable.append(row);}
    diagram();
  };
  const actions=el('div');actions.className='design-controls';actions.append(action('Add block',()=>{let n=1;while(program.nodes.some(node=>node.id===`block${n}`))n++;program.nodes.push({id:`block${n}`,op:'constant',value:0});}),action('Add output',()=>{let n=1;while(Object.hasOwn(program.outputs,`output${n}`))n++;program.outputs[`output${n}`]=program.nodes[0]?.id??'';}),action('Load controller example',()=>{program=structuredClone(FLOW_EXAMPLE);}));
  host.append(description,graph,table,el('p','Program outputs'),outputTable,actions);render();
  return ()=>{validateFlowProgram(program);return structuredClone(program);};
}
