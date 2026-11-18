export function hasCompleteTableAxis(boundaries,evidence){
 const observed=evidence?.boundaries;
 return evidence?.source==='complete-visible-boundaries'&&evidence.confidence>=.8
   &&Array.isArray(observed)&&observed.length===boundaries.length
   &&observed.every((v,i)=>Number.isFinite(v)&&Math.abs(v-boundaries[i])<.2);
}

export function tableAxisSpacing(boundaries,evidence){
 if(!Array.isArray(boundaries)||boundaries.length<2)return boundaries;
 if(boundaries.some((v,i)=>!Number.isFinite(v)||i&&v<=boundaries[i-1]))return boundaries;
 if(hasCompleteTableAxis(boundaries,evidence))return boundaries;
 const step=(boundaries.at(-1)-boundaries[0])/(boundaries.length-1);
 return boundaries.map((_,i)=>boundaries[0]+i*step);
}
