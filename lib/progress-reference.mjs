import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {chat,parseJSON,visualModelConfig} from './provider.mjs';
import {reportTask} from './task-progress.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^#?[a-f0-9]{6}$/i.test(value)?value.replace('#','').toUpperCase():null;
const colorKeys=['accent','track','completedFill','ink','muted','indicatorInk','border','completedBorder','activeBorder'];
export function validateProgressReference(raw,pages){
  if(!pages.some(p=>p.index===raw?.referenceIndex))throw Error('进度条参考页不存在');
  const appearance={};for(const key of colorKeys){
    let value=hex(raw.appearance?.[key]);
    if(!value&&['border','completedBorder','activeBorder'].includes(key)&&!(raw.appearance?.strokeWidth>0))value=hex(raw.appearance?.[{border:'track',completedBorder:'completedFill',activeBorder:'accent'}[key]]);
    if(!value)throw Error('横列配色缺少 '+key);appearance[key]=value;
  }
  if(!raw.appearance.shadow)throw Error('横列阴影参数缺失');
  const box=raw.box;
  if(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite)||box[0]<0||box[1]<0||box[2]<.2||box[3]<=0||box[0]+box[2]>1.001||box[1]+box[3]>.35)throw Error('横列参考区域无效，请给出实际横列的外接框');
  if(raw.appearance.shadow){const s=raw.appearance.shadow;if(!hex(s.color)||![s.opacity,s.blur,s.offset].every(Number.isFinite)||s.opacity<0||s.opacity>1||s.blur<0||s.blur>12||s.offset<0||s.offset>8)throw Error('横列阴影参数无效');appearance.shadow={type:'outer',color:hex(s.color),opacity:s.opacity,blur:s.blur,offset:s.offset,angle:Number.isFinite(s.angle)?s.angle:90};}
  for(const key of ['trackGradient','completedGradient','activeGradient']){
    const gradient=raw.appearance[key];if(!gradient)continue;
    if(!Array.isArray(gradient.stops)||gradient.stops.length<2||gradient.stops.length>6||gradient.stops.some(s=>!hex(s.color)||!Number.isFinite(s.position)||s.position<0||s.position>1))throw Error('横列渐变参数无效');
    appearance[key]={type:'linear',angle:Number.isFinite(gradient.angle)?gradient.angle:90,stops:gradient.stops.map(s=>({position:s.position,color:hex(s.color),opacity:1}))};
  }
  if(Number.isFinite(raw.appearance.strokeWidth))appearance.strokeWidth=Math.max(0,Math.min(3,raw.appearance.strokeWidth));
  return {index:raw.referenceIndex,box,appearance,evidence:String(raw.evidence||'').slice(0,800)};
}

export async function prepareProgressReference(p,env,signal,{request=chat}={}){
  if(p.brief.progress===false)return;
  const layout=p.deliveryMotion?.progressLayout||'chevron';
  const pages=Object.values(p.visualPages||{}).filter(page=>page?.file&&!['cover','toc'].includes(p.slides[page.index]?.kind)).map(page=>({index:page.index,file:path.resolve(env.data,p.id,page.file),sha256:page.previewHash})).filter(page=>fs.existsSync(page.file)&&hash(fs.readFileSync(page.file))===page.sha256);
  if(!pages.length)return;
  const stamp=hash(JSON.stringify([6,p.selectedTheme,layout,pages.map(({index,sha256})=>[index,sha256])]));
  if(p.progressStyleReference?.stamp===stamp)return;
  const directory=path.join(env.data,p.id,'geometry-records','progress-style',stamp);fs.mkdirSync(directory,{recursive:true});
  const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const local=async(spec,name)=>{const file=path.join(directory,name+'.json'),png=path.join(directory,name+'.png');fs.writeFileSync(file,JSON.stringify(spec));return {png,result:JSON.parse((await env.run(python,[path.join(env.root,'tools/progress_reference.py'),file,png],{windowsHide:true,timeout:60000,maxBuffer:200000,signal})).stdout)};};
  try{
    reportTask(signal,{kind:'step',message:'从完整预览中选择最接近'+(layout==='bubble'?'气泡':'箭形')+'横列的一页，统一提取位置、实际配色、阴影与描边'});
    const montage=await local({operation:'montage',pages,layout},'montage');
    let chosen,mode='preview-vision',warning;
    try{
      const response=await request(visualModelConfig(env.credentials.get(p.id)),env.system,[{type:'text',text:`提取页顶横列样式：联系表每格P编号对应PPT实际页码。选一张最接近${layout==='bubble'?'气泡并列':'箭形并列'}的完整预览，只从这一页的横列提取实际配色、阴影和描边，不混用多页、不按风格名另配颜色。渐变与描边均非必选：纯色填充的对应Gradient填null，无可见描边时strokeWidth填0；只有图中实际出现时才给出渐变色标及描边。当前项、已过项、未到项均参照同一图；未出现的状态按该图已有色阶延展。box必须是该页实际横列全部分段的紧贴外接框，不含阴影、标题或上下留白；使用原整页归一化坐标，限页顶35%，不是整片页头区域。全篇原生横列的位置和总长度都沿用这同一张参考图，对齐左右边界和垂直中心；可以偏左、偏右或使用较短横列，不自动居中、不强行铺满页宽。输出 {referenceIndex:从0开始的真实页索引,box:[x,y,w,h],appearance:{accent:"当前填色HEX",track:"未到填色HEX",completedFill:"已过填色HEX",ink:"正文字HEX",muted:"未到章节字HEX",indicatorInk:"当前章节字HEX",border:"未到描边HEX",completedBorder:"已过描边HEX",activeBorder:"当前描边HEX",strokeWidth:实际逻辑线宽（无描边填0）,shadow:{color:"阴影HEX",opacity:0至1,blur:逻辑模糊,offset:逻辑偏移,angle:角度},trackGradient:{angle:90,stops:[{position:0,color:"HEX"},{position:1,color:"HEX"}]},completedGradient:同结构,activeGradient:同结构},evidence:"为何选择此页，实际颜色与阴影依据"}。只返回JSON。可选页索引：${JSON.stringify(pages.map(p=>p.index))}`},{type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(montage.png).toString('base64')}}],signal,{deferJSONValidation:true});
      chosen=validateProgressReference(parseJSON(response.text),pages);
    }catch(error){
      if(signal?.aborted)throw error;
      mode='preview-local';warning=String(error.message).slice(0,500);
      // Observed row geometry outranks isolated header shapes, even if those
      // unrelated shapes have a larger raw count. Preserve offset/short rows.
      const candidate=[...montage.result.candidates].sort((a,b)=>Number(!!b.box)-Number(!!a.box)||(b.score||0)-(a.score||0))[0],colors=candidate.colors,accent=candidate.accent;
      const rgb=c=>c.match(/../g).map(v=>parseInt(v,16)),luma=c=>rgb(c).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
      const nearest=target=>colors.reduce((best,c)=>rgb(c).reduce((n,v,i)=>n+(v-rgb(target)[i])**2,0)<rgb(best).reduce((n,v,i)=>n+(v-rgb(target)[i])**2,0)?c:best,colors[0]);
      const dark=[...colors].sort((a,b)=>luma(a)-luma(b))[0],light=[...colors].sort((a,b)=>luma(b)-luma(a))[0],track=nearest('E5E5E5');
      const ink=luma(track)>140?dark:light,indicatorInk=luma(accent)>145?dark:light;
      chosen={index:candidate.index,box:candidate.box||null,appearance:{accent,track,completedFill:nearest('B4C6E8'),ink,muted:ink,indicatorInk,strokeWidth:0,border:nearest('939393'),completedBorder:accent,activeBorder:accent,shadow:{type:'outer',color:dark,opacity:.12,blur:2,offset:1,angle:90}},evidence:'视觉接口不可用，按横列轮廓候选数选择一张内容预览并读取实际页顶像素，文字和阴影取该页深浅色极值以保留对比；未使用风格库配色'};
    }
    const source=pages.find(page=>page.index===chosen.index),colors={...Object.fromEntries(colorKeys.map(key=>[key,chosen.appearance[key]]))};
    const sampled=await local({operation:'sample',file:source.file,box:chosen.box||[0,0,1,.18],colors},'selected');Object.assign(chosen.appearance,sampled.result.colors);
    p.progressStyleReference={stamp,theme:p.selectedTheme,layout,index:source.index,previewHash:source.sha256,file:path.relative(path.join(env.data,p.id),source.file),record:path.relative(path.join(env.data,p.id),directory),box:chosen.box,appearance:chosen.appearance,evidence:chosen.evidence,mode,...(warning?{warning}:{}),at:new Date().toISOString()};env.save(p);
  }catch(error){if(signal?.aborted)throw error;reportTask(signal,{kind:'step',status:'warning',message:'页顶样式提取暂未完成，已保留既有横列样式：'+String(error.message).slice(0,300)});}
}
