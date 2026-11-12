// Composite groups write their constituent fields; sibling parameters stay independent.
const children={fill:['gradientAngle','gradientCenter','gradientStops'],stroke:['strokeWidth','strokeColor']};
export function parameterKept(keep,parameter){
  return (Array.isArray(keep)?keep:[]).some(name=>name===parameter
    ||children[name]?.includes(parameter)||children[parameter]?.includes(name));
}
export function parameterRejected(element,parameter){
  return (element?.recognitionRejections||[]).some(item=>item?.parameter===parameter
    ||children[parameter]?.includes(item?.parameter));
}
export function parameterHasIndependentChildren(element,parameter){
  const id=element?.parameterGroups?.[parameter];
  return children[parameter]?.some(child=>element?.parameterGroups?.[child]
    &&element.parameterGroups[child]!==id)||false;
}
export function parameterBlocked(element,parameter){
  return parameterKept(element?.keepParameters,parameter)||parameterRejected(element,parameter)
    ||parameterHasIndependentChildren(element,parameter);
}
