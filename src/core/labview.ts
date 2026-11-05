export interface LabviewFrame { time: number; signals: Record<string, number> }
function readSignals(data: unknown):Record<string,number>{
  const value=data as {signals?:Record<string,number>};
  if (!value || !value.signals || typeof value.signals !== "object" || Array.isArray(value.signals) || Object.keys(value.signals).length > 1024 || !Object.values(value.signals).every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("LabVIEW must return { signals: { name: finite_number } }.");
  return value.signals;
}
export async function exchangeLabviewVI(bridge:string,token:string,config:{path:string;bits:32|64;outputs:string[];timeControl?:string},frame:LabviewFrame,signal?:AbortSignal):Promise<Record<string,number>>{
  const target=new URL(bridge);if(target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password)throw new Error('Use an HTTP localhost design bridge.');
  const response=await fetch(`${bridge.replace(/\/$/,'')}/labview/exchange`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({...config,frame}),signal:signal??AbortSignal.timeout(20000),credentials:'omit'});
  const data=await response.json();if(!response.ok)throw new Error(data.error??`LabVIEW bridge returned HTTP ${response.status}.`);return readSignals(data);
}
/** LabVIEW Web Services can implement this JSON request/response protocol. */
export async function exchangeLabview(url: string, frame: LabviewFrame, signal?: AbortSignal): Promise<Record<string, number>> {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Use an HTTP(S) LabVIEW Web Service URL.");
  const response = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(frame), signal: signal ?? AbortSignal.timeout(5000), credentials: "omit" });
  if (!response.ok) throw new Error(`LabVIEW returned HTTP ${response.status}.`);
  const data = await response.json();
  return readSignals(data);
}
