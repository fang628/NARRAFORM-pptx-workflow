import {setTimeout as delay} from 'node:timers/promises';
import {reportTask} from './task-progress.mjs';
import {wrapError} from './errors.mjs';

export const textGenerationRetryLimit=2;
// Public recovery plans describe observable faults and actions, never model reasoning.
export function diagnoseTextFailure(error){
  if(error?.outputBudgetRejected)return {category:'protocol',problem:'接口不接受输出长度参数',action:'移除不兼容的长度参数，改用紧凑输出；保持已配置模型与接口。'};
  if(error?.outputTruncated)return {category:'truncated',problem:'输出被截断',action:'提高本次输出额度；返回紧凑的完整 JSON，删去可选摘要、重复解释与格式空白，保留全部必需字段、准确文字及节点。'};
  if(error?.repairInstruction)return {category:'schema',problem:String(error.message).slice(0,300),action:String(error.repairInstruction).slice(0,6000)};
  if(error?.textValidation)return {category:'schema',problem:String(error.message).slice(0,300),action:'根据校验错误修正对应字段的类型、取值或引用关系：'+String(error.message).slice(0,1200)+'。保留原稿中正确的字段；返回修正后的完整结果，不改写已确认内容。'};
  if(error?.httpStatus===429)return {category:'transport',problem:'接口限流',action:'退避后恢复当前请求，保持任务内容；不重新执行已完成的工具或页面。'};
  if(error?.code==='API_TIMEOUT'||error?.name==='TimeoutError')return {category:'transport',problem:'当前请求超时',action:'重新建立当前请求，保留任务内容与已完成结果。'};
  if(error?.responseFormat)return {category:'format',problem:'响应不是完整有效的 JSON',action:'重新输出完整 JSON 对象或数组，修正引号、括号与字段类型；不要说明文字、代码围栏或省略号，保留必需内容。'};
  return {category:'transport',problem:'网络或接口连接异常',action:'退避后重新建立当前请求，保持模型与任务内容；已完成结果不重跑。'};
}
export function retryableTextError(error){
  if(error?.outputBudgetRejected)return true;
  if([400,401,403,404,422].includes(error?.httpStatus))return false;
  return !!(error?.textValidation||error?.responseFormat||error?.retryable||[408,409,425,429,500,502,503,504].includes(error?.httpStatus)||['API_TIMEOUT','API_NETWORK','API_CONNECTION_TERMINATED','ENOTFOUND','EAI_AGAIN'].includes(error?.code)||error?.name==='TimeoutError');
}
export async function regenerateText(generate,{signal,limit=textGenerationRetryLimit,label='文字生成',wait=delay}={}){
  if(!Number.isInteger(limit)||limit<0||limit>textGenerationRetryLimit)throw Error('文字重试次数须在 0–2 之间');
  const cancelled=error=>{
    reportTask(signal,{kind:'step',status:'cancelled',message:label+' · 请求已取消'});
    return wrapError(error||Error('cancelled'),'请求已取消');
  };
  let previous;
  for(let attempt=0;attempt<=limit;attempt++){
    if(signal?.aborted)throw cancelled(signal.reason);
    try{return await generate(attempt,previous);}
    catch(error){
      if(signal?.aborted)throw cancelled(error);
      if(!retryableTextError(error)||error.textRetriesExhausted||attempt===limit){
        if(attempt&&attempt===limit&&retryableTextError(error)){const final=wrapError(error,error.message);final.textRetriesExhausted=true;throw final;}
        throw error;
      }
      previous=error;
      const diagnosis=diagnoseTextFailure(error);
      reportTask(signal,{kind:'retry',status:'running',message:`${label} · 定位：${diagnosis.problem}；处理：${diagnosis.action.slice(0,220)} · 自动重新生成 ${attempt+1}/${limit}`});
      try{await wait(300*(attempt+1),undefined,{signal});}catch(error){if(signal?.aborted)throw cancelled(error);throw error;}
    }
  }
}
export function validateTextOutput(validate,value){
  try{return validate(value);}
  catch(error){const failure=wrapError(error,error.message);failure.textValidation=true;throw failure;}
}
export const textFieldValidator=(field,{min=1,max=30000}={})=>raw=>{
  const value=raw?.[field];
  if(typeof value!=='string'||value.trim().length<min||value.length>max){
    const error=Error(`模型返回的 ${field} 须为 ${min}–${max} 字文字`);
    error.repairInstruction=typeof value!=='string'?`补齐 ${field} 字段，值必须为字符串，不能为 null、数组或对象，长度 ${min}–${max} 字。其余有效字段保留。`:
      value.length>max?`仅精简 ${field} 字段至 ${max} 字以内，保留必需内容，其余有效字段保留。`:`补充 ${field} 字段至至少 ${min} 字，不能留空，其余有效字段保留。`;
    throw error;
  }
  return raw;
};
