import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {chat,parseJSON,visualModelConfig} from './provider.mjs';
import {reportTask} from './task-progress.mjs';
import {navigationTexts} from './progress-navigation.mjs';
import {progressShadowStroke,progressEffectsRule} from './progress-effects.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^#?[a-f0-9]{6}$/i.test(value)?value.replace('#','').toUpperCase():null;
const colorKeys=['accent','track','completedFill','ink','muted','indicatorInk','border','completedBorder','activeBorder'];
export const progressReferenceVersion=12;
export function validateProgressReference(raw,pages){
  if(!pages.some(p=>p.index===raw?.referenceIndex))throw Error('进度条参考页不存在');
  const appearance={},warnings=[];
  const fills=['track','completedFill','accent'].map(key=>hex(raw.appearance?.[key])).filter(Boolean);
  const inks=['ink','muted','indicatorInk'].map(key=>hex(raw.appearance?.[key])).filter(Boolean);
  for(const key of colorKeys){
    let value=hex(raw.appearance?.[key]);
    if(!value&&['border','completedBorder','activeBorder'].includes(key)&&!(raw.appearance?.strokeWidth>0))value=hex(raw.appearance?.[{border:'track',completedBorder:'completedFill',activeBorder:'accent'}[key]]);
    if(!value){
      const borderFill={border:'track',completedBorder:'completedFill',activeBorder:'accent'}[key];
      if(borderFill)value=appearance[borderFill]||fills[0];
      else if(['accent','track','completedFill'].includes(key))value=fills[0];
      else value=inks[0];
      if(!value)throw Error('横列配色缺少 '+key+'，且没有可沿用的同类颜色');
      warnings.push('横列配色缺少 '+key+'，仅沿用该图同类颜色');
    }
    appearance[key]=value;
  }
  appearance.shadow=null;
  const box=raw.box;
  if(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite)||box[0]<0||box[1]<0||box[2]<.2||box[3]<=0||box[0]+box[2]>1.001||box[1]+box[3]>.35)throw Error('横列参考区域无效，请给出实际横列的外接框');
  for(const key of ['shadow','trackShadow','completedShadow','activeShadow']){
    const s=raw.appearance[key];if(s===undefined)continue;
    appearance[key]=null;if(s===null)continue;
    const valid=hex(s.color)&&Number.isFinite(s.opacity)&&s.opacity>=0&&s.opacity<=1&&[s.blur,s.offset].every(Number.isFinite)&&s.blur>=0&&s.blur<=12&&s.offset>=0&&s.offset<=8&&(s.angle===undefined||Number.isFinite(s.angle));
    if(!valid){warnings.push('横列'+key+'参数无效，仅省略阴影');continue;}
    appearance[key]={type:'outer',color:hex(s.color),opacity:s.opacity,blur:s.blur,offset:s.offset,angle:((s.angle??90)%360+360)%360};
  }
  for(const key of ['trackGradient','completedGradient','activeGradient']){
    const gradient=raw.appearance[key];if(!gradient)continue;
    if(!Array.isArray(gradient.stops)||gradient.stops.length<2||gradient.stops.length>6||gradient.stops.some(s=>!hex(s.color)||!Number.isFinite(s.position)||s.position<0||s.position>1)){
      warnings.push('横列'+key+'参数无效，仅省略该渐变');continue;
    }
    const stops=gradient.stops.map(s=>({position:s.position,color:hex(s.color),opacity:Number.isFinite(s.opacity)?Math.max(0,Math.min(1,s.opacity)):1})).sort((a,b)=>a.position-b.position);
    if(stops.at(-1).position-stops[0].position<.01){warnings.push('横列'+key+'节点重合，仅省略该渐变');continue;}
    if(Number.isFinite(gradient.angle)&&gradient.angle!==90)warnings.push('横列'+key+'方向限制为竖向');
    appearance[key]={type:'linear',angle:90,stops};
  }
  appearance.strokeWidth=Number.isFinite(raw.appearance.strokeWidth)?Math.max(0,Math.min(3,raw.appearance.strokeWidth)):0;
  for(const state of ['track','completed','active','']){
    const shadowKey=state?state+'Shadow':'shadow';
    const widthKey=state?state+'StrokeWidth':'strokeWidth',rawWidth=raw.appearance[widthKey];
    const width=rawWidth===undefined?appearance.strokeWidth:Number.isFinite(rawWidth)?Math.max(0,Math.min(3,rawWidth)):0;
    const pair=progressShadowStroke(appearance[shadowKey]===undefined?appearance.shadow:appearance[shadowKey],width);
    if(state){appearance[widthKey]=pair.strokeWidth;if(pair.strokeConflict)warnings.push('横列'+state+'阴影与描边互斥，保留阴影并去掉描边');}
  }
  if(raw.appearance.strokeWidth!==undefined&&(!Number.isFinite(raw.appearance.strokeWidth)||raw.appearance.strokeWidth<0||raw.appearance.strokeWidth>3))warnings.push('横列描边宽度无效，仅限制为安全范围');
  return {index:raw.referenceIndex,box,appearance,evidence:String(raw.evidence||'').slice(0,800),...(warnings.length?{warnings}:{})};
}

function directionStamp(p){
  const d=p.concepts?.find(d=>d.id===p.selectedTheme)||p.themeAssets?.directions?.find(d=>d.id===p.selectedTheme);
  return hash(JSON.stringify([p.selectedTheme,d?.styleRegistrationId,d?.coreColor,d?.typography,d?.frames,d?.styleSummary??d?.style]));
}

export function reusableProgressReference(p,env,layout){
  const ref=p.progressStyleReference;
  if(!ref||ref.theme!==p.selectedTheme||ref.layout!==layout||!ref.file||!ref.previewHash
    ||ref.directionStamp&&ref.directionStamp!==directionStamp(p))return false;
  // Old all-or-nothing validation produced an explicitly failed local fallback,
  // not a confirmed style. Refresh those records instead of locking in the loss.
  if(ref.mode==='preview-local'&&ref.version!==progressReferenceVersion&&/阴影参数无效|渐变参数无效|横列配色缺少/.test(ref.warning||''))return false;
  if(ref.mode==='preview-local'&&Number(ref.version||0)<progressReferenceVersion)return false;
  if(ref.mode==='preview-vision'&&Number(ref.version||0)<progressReferenceVersion)return false;
  const root=path.resolve(env.data,p.id),file=path.resolve(root,ref.file);
  if(!file.startsWith(root+path.sep))return false;
  try{
    // The reference can live outside the selected page subset, but must remain
    // a registered approved preview. A replaced source invalidates its style.
    if(!fs.existsSync(file)||hash(fs.readFileSync(file))!==ref.previewHash)return false;
    const current=Object.values(p.visualPages||{}).find(page=>page?.file&&path.resolve(root,page.file)===file);
    if(current&&current.previewHash!==ref.previewHash)return false;
    const validated=validateProgressReference({referenceIndex:ref.index,box:ref.box,appearance:ref.appearance},[{index:ref.index}]);
    if(validated.warnings?.length)return false;
    return true;
  }catch{return false;}
}

export async function prepareProgressReference(p,env,signal,{request:baseRequest=chat,refresh=false}={}){
  const request=(config,system,content,...args)=>baseRequest(config,system,[{type:'text',text:progressEffectsRule},...content],...args);
  if(p.brief.progress===false)return;
  const layout=p.deliveryMotion?.progressLayout||'chevron';
  signal?.throwIfAborted();
  if(!refresh&&reusableProgressReference(p,env,layout))return;
  const pages=Object.values(p.visualPages||{}).filter(page=>page?.file&&!['cover','toc'].includes(p.slides[page.index]?.kind)).map(page=>({index:page.index,file:path.resolve(env.data,p.id,page.file),sha256:page.previewHash})).filter(page=>fs.existsSync(page.file)&&hash(fs.readFileSync(page.file))===page.sha256);
  if(!pages.length)return;
  const stamp=hash(JSON.stringify([progressReferenceVersion,directionStamp(p),layout,pages.map(({index,sha256})=>[index,sha256])]));
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
      const response=await request(config,env.system,[{type:'text',text:`提取此图页顶进度横列，固定参考索引${selectedIndex}。所有位置、填色、文字色、渐变、描边和阴影仅取此图横列；原生色块禁止发光，不读取正文装饰或另配主题色。box为全部分段的紧贴外接框，不含外围效果，归一化坐标且限页顶35%；保留实际偏置和长度，不自动居中或铺满。当前、已过、未到分别读取；缺少状态的填色沿用此图最接近的已有填色。效果前缀track=未到、completed=已过、active=当前：分别返回三套Gradient、Shadow，不返回Glow。Gradient仅允许竖向angle:90，禁止横向或斜向渐变，stops为2至6个{position:0至1,color:"HEX",opacity:0至1}；禁止发光，不将柔光当亮描边；Shadow为{color:"HEX",opacity:0至1,blur:0至12,offset:0至8,angle:0至360}。同一状态的阴影与描边互斥；无法分辨则省略并说明。未观察到效果填null；遮挡或缺失导致无法判断则省略字段并在evidence说明，不补效果。线宽、半径、模糊、偏移按1600×900逻辑画布读取。仅返回JSON {referenceIndex:${selectedIndex},box:[x,y,w,h],appearance:{accent:"当前填色HEX",track:"未到填色HEX",completedFill:"已过填色HEX",ink:"文字HEX",muted:"未到章节字HEX",indicatorInk:"当前章节字HEX",border:"未到描边HEX",completedBorder:"已过描边HEX",activeBorder:"当前描边HEX",strokeWidth:0至3,shadow:null,trackGradient:null,completedGradient:null,activeGradient:null,trackShadow:null,completedShadow:null,activeShadow:null},evidence:"实际效果、位置依据及无法判定的状态"}`},{type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(source.file).toString('base64')}}],signal,{deferJSONValidation:true});
      chosen=validateProgressReference(parseJSON(response.text),[source]);
      chosen.evidence=[selected.evidence,chosen.evidence].filter(Boolean).join('；').slice(0,800);
    }catch(error){
      if(signal?.aborted)throw error;
      mode='preview-local';warning=String(error.message).slice(0,500);
      // Observed row geometry outranks isolated header shapes, even if those
      // unrelated shapes have a larger raw count. Preserve offset/short rows.
      const candidate=montage.result.candidates.find(c=>c.index===selectedIndex)||[...montage.result.candidates].sort((a,b)=>Number(!!b.box)-Number(!!a.box)||(b.matchScore??b.score??0)-(a.matchScore??a.score??0)||(b.score||0)-(a.score||0))[0],colors=candidate.colors,accent=candidate.accent;
      const rgb=c=>c.match(/../g).map(v=>parseInt(v,16)),luma=c=>rgb(c).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
      const dark=[...colors].sort((a,b)=>luma(a)-luma(b))[0],light=[...colors].sort((a,b)=>luma(b)-luma(a))[0],track=candidate.fillColors?.[0]||colors[0];
      const ink=luma(track)>140?dark:light,indicatorInk=luma(accent)>145?dark:light;
      chosen={index:candidate.index,box:candidate.box||null,appearance:{accent,track,completedFill:track,ink,muted:ink,indicatorInk,strokeWidth:0,border:track,completedBorder:accent,activeBorder:accent,shadow:null},evidence:'视觉提取未完成，按同页横列的填充、文字和边缘分别取样；不使用浅灰默认目标或风格库颜色，无法可靠测量的效果不补造'};
    }
    const source=pages.find(page=>page.index===chosen.index),colors={...Object.fromEntries(colorKeys.map(key=>[key,chosen.appearance[key]]))};
    const nav=navigationTexts(p,source.index);
    try{
      const sampled=await local({operation:'sample',file:source.file,box:chosen.box||[0,0,1,.18],colors,
        inferStates:mode==='preview-local',sectionCount:nav.length,currentIndex:nav.findIndex(n=>n.current)},'selected');
      Object.assign(chosen.appearance,mode==='preview-local'&&sampled.result.appearance?sampled.result.appearance:sampled.result.colors);
      if(sampled.result.outlineEvidence)chosen.outlineEvidence=sampled.result.outlineEvidence;
      if(sampled.result.effectEvidence){
        chosen.effectEvidence=sampled.result.effectEvidence;
        // Positive measurements can fill missing fields. Unobservable never
        // erases a valid visual observation, nor does absence erase that source.
        for(const [key,value] of Object.entries(sampled.result.effects||{}))if(mode==='preview-local'||chosen.appearance[key]===undefined||chosen.appearance[key]===null&&value)chosen.appearance[key]=value;
      }
    }catch(error){if(signal?.aborted)throw error;chosen.warnings=[...(chosen.warnings||[]),'本地取色未完成，保留有效视觉样式：'+error.message];}
    // Local measurements and legacy shared effects meet here; enforce the same
    // exclusivity after merging as during validation and scene generation.
    const checked=validateProgressReference({referenceIndex:source.index,box:chosen.box||[0,0,1,.18],appearance:chosen.appearance},[source]);
    chosen.appearance=checked.appearance;
    const warnings=[...(warning?[warning]:[]),...(chosen.warnings||[]),...(checked.warnings||[])];
    signal?.throwIfAborted();
    p.progressStyleReference={stamp,version:progressReferenceVersion,directionStamp:directionStamp(p),theme:p.selectedTheme,layout,index:source.index,previewHash:source.sha256,file:path.relative(path.join(env.data,p.id),source.file),record:path.relative(path.join(env.data,p.id),directory),box:chosen.box,appearance:chosen.appearance,evidence:chosen.evidence,...(chosen.outlineEvidence?{outlineEvidence:chosen.outlineEvidence}:{}),...(chosen.effectEvidence?{effectEvidence:chosen.effectEvidence}:{}),mode,...(warnings.length?{warning:warnings.join('；'),warnings}:{}),at:new Date().toISOString()};env.save(p);
  }catch(error){if(signal?.aborted)throw error;reportTask(signal,{kind:'step',status:'warning',message:'页顶样式提取暂未完成，已保留既有横列样式：'+String(error.message).slice(0,300)});}
}
