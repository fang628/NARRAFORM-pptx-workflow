import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {chat,parseJSON} from './provider.mjs';
import {reportTask} from './task-progress.mjs';
import {navigationTexts} from './progress-navigation.mjs';
import {progressShadowStroke,progressEffectsRule} from './progress-effects.mjs';
import {chapterOrder} from './chapter-pages.mjs';
import {previewFoundationReference} from './preview-foundation.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^#?[a-f0-9]{6}$/i.test(value)?value.replace('#','').toUpperCase():null;
const labelInkKeys=['muted','completedInk','indicatorInk'];
const colorKeys=['accent','track','completedFill','ink',...labelInkKeys,'border','completedBorder','activeBorder'];
export const progressReferenceVersion=16;
const measuredConfidence=.85;
const validBox=(box,minWidth=.2)=>Array.isArray(box)&&box.length===4&&box.every(Number.isFinite)&&box[0]>=0&&box[1]>=0&&box[2]>=minWidth&&box[3]>0&&box[0]+box[2]<=1.001&&box[1]+box[3]<=.35;
export function validateProgressReference(raw,pages,{inferLabelInk=true}={}){
  if(!pages.some(p=>p.index===raw?.referenceIndex))throw Error('进度条参考页不存在');
  const appearance={},warnings=[];
  const fills=['track','completedFill','accent'].map(key=>hex(raw.appearance?.[key])).filter(Boolean);
  const inks=['ink','muted','completedInk','indicatorInk'].map(key=>hex(raw.appearance?.[key])).filter(Boolean);
  for(const key of colorKeys){
    let value=hex(raw.appearance?.[key]);
    if(!value&&!inferLabelInk&&labelInkKeys.includes(key))continue;
    if(!value&&key==='completedInk')value=appearance.muted;
    if(!value&&['border','completedBorder','activeBorder'].includes(key)&&!(raw.appearance?.strokeWidth>0))value=hex(raw.appearance?.[{border:'track',completedBorder:'completedFill',activeBorder:'accent'}[key]]);
    if(!value){
      const borderFill={border:'track',completedBorder:'completedFill',activeBorder:'accent'}[key];
      if(borderFill)value=appearance[borderFill]||fills[0];
      else if(['accent','track','completedFill'].includes(key))value=fills[0];
      else value=inks[0]||(fills.length?'272727':null);
      if(!value)throw Error('横列配色缺少 '+key+'，且没有可沿用的同类颜色');
      warnings.push('横列配色缺少 '+key+(inks.length||['accent','track','completedFill'].includes(key)?'，沿用该图同类颜色':'，按底色选用可读字色'));
    }
    appearance[key]=value;
  }
  appearance.shadow=null;
  const box=raw.box;
  if(!validBox(box))throw Error('横列参考区域无效，请给出实际横列的外接框');
  const sharedBorder=hex(raw.appearance.sharedBorder),sharedStrokeWidth=raw.appearance.sharedStrokeWidth;
  if(sharedBorder&&Number.isFinite(sharedStrokeWidth)&&sharedStrokeWidth>0)Object.assign(appearance,{sharedBorder,sharedStrokeWidth:Math.min(3,sharedStrokeWidth)});
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

const navStamp=(p,index)=>hash(JSON.stringify(navigationTexts(p,index)));
const approvedPage=(p,index,sha256)=>!p.previewApproval?.pageChecks?.length||p.previewApproval.pageChecks.some(c=>c.index===index&&c.previewHash===sha256);
const resolveInside=(root,file)=>{
  const resolved=path.resolve(root,file);
  return resolved.startsWith(root+path.sep)?resolved:null;
};
function registeredSource(p,root,page){
  try{
    const foundation=previewFoundationReference(p,page.index,p.selectedTheme,page);
    if(!foundation)return {};
    const material=p.materials.find(m=>m.id===foundation.materialId);
    const background=material?.file&&resolveInside(path.join(root,'assets'),material.file);
    if(background&&hash(fs.readFileSync(background))===foundation.sha256)return {background,backgroundHash:foundation.sha256};
  }catch{}
  return {};
}

export function reusableProgressReference(p,env,layout){
  const ref=p.progressStyleReference;
  if(!ref||ref.theme!==p.selectedTheme||ref.layout!==layout||!ref.file||!ref.previewHash
    ||ref.directionStamp&&ref.directionStamp!==directionStamp(p))return false;
  if(ref.mode&&ref.version!==progressReferenceVersion)return false;
  const root=path.resolve(env.data,p.id),file=resolveInside(root,ref.file);
  if(!file||!approvedPage(p,ref.index,ref.previewHash))return false;
  try{
    if(hash(fs.readFileSync(file))!==ref.previewHash)return false;
    const current=p.visualPages?.[ref.index]||Object.values(p.visualPages||{}).find(page=>page?.file&&path.resolve(root,page.file)===file);
    if(current&&(current.previewHash!==ref.previewHash||path.resolve(root,current.file)!==file))return false;
    if(ref.version===progressReferenceVersion&&navStamp(p,ref.index)!==ref.navStamp)return false;
    if(current&&ref.version===progressReferenceVersion&&registeredSource(p,root,current).backgroundHash!==ref.backgroundHash)return false;
    validateProgressReference({referenceIndex:ref.index,box:ref.box,appearance:ref.appearance},[{index:ref.index}]);
    return true;
  }catch{return false;}
}

const unresolved=new WeakMap();

function progressPages(p,root){
  const order=chapterOrder(p);
  const pages=[];
  for(const [ordinal,index] of order.entries()){
    const page=p.visualPages?.[index],chapter=p.slides[index].generatedChapter;
    if(!page?.file||page.theme&&page.theme!==p.selectedTheme||chapter&&chapter.templateIndex!==index)continue;
    const nav=navigationTexts(p,index),active=nav.findIndex(n=>n.current);
    if(active<0||!approvedPage(p,index,page.previewHash))continue;
    const file=resolveInside(root,page.file);
    if(!file)continue;
    try{
      if(hash(fs.readFileSync(file))!==page.previewHash)continue;
    }catch{continue;}
    pages.push({index,file,pageNumber:ordinal+1,sha256:page.previewHash,labels:nav.map(n=>n.text),active,...registeredSource(p,root,page)});
  }
  return pages;
}

function validGeometry(geometry,count,minConfidence=measuredConfidence){
  return validBox(geometry?.box)&&geometry.segmentEvidence==='measured'&&Number.isFinite(geometry.confidence)&&geometry.confidence>=minConfidence&&geometry.confidence<=1&&
    geometry.segments?.length===count&&geometry.segments.every((segment,i,all)=>
      validBox(segment.box,.005)&&(!i||segment.box[0]>all[i-1].box[0])&&segment.polygon?.length>=3&&
      segment.polygon.every(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)));
}

function sameBox(a,b){
  if(!validBox(a)||!validBox(b))return false;
  const w=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]));
  const h=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
  return w*h/(a[2]*a[3]+b[2]*b[3]-w*h)>=.55;
}

function observedAppearance(model,sampled){
  const measured=sampled?.appearance||{},appearance={...model,...measured};
  for(const [state,border] of [['track','border'],['completed','completedBorder'],['active','activeBorder']]){
    if(!sampled?.sampleEvidence?.[state]?.fillMeasured)continue;
    for(const key of ['Gradient','Shadow','StrokeWidth'].map(key=>state+key).concat(border)){
      if(!Object.hasOwn(measured,key))delete appearance[key];
    }
  }
  appearance.ink=measured.muted||measured.completedInk||measured.indicatorInk||appearance.ink;
  appearance.track||=appearance.completedFill||appearance.accent;
  appearance.completedFill||=appearance.track;
  appearance.accent||=appearance.track;
  return appearance;
}

export async function prepareProgressReference(p,env,signal,{request=chat,refresh=false}={}){
  if(p.brief.progress===false&&!p.slides.some(s=>s.generatedChapter))return;
  const layout=p.deliveryMotion?.progressLayout||'chevron';
  signal?.throwIfAborted();
  const reusable=reusableProgressReference(p,env,layout);
  if(!refresh&&reusable)return;
  const root=path.resolve(env.data,p.id),pages=progressPages(p,root),direction=directionStamp(p);
  const stamp=hash(JSON.stringify([progressReferenceVersion,direction,layout,pages.map(({index,sha256,labels,active,backgroundHash})=>[index,sha256,labels,active,backgroundHash])]));
  if(!refresh&&unresolved.get(p)===stamp)return;
  // A reference from an unapproved/replaced preview must not drive 05.
  const removed=!!p.progressStyleReference&&!reusable;
  if(removed)delete p.progressStyleReference;
  if(!pages.length){if(removed)env.save(p);return;}
  const directory=path.join(root,'geometry-records','progress-style',stamp);
  const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const local=async(spec,name)=>{
    const file=path.join(directory,name+'.json'),png=path.join(directory,name+'.png');
    fs.writeFileSync(file,JSON.stringify({layout,...spec}));
    const {stdout}=await env.run(python,[path.join(env.root,'tools/progress_reference.py'),file,png],{windowsHide:true,timeout:60000,maxBuffer:2000000,signal});
    return {png,result:JSON.parse(stdout)};
  };
  try{
    fs.mkdirSync(directory,{recursive:true});
    reportTask(signal,{kind:'step',message:'定位已确认预览的进度横列，按实际分段从同一张图测量三态样式'});
    const {png,result}=await local({operation:'locate',pages},'headers');
    const byPage=new Map(pages.map(page=>[page.index,page]));
    const measured=result.candidates.filter(c=>validGeometry(c.geometry,byPage.get(c.index)?.labels.length));
    const best=measured[0];
    let model,warning;
    const config=env.credentials.get(p.id)?.text;
    if(!best&&result.shortlist.length&&(config||request!==chat)){
      const offered=pages.filter(page=>result.shortlist.includes(page.index));
      try{
        const response=await request(config,env.system,[{type:'text',text:`${progressEffectsRule}\n从联系表选一条完整、与章节顺序吻合的${layout==='bubble'?'气泡':'箭形'}横列，忽略标题及装饰。P为播放页码，referenceIndex只取标注的index。图块展示整页横向与顶部35%，box以完整页画布归一化。返回JSON {referenceIndex,box:[x,y,w,h],appearance:{track,completedFill,accent,muted,completedInk,indicatorInk,border,completedBorder,activeBorder,trackStrokeWidth,completedStrokeWidth,activeStrokeWidth,trackGradient,completedGradient,activeGradient,trackShadow,completedShadow,activeShadow},evidence}。颜色为六位HEX，只报告所选横列能确认的值。track=未到、completed=已过、active=当前。仅竖向渐变，格式{angle:90,stops:[{position,color,opacity}]}。阴影格式{color,opacity,blur,offset,angle}，尺寸按1600×900画布。章节信息 ${JSON.stringify(offered.map(({index,labels,active})=>({index,labels,active})))}`},{type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(png).toString('base64')}}],signal,{deferJSONValidation:true});
        const parsed=parseJSON(response.text);
        if(!offered.some(page=>page.index===parsed.referenceIndex)||!validBox(parsed.box))throw Error('视觉返回的参考横列无效');
        model=parsed;
      }catch(error){if(signal?.aborted)throw error;warning=String(error.message).slice(0,300);}
    }
    const weak=result.candidates.find(c=>c.geometry?.confidence>=.60&&validBox(c.geometry.box));
    const source=byPage.get(model?.referenceIndex??best?.index??weak?.index);
    if(!source)throw Error(warning||'未找到可确认的分段横列');
    const found=result.candidates.find(c=>c.index===source.index)?.geometry;
    const geometry=found&&(!model||sameBox(found.box,model.box))?found:undefined;
    let fit;
    try{
      fit=(await local({operation:'measure',page:source,geometry,hint:model?.box},'selected')).result;
    }catch(error){
      if(signal?.aborted||!model)throw error;
      fit={warnings:['选定预览的本地取样失败，沿用该页视觉证据']};
    }
    const sampled=!model||sameBox(fit.geometry?.box,model.box)?fit:{};
    const measuredGeometry=validGeometry(sampled.geometry,source.labels.length,model ? .70 : measuredConfidence)?sampled.geometry:undefined;
    const appearance=observedAppearance(model?.appearance,sampled);
    const mode=measuredGeometry?'preview-local':model?'preview-vision':'preview-estimated';
    const box=measuredGeometry?.box??model?.box??sampled.geometry?.box;
    const checked=validateProgressReference({referenceIndex:source.index,box,appearance,evidence:measuredGeometry?.method||model?.evidence||sampled.geometry?.method},[source],{inferLabelInk:false});
    const pageBoxes=Object.fromEntries(measured.map(c=>{
      return [c.index,{box:c.geometry.box,previewHash:byPage.get(c.index).sha256}];
    }));
    if(measuredGeometry||model)pageBoxes[source.index]={box,previewHash:source.sha256};
    const warnings=[warning,!measuredGeometry&&'分段边界证据不足，部分样式沿用可辨证据',...(fit.warnings||[]),...(checked.warnings||[])].filter(Boolean);
    signal?.throwIfAborted();
    p.progressStyleReference={stamp,version:progressReferenceVersion,directionStamp:direction,theme:p.selectedTheme,layout,index:source.index,
      previewHash:source.sha256,file:path.relative(root,source.file),backgroundHash:source.backgroundHash,navStamp:navStamp(p,source.index),
      record:path.relative(root,directory),box:checked.box,appearance:checked.appearance,geometry:measuredGeometry,pageBoxes,
      sharedDividers:sampled.sharedDividers||[],
      sampleEvidence:sampled.sampleEvidence,effectEvidence:sampled.effectEvidence,backgroundMatched:sampled.backgroundMatched,
      evidence:checked.evidence,mode,...(warnings.length?{warning:warnings.join('；'),warnings}:{}),at:new Date().toISOString()};
    unresolved.delete(p);
    env.save(p);
  }catch(error){
    if(signal?.aborted)throw error;
    unresolved.set(p,stamp);
    if(removed)env.save(p);
    reportTask(signal,{kind:'step',status:'warning',message:'进度条参考证据不足：'+String(error.message).slice(0,300)});
  }
}
