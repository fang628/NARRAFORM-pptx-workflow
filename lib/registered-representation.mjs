const nativeTypes=new Set(['rect','shape','ellipse','line']);
export function representationOf(e){
  if(e?.initialRepresentation)return e.initialRepresentation;
  if(e?.type==='image'&&e.implementation)return e.implementation==='svg'?'svg':'cutout';
  if(nativeTypes.has(e?.type))return 'native';
  return e?.type;
}
export function registerRepresentation(e,previous){
  return {...e,initialRepresentation:previous?.initialRepresentation||e.initialRepresentation||representationOf(previous||e)};
}
