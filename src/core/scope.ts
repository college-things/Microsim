/** AC input coupling: a 10 Hz RC high-pass with variable simulation timesteps. */
export function coupleScope(values:Float64Array,axis:ArrayLike<number>,coupling:'DC'|'AC'|'GND'):Float64Array{
 if(coupling==='DC')return values;
 const out=new Float64Array(values.length);if(coupling==='GND')return out;
 const tau=1/(2*Math.PI*10);
 for(let i=1;i<values.length;i++){const dt=axis[i]-axis[i-1];if(!(dt>0)){out[i]=out[i-1];continue;}const decay=Math.exp(-dt/tau);out[i]=decay*out[i-1]+(values[i]-values[i-1])*tau/dt*(1-decay);}
 return out;
}
/** Last interpolated trigger edge that leaves a complete sweep in the stored data. */
export function scopeTrigger(axis:ArrayLike<number>,wave:ArrayLike<number>|undefined,level:number|undefined,span:number,slope:'rising'|'falling'='rising'):number{
 if(!axis.length||!(span>0&&Number.isFinite(span)))return 0;
 const end=axis[axis.length-1];let start=Math.max(axis[0],end-span);
 if(level===undefined||!wave)return start;
 for(let i=1;i<axis.length;i++){
  const a=wave[i-1],b=wave[i];const cross=slope==='rising'?a<level&&b>=level:a>level&&b<=level;
  if(cross){const at=axis[i-1]+(axis[i]-axis[i-1])*(level-a)/(b-a);if(at+span<=end)start=at;}
 }
 return start;
}
