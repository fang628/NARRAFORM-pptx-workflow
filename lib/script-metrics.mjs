export const scriptScale=.68;
export const scriptShift={sup:.33,sub:-.17};
export function nativeScriptOptions(options,baseFontSize){
  const script=options?.superscript?'sup':options?.subscript?'sub':null;
  return script?{fontSize:baseFontSize*scriptScale,baseline:scriptShift[script]/scriptScale*2000}:{};
}
