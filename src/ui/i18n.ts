import { MESSAGES } from './locales/messages';
export type Locale = 'en'|'uk'|'ru';
let locale: Locale='en';
const listeners=new Set<()=>void>();
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const patterns=Object.entries(MESSAGES).filter(([key])=>/\{\d+\}/.test(key)).map(([key,values])=>{
  const slots=[...key.matchAll(/\{(\d+)\}/g)].map(m=>m[1]);
  return {regex:new RegExp('^'+key.split(/\{\d+\}/).map(escape).join('([\\s\\S]*?)')+'$'),slots,values};
});
export function t(source:string, language:Locale=locale):string {
  if(language==='en'||!source)return source;
  if(source.includes('\n'))return source.split('\n').map(line=>t(line,language)).join('\n');
  const leading=source.match(/^\s*/)?.[0]??'',trailing=source.match(/\s*$/)?.[0]??'',key=source.trim();
  const index=language==='uk'?0:1;
  const direct=MESSAGES[key]; if(direct)return leading+direct[index]+trailing;
  if(key.endsWith('...')&&MESSAGES[key.slice(0,-3)])return leading+MESSAGES[key.slice(0,-3)][index]+'…'+trailing;
  for(const pattern of patterns){
    const match=pattern.regex.exec(key); if(!match)continue;
    return leading+pattern.values[index].replace(/\{(\d+)\}/g,(_,slot:string)=>match[pattern.slots.indexOf(slot)+1]??'')+trailing;
  }
  return source;
}
interface Binding {node:WeakRef<Node>;property:string;source:string}
const bindings=new Set<Binding>(),byNode=new WeakMap<Node,Map<string,Binding>>();
function excluded(node:Node):boolean {
  const element=typeof Element!=='undefined'&&node instanceof Element?node:node.parentElement;
  return !!element?.closest?.('[translate="no"]');
}
function render(binding:Binding,node:Node):void {
  if(excluded(node))return;
  const value=t(binding.source);
  if(binding.property.startsWith('@'))(node as Element).setAttribute(binding.property.slice(1),value);
  else (node as unknown as Record<string,unknown>)[binding.property]=value;
}
function bind(node:Node,property:string,source:string):void {
  let properties=byNode.get(node); if(!properties)byNode.set(node,properties=new Map());
  const old=properties.get(property);if(old)bindings.delete(old);
  properties.delete(property);
  let target=node;
  if(property==='textContent'&&typeof Element!=='undefined'&&node instanceof Element){
    // Bind the authored text child, not its container: language changes must retain
    // inputs, buttons, SVG children and their focus/event handlers appended later.
    node.textContent=source;
    if(!node.firstChild)return;
    target=node.firstChild;
  }
  const binding={node:new WeakRef(target),property,source};properties.set(property,binding);bindings.add(binding);render(binding,target);
}
/** Explicit UI bindings; never reads or rewrites arbitrary document/user content. */
export function setText(node:Node,source:string|null):void {bind(node,'textContent',source??'');}
export function appendText(node:Node,source:string):void {
  setText(node,(byNode.get(node)?.get('textContent')?.source??node.textContent??'')+source);
}
export function bindAttribute(node:Element,name:string,source:string):void {bind(node,'@'+name,source);}
export function bindProperties(node:HTMLElement,props:Record<string,unknown>):void {
  Object.assign(node,props);
  if(props.translate===false)return;
  for(const key of ['textContent','title','placeholder','ariaLabel'])if(typeof props[key]==='string')bind(node,key,props[key] as string);
}
export function appendLocalized(node:Element,...children:(Node|string)[]):void {
  for(const child of children){
    if(typeof child!=='string'){node.append(child);continue;}
    const text=document.createTextNode(child);node.append(text);if(!excluded(node))setText(text,child);
  }
}
export function setLocale(next:Locale):void {
  if(next===locale)return;locale=next;
  if(typeof document!=='undefined')document.documentElement.lang=locale;
  for(const binding of bindings){const node=binding.node.deref();if(!node)bindings.delete(binding);else render(binding,node);}
  for(const listener of listeners)listener();
}
export const getLocale=()=>locale;
export const onLocaleChange=(listener:()=>void)=>{listeners.add(listener);return ()=>listeners.delete(listener);};
