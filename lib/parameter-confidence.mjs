// Confidence belongs to a parameter and an independent observation, never an object.
export const PARAMETER_CONFIDENCE_VERSION=1;
const clamp=value=>Math.max(0,Math.min(1,Number(value)||0));
export function parameterConfidence(element,parameter){
  const inherited=element.parameterEvidence?.[parameter]??(['gradientAngle','gradientCenter','gradientStops'].includes(parameter)?element.parameterEvidence?.fill:null);
  if(inherited?.inherited||inherited?.independent===false)return 0;
  if(inherited?.confidence!==undefined)return clamp(inherited.confidence);
  if(['font','italic'].includes(parameter))return clamp(element.fontEvidence?.confidence??(element.fontFace?.length ? .6 : 0));
  if(['fill','gradientAngle','gradientCenter','gradientStops','textColor'].includes(parameter)){
    if(element.textPaintMeasured)return .85;
    return clamp(element.paintEvidence?.[parameter]?.confidence??element.paintEvidence?.confidence??(parameter==='textColor'&&element.color ? .6 : 0));
  }
  if(['stroke','strokeColor','strokeWidth'].includes(parameter))return clamp(element.paintEvidence?.[parameter]?.confidence??element.linePaintEvidence?.confidence??0);
  const g=element.geometryEvidence;
  if(g?.accepted===false)return 0;
  if(g?.accepted)return clamp((g.support??g.visibleCoverage??.8)*(1-Math.min(.6,(g.boundaryP95??g.p95??0)/12)));
  return clamp(element.baseGeometry?.confidence??0);
}
export function weightedMedian(entries){
  const rows=entries.filter(e=>Number.isFinite(e.value)&&e.weight>0).sort((a,b)=>a.value-b.value);
  const total=rows.reduce((s,e)=>s+e.weight,0);let sum=0;
  for(let i=0;i<rows.length;i++){sum+=rows[i].weight;if(sum>=total/2)return Math.abs(sum-total/2)<1e-9&&rows[i+1]?(rows[i].value+rows[i+1].value)/2:rows[i].value;}
  return undefined;
}
export function independentSources(elements,parameter){
  const seen=new Set();return elements.filter(e=>{
    if(parameterConfidence(e,parameter)<.55)return false;
    const id=e.parameterEvidence?.[parameter]?.observationId||e.key;
    if(seen.has(id))return false;seen.add(id);return true;
  });
}
export function inheritedParameter(element,parameter,sources,confidence){
  const previous=element.parameterEvidence?.[parameter];
  return {...element,parameterEvidence:{...element.parameterEvidence,[parameter]:{confidence,
    inherited:true,independent:false,sources:[...new Set(sources.map(e=>e.key))],method:'reliable-weighted-consensus',
    ...(previous?.independent&&!previous.inherited?{observation:structuredClone(previous)}:previous?.observation?{observation:structuredClone(previous.observation)}:{})}}};
}
export function retainParameterEvidence(previous,next){
  const geometry=['type','x','y','w','h','shape','customGeometry','shapeGeometry','flipH','flipV','rotate'];
  const fields={fill:[...geometry,'fill','gradient','fillOpacity','opacity'],stroke:[...geometry,'color','strokeGradient','colorOpacity','strokeWidth','opacity'],
    strokeWidth:[...geometry,'strokeWidth'],strokeColor:[...geometry,'color','strokeGradient','colorOpacity'],
    gradientAngle:[...geometry,'gradient'],gradientCenter:[...geometry,'gradient'],gradientStops:[...geometry,'gradient'],
    font:['text','fontFace','size','bold','italic','charSpacing','lineSpacing'],italic:['text','fontFace','italic'],bold:['text','fontFace','bold','boldRuns'],
    textColor:[...geometry,'text','color','gradient','textGradient'],diameter:[...geometry],slant:[...geometry],corners:[...geometry]};
  const retained={};
  for(const [parameter,evidence]of Object.entries(previous?.parameterEvidence||{})){
    const keys=fields[parameter];
    if(keys&&keys.every(key=>JSON.stringify(previous[key])===JSON.stringify(next[key])))retained[parameter]=structuredClone(evidence);
  }
  const {parameterEvidence,...rest}=next;
  return Object.keys(retained).length?{...rest,parameterEvidence:retained}:rest;
}
