import {imageResponse,isRasterImage,imageFailure,imageResponseRetryLimit,providerImageError} from './image-response.mjs';
import {contextualError,wrapError} from './errors.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import {reportTask} from './task-progress.mjs';
import {createRequestGate} from './concurrency.mjs';
const acquireRequest=createRequestGate(6);

// An explicitly configured channel takes precedence; request failures never switch models.
export function visualModelConfig(configs){return configs?.rebuild?.key?configs.rebuild:configs?.text?.key?configs.text:null;}

function isPrivate(ip) {
  if(net.isIP(ip)===4) { const a=ip.split('.').map(Number); return a[0]===0||a[0]===10||a[0]===127||a[0]>=224||(a[0]===169&&a[1]===254)||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)||(a[0]===100&&a[1]>=64&&a[1]<=127); }
  return ip==='::'||ip==='::1'||/^f[cd]/i.test(ip)||/^fe[89ab]/i.test(ip)||ip.toLowerCase().startsWith('::ffff:');
}
export const providerTimeoutMs=endpoint=>endpoint.startsWith('images/')?600000:180000;
export async function lookupAPIAddresses(host,signal,{lookup=dns.lookup,wait=delay}={}){
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();
    try{return await lookup(host,{all:true});}
    catch(error){
      if(signal?.aborted)throw error;
      if(!['ENOTFOUND','EAI_AGAIN'].includes(error.code)||attempt>=2)throw contextualError(error,'API 域名解析失败（'+host+'），请检查地址或 DNS 网络');
      reportTask(signal,{kind:'retry',status:'running',message:`API 域名解析暂时失败，重试 ${attempt+1}/2；尚未发送模型请求`});
      await wait(300*(attempt+1),undefined,{signal});
    }
  }
}
export async function safeURL(value,signal) {
  const url=new URL(value);
  if(process.env.PPT_AGENT_TEST==='1'&&url.hostname==='127.0.0.1') return url;
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search) throw Error('API 地址须使用 HTTPS，且不含账号、查询参数或锚点');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=net.isIP(host)?[{address:host}]:await lookupAPIAddresses(host,signal);
  if(!addresses.length||addresses.some(a=>isPrivate(a.address))) throw Error('不允许访问本机、内网或保留网络地址');
  return url;
}
export function parseJSON(text) {
  const s=String(text).replace(/^\uFEFF/,'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { return JSON.parse(s); } catch {}
  // Accept a single complete object/array surrounded by prose, never repair its values.
  const start=s.search(/[\[{]/);let depth=0,quoted=false,escape=false,end=-1;
  for(let i=start;i>=0&&i<s.length;i++){
    const c=s[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
    if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){if(--depth===0){end=i+1;break;}}
  }
  if(end>start&&!/[\[{]/.test(s.slice(end)))try{return JSON.parse(s.slice(start,end));}catch{}
  const error=Error('模型没有返回完整有效的 JSON（可能为说明文字或输出截断）');error.responseFormat=true;throw error;
}
function responseJSON(bytes,response,endpoint){
  if(endpoint.startsWith('images/')&&isRasterImage(bytes))return {data:[{b64_json:bytes.toString('base64')}]};
  const text=bytes.toString('utf8').replace(/^\uFEFF/,'').trim();
  try{return JSON.parse(text);}catch{}
  const type=response.headers.get('content-type')?.split(';')[0]||'未声明';
  const sse=type==='text/event-stream'||/^data:|^event:/m.test(text);
  if(sse&&endpoint.startsWith('images/')){
    let lastError;
    for(const block of text.split(/\r?\n\r?\n/)){
      const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(!data||data==='[DONE]')continue;
      try{const chunk=JSON.parse(data);if(/partial/i.test(String(chunk.type||'')))continue;const failure=providerImageError(chunk);if(failure){lastError=failure;continue;}imageResponse(chunk);return chunk;}catch(error){if(error.imageResponse&&!error.retryable)lastError=error;}
    }
    if(lastError)throw lastError;
  }
  if(sse&&endpoint==='chat/completions'){
    let content='',finish=null,done=false,usage;const chunks=[];
    try{
      for(const block of text.split(/\r?\n\r?\n/)){
        const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
        if(!data)continue;if(data.trim()==='[DONE]'){done=true;continue;}
        const chunk=JSON.parse(data);if(chunk.error)throw Error('stream error');chunks.push(chunk);
        const choice=chunk.choices?.find(c=>c.index===0)||chunk.choices?.[0];
        if(typeof choice?.delta?.content==='string')content+=choice.delta.content;
        else if(typeof choice?.message?.content==='string')content=choice.message.content;
        if(choice?.finish_reason)finish=choice.finish_reason;if(chunk.usage)usage=chunk.usage;
      }
      if(chunks.length&&content&&(done||finish))return {choices:[{message:{content},finish_reason:finish}],usage};
    }catch{}
  }
  const kind=!text?'空响应':/^\s*</.test(text)?'HTML / 网关错误页':sse?'不完整或不兼容的 SSE 流':'非 JSON 或截断的 JSON';
  const error=Error(`${endpoint} 接口返回${kind}（HTTP ${response.status}，${type}，${bytes.length} 字节）。${endpoint.startsWith('images/')?'请检查生图中转状态与 Images 协议。':'请检查文字模型中转状态与 Chat Completions 协议。'}`);
  error.responseFormat=true;if(endpoint.startsWith('images/'))error.retryable=true;throw error;
}
async function limitedBody(response,max=15_000_000) {
  const chunks=[]; let length=0;
  for await(const chunk of response.body) { length+=chunk.length; if(length>max) throw Error('接口返回内容过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function request(config,endpoint,body,signal) {
  const id=crypto.randomUUID(),started=Date.now(),label=endpoint==='images/generations'?'生成图片':endpoint==='images/edits'?'参考图编辑':'模型分析';
  reportTask(signal,{id,kind:'request',status:'queued',message:`${label} · ${String(config?.model||'未配置').slice(0,150)} · 等待调用额度`});
  let release;
  try{
    release=await acquireRequest(signal);
    reportTask(signal,{id,kind:'request',status:'running',message:`${label} · ${String(config?.model||'未配置').slice(0,150)}`});
    const result=await performRequest(config,endpoint,body,signal);
    reportTask(signal,{id,kind:'request',status:'done',message:`${label} · ${String(config?.model||'').slice(0,150)} · 已返回`,durationMs:Date.now()-started});
    return result;
  }catch(error){
    reportTask(signal,{id,kind:'request',status:signal?.aborted?'cancelled':'failed',message:error.message,durationMs:Date.now()-started});throw error;
  }finally{release?.();}
}
async function performRequest(config,endpoint,body,signal) {
  if(!config?.key||!config?.model) throw Error('请先配置并测试 API');
  const base=await safeURL(config.baseURL,signal);
  const url=new URL(base.href.replace(/\/$/,'')+'/'+endpoint);
  const timeoutMs=providerTimeoutMs(endpoint),timeout=AbortSignal.timeout(timeoutMs);
  const combined=AbortSignal.any([signal||new AbortController().signal,timeout]);
  let response;
  const multipart=body instanceof FormData;
  if(multipart)body.set('model',config.model);
  try {
  response=await fetch(url,{method:'POST',redirect:'error',signal:combined,headers:{...(multipart?{}:{'content-type':'application/json'}),authorization:'Bearer '+config.key},body:multipart?body:JSON.stringify({...body,model:config.model})});
  if(!response.ok) {
    let sizeRejected=false,toolsUnsupported=false;
    if([400,422].includes(response.status))try{const details=JSON.parse((await limitedBody(response,8000)).toString('utf8')).error;sizeRejected=details?.param==='size'||/^(invalid|unsupported)_size$/.test(details?.code||'')||(/\bsize\b|尺寸/i.test(details?.message||'')&&/unsupported|not supported|invalid|不支持|无效/i.test(details?.message||''));toolsUnsupported=/tools|tool_choice|function.call/i.test(String(details?.param)+' '+String(details?.message))&&/unsupported|not supported|unknown|unrecognized|不支持/i.test(String(details?.message));}catch{}
    else await response.body?.cancel();
    const error=Error(`API 返回 HTTP ${response.status}。请检查密钥、模型权限、额度及接口协议。`);error.sizeRejected=sizeRejected;error.toolsUnsupported=toolsUnsupported;error.httpStatus=response.status;error.retryable=[429,500,502,503,504].includes(response.status);throw error;
  }
  return responseJSON(await limitedBody(response,endpoint.startsWith('images/')?32_000_000:15_000_000),response,endpoint);
  }catch(error){
    if(signal?.aborted)throw wrapError(error,'请求已取消');
    if(timeout.aborted||error.name==='TimeoutError'){
      const failure=wrapError(error,(endpoint.startsWith('images/')?'生图':'文字模型')+'请求超过 '+timeoutMs/1000+' 秒；已保留现有结果，未自动重复提交本次请求');
      failure.code='API_TIMEOUT';failure.retryable=false;throw failure;
    }
    if(error.httpStatus||error.responseFormat||error.imageResponse)throw error;
    const interrupted=error.message==='terminated'||error.cause?.code==='UND_ERR_SOCKET';
    const failure=wrapError(error,interrupted?'API 响应连接中断（terminated），已保留现有结果':'无法连接 API 或接收响应中断，请检查地址和网络');
    failure.code=interrupted?'API_CONNECTION_TERMINATED':'API_NETWORK';throw failure;
  }
}
export async function chat(config,system,user,signal,{deferJSONValidation=false,includeSummary=true}={}) {
  const summaryInstruction='若任务要求返回 JSON 对象，可额外提供 executionSummary 字符串（不超过160字）：概括最终采用的方法、关键依据与待核实项。只给简洁结果摘要，不提供内部推理过程；不要含密钥或完整提示词。';
  const structured=/JSON/i.test(system);let result,text;
  for(let attempt=0;attempt<(deferJSONValidation?1:2);attempt++){
    try{
      result=await request(config,'chat/completions',{stream:false,messages:[{role:'system',content:system+(includeSummary?'\n'+summaryInstruction:'')+(attempt?'\n上次响应格式不正确。本次只输出一个完整合法的 JSON，不要前言、代码围栏或省略号；保留任务要求的全部字段。':'')},{role:'user',content:user}]},signal);
      const choice=result.choices?.[0];text=choice?.message?.content;
      if(typeof text!=='string'){const e=Error('接口缺少 choices[0].message.content，请使用 Chat Completions 兼容接口');e.responseFormat=true;throw e;}
      if(choice.finish_reason==='length'&&!deferJSONValidation){const e=Error('文字模型输出因长度上限被截断，请提高供应商输出额度或换用支持更长输出的模型');e.responseFormat=true;throw e;}
      if(structured&&!deferJSONValidation)text=JSON.stringify(parseJSON(text));break;
    }catch(error){
      if(deferJSONValidation||attempt||!error.responseFormat||signal?.aborted)throw error;
      reportTask(signal,{kind:'retry',status:'running',message:'文字分析响应格式异常，自动重试 1/1；不会重新调用生图接口'});
    }
  }
  try{const summary=parseJSON(text).executionSummary;if(typeof summary==='string'&&summary.trim())reportTask(signal,{kind:'summary',status:'done',message:summary.trim().slice(0,600)});}catch{}
  return {text,usage:result.usage||null,finishReason:result.choices?.[0]?.finish_reason||null};
}
export async function generatedImage(config,prompt,signal,options={}) {
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>30000)throw Error('请填写有效的生图提示词（最多30000字）');
  const refs=options.references||[],endpoint=refs.length?'images/edits':'images/generations';
  if(refs.length>3||refs.some(r=>!Buffer.isBuffer(r.bytes)||!r.bytes.length)||refs.reduce((sum,r)=>sum+r.bytes.length,0)>20_000_000)throw Error('参考图须为最多 3 张、总计不超过 20 MB 的有效图片');
  if(options.checkPrompt){const check=await options.checkPrompt(prompt);prompt=check.prompt;await options.onPromptChecked?.(check);signal?.throwIfAborted();}
  const payload=size=>{
    if(!refs.length)return {prompt,n:1,size};
    const form=new FormData();form.set('prompt',prompt);form.set('n','1');form.set('size',size);
    refs.forEach((r,i)=>form.append(refs.length===1?'image':'image[]',new Blob([r.bytes],{type:r.mime||'image/png'}),'reference-'+i+'.png'));return form;
  };
  let size=options.size||'1536x1024',sizeFallback=false;
  for(let attempt=0;attempt<=imageResponseRetryLimit;attempt++){
    signal?.throwIfAborted();
    try{
      const result=await request(config,endpoint,payload(size),signal),item=imageResponse(result);
      if(item.bytes)return item.bytes;
      // Download retries use the same signed URL and never submit another paid generation.
      return await downloadGeneratedImage(item.url,signal);
    }catch(error){
      if(signal?.aborted)throw error;
      if(options.allowAutoSize&&!sizeFallback&&error.sizeRejected&&attempt<imageResponseRetryLimit){
        size='auto';sizeFallback=true;options.onSizeFallback?.('auto');
        reportTask(signal,{kind:'retry',status:'running',message:'生图接口拒绝指定尺寸，改用 auto；保持原提示词、模型与参考图'});continue;
      }
      if(error.downloadOnly||!error.retryable)throw error;
      if(attempt>=imageResponseRetryLimit)throw wrapError(error,error.message+'；本次最多 '+(imageResponseRetryLimit+1)+' 次请求后仍未获得图片，已停止重试');
      reportTask(signal,{kind:'retry',status:'running',message:`生图响应暂时异常，自动重试 ${attempt+1}/${imageResponseRetryLimit}；保持原提示词、模型与参考图`});
      await delay(300*(attempt+1),undefined,{signal});
    }
  }
}
async function downloadGeneratedImage(value,signal){
  const url=new URL(value),clean=new URL(url);clean.search='';await safeURL(clean.href);
  for(let attempt=0;attempt<=imageResponseRetryLimit;attempt++){
    signal?.throwIfAborted();
    try{
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(90000)])});
      if(!response.ok){await response.body?.cancel();throw imageFailure('图片下载返回 HTTP '+response.status,{retryable:[429,500,502,503,504].includes(response.status),downloadOnly:true});}
      const bytes=await limitedBody(response,20_000_000);
      if(!isRasterImage(bytes))throw imageFailure('图片下载内容不是有效图片',{retryable:true,downloadOnly:true});
      return bytes;
    }catch(error){
      error.downloadOnly=true;
      if(signal?.aborted)throw error;
      if(error.retryable===false||attempt===imageResponseRetryLimit)throw error;
      reportTask(signal,{kind:'retry',status:'running',message:`图片下载暂时失败，重试下载 ${attempt+1}/${imageResponseRetryLimit}；不会重新生图`});
      await delay(300*(attempt+1),undefined,{signal});
    }
  }
}
