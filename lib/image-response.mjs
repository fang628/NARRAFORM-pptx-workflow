// Read bounded, explicit Images response shapes. Never treat arbitrary text as an image.
export const imageResponseRetryLimit=2;
export function imageFailure(message,{retryable=false,...metadata}={}){
  return Object.assign(Error(message),{imageResponse:true,retryable,...metadata});
}
export function isRasterImage(bytes){
  return bytes.length>=12&&(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes[0]===255&&bytes[1]===216&&bytes[2]===255||bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'||/^GIF8[79]a$/.test(bytes.toString('ascii',0,6)));
}
function decode(value){
  if(typeof value!=='string'||!value.trim())return null;
  const text=value.trim().replace(/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i,'').replace(/\s/g,'');
  if(text.length>28_000_000)throw imageFailure('生图返回图片过大');
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(text)||text.length%4===1)return null;
  const bytes=Buffer.from(text,'base64');return isRasterImage(bytes)?bytes:null;
}
function entries(raw){
  const roots=[raw,raw?.data,raw?.result,raw?.output,raw?.response?.data].filter(Boolean),items=[];
  for(const root of roots){
    if(Array.isArray(root)){items.push(...root.slice(0,10));continue;}
    items.push(root);
    for(const key of ['data','images','output'])if(Array.isArray(root[key]))items.push(...root[key].slice(0,10));
  }
  return items;
}
export function providerImageError(raw){
  const error=raw?.error||raw?.data?.error;
  const code=String(error?.code||raw?.code||'').toLowerCase(),message=String(typeof error==='string'?error:error?.message||raw?.message||raw?.msg||'');
  const state=String(raw?.status||raw?.data?.status||'').toLowerCase();
  const negative=!!error||raw?.success===false||['failed','error','rejected','cancelled'].includes(state)||/^[45]\d\d$/.test(code);
  const refused=/content_policy|safety|moderation|blocked|refus|不允许|内容政策|审核未通过/i.test(code+' '+message)||entries(raw).some(e=>e?.refusal);
  if(refused)return imageFailure('生图供应商拒绝生成该图片，请调整内容或核对供应商规则');
  if(!negative)return null;
  if(/auth|api.?key|permission|quota|insufficient|billing|密钥|权限|额度|余额/.test(code+' '+message)||['401','403','402'].includes(code))return imageFailure('生图供应商返回密钥、权限或额度错误，请检查配置');
  const temporary=/rate.?limit|overload|temporar|timeout|unavailable|upstream|busy|internal|频率|繁忙|超时|暂时|上游/i.test(code+' '+message)||['429','500','502','503','504'].includes(code);
  return imageFailure(temporary?'生图供应商暂时繁忙或上游异常':'生图供应商返回失败状态，请核对模型和 Images 接口配置',{retryable:temporary});
}
export function imageResponse(result){
  const failure=providerImageError(result);if(failure)throw failure;
  for(const item of entries(result)){
    if(typeof item==='string'){
      const bytes=/^data:image\//i.test(item)?decode(item):null;if(bytes)return {bytes};
      if(/^https?:\/\//i.test(item))return {url:item};
      continue;
    }
    if(!item||typeof item!=='object')continue;
    // Partial stream frames must never substitute for the completed image.
    if(/partial/i.test(String(item.type||'')))continue;
    for(const key of ['b64_json','base64','image_base64']){const bytes=decode(item[key]);if(bytes)return {bytes};}
    for(const key of ['url','image_url']){
      const url=typeof item[key]==='string'?item[key]:item[key]?.url;
      const bytes=/^data:image\//i.test(url||'')?decode(url):null;if(bytes)return {bytes};
      if(typeof url==='string'&&/^https?:\/\//i.test(url))return {url};
    }
  }
  const task=result?.task_id||result?.data?.task_id||result?.job_id;
  if(task||['queued','pending','processing','running'].includes(String(result?.status||result?.data?.status||'').toLowerCase()))throw imageFailure('生图接口返回异步任务，尚未提供图片；请使用同步 Images 接口，已停止重发以免重复创建任务');
  if(result?.choices||result?.object==='chat.completion')throw imageFailure('生图通道返回文字聊天响应，请配置支持 Images API 的模型与地址');
  const shape=Object.entries(result||{}).filter(([key])=>['data','result','output','images','response'].includes(key)).map(([key,v])=>key+'='+(Array.isArray(v)?'数组('+v.length+')':v===null?'空':typeof v)).join('；')||'未包含图片结果字段';
  throw imageFailure('生图响应未包含有效图片（'+shape+'）',{retryable:true});
}
