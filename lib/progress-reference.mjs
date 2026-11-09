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
  appearance.shadow=null;
  const box=raw.box;
  if(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite)||box[0]<0||box[1]<0||box[2]<.2||box[3]<=0||box[0]+box[2]>1.001||box[1]+box[3]>.35)throw Error('横列参考区域无效，请给出实际横列的外接框');
  if(raw.appearance.shadow){const s=raw.appearance.shadow;if(!hex(s.color)||![s.opacity,s.blur,s.offset].every(Number.isFinite)||s.opacity<0||s.opacity>1||s.blur<0||s.blur>12||s.offset<0||s.offset>8)throw Error('横列阴影参数无效');appearance.shadow={type:'outer',color:hex(s.color),opacity:s.opacity,blur:s.blur,offset:s.offset,angle:Number.isFinite(s.angle)?s.angle:90};}
  for(const key of ['trackGradient','completedGradient','activeGradient']){
    const gradient=raw.appearance[key];if(!gradient)continue;
    if(!Array.isArray(gradient.stops)||gradient.stops.length<2||gradient.stops.length>6||gradient.stops.some(s=>!hex(s.color)||!Number.isFinite(s.position)||s.position<0||s.position>1))throw Error('横列渐变参数无效');
    appearance[key]={type:'linear',angle:Number.isFinite(gradient.angle)?gradient.angle:90,stops:gradient.stops.map(s=>({position:s.position,color:hex(s.color),opacity:Number.isFinite(s.opacity)?Math.max(0,Math.min(1,s.opacity)):1}))};
  }
  appearance.strokeWidth=Number.isFinite(raw.appearance.strokeWidth)?Math.max(0,Math.min(3,raw.appearance.strokeWidth)):0;
  return {index:raw.referenceIndex,box,appearance,evidence:String(raw.evidence||'').slice(0,800)};
}

export async function prepareProgressReference(p,env,signal,{request=chat}={}){
  if(p.brief.progress===false)return;
  const layout=p.deliveryMotion?.progressLayout||'chevron';
  const pages=Object.values(p.visualPages||{}).filter(page=>page?.file&&!['cover','toc'].includes(p.slides[page.index]?.kind)).map(page=>({index:page.index,file:path.resolve(env.data,p.id,page.file),sha256:page.previewHash})).filter(page=>fs.existsSync(page.file)&&hash(fs.readFileSync(page.file))===page.sha256);
  if(!pages.length)return;
  const stamp=hash(JSON.stringify([7,p.selectedTheme,layout,pages.map(({index,sha256})=>[index,sha256])]));
  if(p.progressStyleReference?.stamp===stamp)return;
  const directory=path.join(env.data,p.id,'geometry-records','progress-style',stamp);fs.mkdirSync(directory,{recursive:true});
  const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const local=async(spec,name)=>{const file=path.join(directory,name+'.json'),png=path.join(directory,name+'.png');fs.writeFileSync(file,JSON.stringify(spec));return {png,result:JSON.parse((await env.run(python,[path.join(env.root,'tools/progress_reference.py'),file,png],{windowsHide:true,timeout:60000,maxBuffer:200000,signal})).stdout)};};
  try{
    reportTask(signal,{kind:'step',message:'从完整预览中选择最接近'+(layout==='bubble'?'气泡':'箭形')+'横列的一页，统一提取位置、实际配色、阴影与描边'});
    const montage=await local({operation:'montage',pages,layout},'montage');
    let chosen,selectedIndex,mode='preview-vision',warning;
    try{
      const config=visualModelConfig(env.credentials.get(p.id));
      const selection=await request(config,env.system,[{type:'text',text:`选择页顶进度条参考页。联系表P编号为实际页码，返回索引从0开始。选择横列形状最贴近用户所选${layout==='bubble'?'气泡横列（圆角或胶囊）':'箭形横列（有箭尖与内凹连接）'}的一页；优先完整、清晰且连续的章节横列，忽略正文卡片、标题和装饰。不混合多页，此次只选页，不提取样式。仅返回JSON {referenceIndex:真实页索引,evidence:"选择依据"}。可选索引：${JSON.stringify(pages.map(page=>page.index))}`},{type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(montage.png).toString('base64')}}],signal,{deferJSONValidation:true});
      const selected=parseJSON(selection.text);
      if(!pages.some(page=>page.index===selected.referenceIndex))throw Error('进度条参考页不存在');
      selectedIndex=selected.referenceIndex;
      const source=pages.find(page=>page.index===selectedIndex);
      reportTask(signal,{kind:'step',message:`已选第 ${selectedIndex+1} 页，读取该页原图中的进度条位置、颜色与实际效果`});
      const response=await request(config,env.system,[{type:'text',text:`提取这张完整预览中的页顶进度横列。参考页已固定为索引${selectedIndex}，不得切换。所有位置、填色、文字色、渐变、描边及阴影只取自此图的横列，不读取标题或正文装饰，不按主题另配色。box为全部分段的紧贴外接框，不含阴影、标题或留白，按完整图片归一化坐标，限页顶35%；保留实际偏置、左右边界和垂直中心，不自动居中或铺满。当前、已过、未到状态均用此图已有配色；缺少状态时沿用此图最接近的已有填色，不引入另一页或风格库颜色。没有可见渐变时对应Gradient填null，没有描边时strokeWidth填0，没有阴影时shadow填null，不补效果。线宽、模糊及偏移按1600×900逻辑画布读取。仅返回JSON {referenceIndex:${selectedIndex},box:[x,y,w,h],appearance:{accent:"当前填色HEX",track:"未到填色HEX",completedFill:"已过填色HEX",ink:"文字HEX",muted:"未到章节字HEX",indicatorInk:"当前章节字HEX",border:"未到描边HEX",completedBorder:"已过描边HEX",activeBorder:"当前描边HEX",strokeWidth:0,shadow:null或{color:"HEX",opacity:0至1,blur:数值,offset:数值,angle:角度},trackGradient:null或{angle:角度,stops:[{position:0,color:"HEX",opacity:1},{position:1,color:"HEX",opacity:1}]},completedGradient:同结构,activeGradient:同结构},evidence:"实际看见的效果与位置依据"}`},{type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(source.file).toString('base64')}}],signal,{deferJSONValidation:true});
      chosen=validateProgressReference(parseJSON(response.text),[source]);
      chosen.evidence=[selected.evidence,chosen.evidence].filter(Boolean).join('；').slice(0,800);
    }catch(error){
      if(signal?.aborted)throw error;
      mode='preview-local';warning=String(error.message).slice(0,500);
      // Observed row geometry outranks isolated header shapes, even if those
      // unrelated shapes have a larger raw count. Preserve offset/short rows.
      const candidate=montage.result.candidates.find(c=>c.index===selectedIndex)||[...montage.result.candidates].sort((a,b)=>Number(!!b.box)-Number(!!a.box)||(b.matchScore??b.score??0)-(a.matchScore??a.score??0)||(b.score||0)-(a.score||0))[0],colors=candidate.colors,accent=candidate.accent;
      const rgb=c=>c.match(/../g).map(v=>parseInt(v,16)),luma=c=>rgb(c).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
      const nearest=target=>colors.reduce((best,c)=>rgb(c).reduce((n,v,i)=>n+(v-rgb(target)[i])**2,0)<rgb(best).reduce((n,v,i)=>n+(v-rgb(target)[i])**2,0)?c:best,colors[0]);
      const dark=[...colors].sort((a,b)=>luma(a)-luma(b))[0],light=[...colors].sort((a,b)=>luma(b)-luma(a))[0],track=nearest('E5E5E5');
      const ink=luma(track)>140?dark:light,indicatorInk=luma(accent)>145?dark:light;
      chosen={index:candidate.index,box:candidate.box||null,appearance:{accent,track,completedFill:nearest('B4C6E8'),ink,muted:ink,indicatorInk,strokeWidth:0,border:track,completedBorder:accent,activeBorder:accent,shadow:null},evidence:'视觉接口不可用，依据所选横列形状匹配及成组轮廓定位，配色读取同一参考页横列像素；无法可靠识别的渐变、描边和阴影不额外补入，未使用风格库配色'};
    }
    const source=pages.find(page=>page.index===chosen.index),colors={...Object.fromEntries(colorKeys.map(key=>[key,chosen.appearance[key]]))};
    const sampled=await local({operation:'sample',file:source.file,box:chosen.box||[0,0,1,.18],colors},'selected');Object.assign(chosen.appearance,sampled.result.colors);
    p.progressStyleReference={stamp,theme:p.selectedTheme,layout,index:source.index,previewHash:source.sha256,file:path.relative(path.join(env.data,p.id),source.file),record:path.relative(path.join(env.data,p.id),directory),box:chosen.box,appearance:chosen.appearance,evidence:chosen.evidence,mode,...(warning?{warning}:{}),at:new Date().toISOString()};env.save(p);
  }catch(error){if(signal?.aborted)throw error;reportTask(signal,{kind:'step',status:'warning',message:'页顶样式提取暂未完成，已保留既有横列样式：'+String(error.message).slice(0,300)});}
}
