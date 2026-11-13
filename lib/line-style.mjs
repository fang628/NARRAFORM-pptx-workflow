export const endpointSizeFactors={sm:2,med:3,lg:5};
export function endpointSize(value){
  if(value==null)return undefined;
  if(typeof value!=='object'||!Object.hasOwn(endpointSizeFactors,value.width)||!Object.hasOwn(endpointSizeFactors,value.length))throw Error('端点大小须为{width:"sm|med|lg",length:"sm|med|lg"}');
  return {width:value.width,length:value.length};
}
