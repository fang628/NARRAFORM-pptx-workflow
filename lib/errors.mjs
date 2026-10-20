// DOMException.message is read-only; attach context to a new Error instead.
export function wrapError(cause,message){
  const error=new Error(message,{cause});
  for(const key of ['code','httpStatus','retryable','downloadOnly','responseFormat','sizeRejected','toolsUnsupported','imageResponse','promptRejected','textValidation','textRetriesExhausted','repairInstruction','outputTruncated','outputTokens','outputBudgetRejected'])if(cause?.[key]!==undefined)error[key]=cause[key];
  return error;
}
export const contextualError=(cause,label)=>wrapError(cause,label+'：'+String(cause?.message??cause));

// Asset generators already perform bounded transport retries. Let the tool
// session stop on infrastructure failure instead of issuing more paid attempts.
export function assetServiceUnavailable(error){
  const status=Number(error?.httpStatus);
  if(status===429||status>=500&&status<=599)return true;
  for(let cause=error,depth=0;cause&&depth<4;cause=cause.cause,depth++)if(['API_TIMEOUT','ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(cause.code))return true;
  return false;
}
export function stopAssetTool(error,{artistic=false}={}){
  const status=error?.httpStatus,kind=artistic?'书法字抠图':'素材生成';
  const message=kind+'接口暂不可用'+(status?'（HTTP '+status+'）':'')+'：'+String(error?.message||error).slice(0,700)+'。已保留原页面，本次不再重复请求或改用原生文字代替抠图';
  return Object.assign(wrapError(error,message),{toolSessionStop:true});
}
