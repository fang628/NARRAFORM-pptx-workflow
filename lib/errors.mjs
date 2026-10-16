// DOMException.message is read-only; attach context to a new Error instead.
export function wrapError(cause,message){
  const error=new Error(message,{cause});
  for(const key of ['code','httpStatus','retryable','downloadOnly','responseFormat','sizeRejected','toolsUnsupported','imageResponse','promptRejected'])if(cause?.[key]!==undefined)error[key]=cause[key];
  return error;
}
export const contextualError=(cause,label)=>wrapError(cause,label+'：'+String(cause?.message??cause));
