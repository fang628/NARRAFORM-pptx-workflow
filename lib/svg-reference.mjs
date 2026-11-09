import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {renderSVG} from './render-pool.mjs';
import {rebuildAssetIdentity} from './rebuild-reuse.mjs';
import {buildObjectMasks} from './object-masks.mjs';
import {assertCurrentExecution} from './execution-context.mjs';
import {mutateSVGTree,svgGeometrySearchStages,expandSVGUses,svgComponentSignature} from './svg-fitting.mjs';
import {isTextCarrier} from './native-carriers.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const number=v=>String(Math.round(v*10000)/10000);
const attribute=(tag,name)=>tag.match(new RegExp('\\b'+name+'\\s*=\\s*["\']([^"\']*)["\']'))?.[1];
function setAttribute(tag,name,value){
  const pattern=new RegExp('\\s'+name+'\\s*=\\s*["\'][^"\']*["\']');
  return pattern.test(tag)?tag.replace(pattern,' '+name+'="'+escape(value)+'"'):tag.replace(/(\s*\/?>)$/,' '+name+'="'+escape(value)+'"$1');
}
export function svgGeometryLayers(svg){
  const stack=[],layers=[];
  for(const m of svg.matchAll(/<\/?([\w:]+)\b[^>]*>/g)){
    const tag=m[0],name=m[1];
    if(tag.startsWith('</')){stack.pop();continue;}
    const definition=stack.some(n=>['defs','clipPath','mask','pattern','filter'].includes(n));
    if(!definition&&['path','polygon','polyline','rect','circle','ellipse','line'].includes(name))layers.push({tag,name,offset:m.index});
    if(!/\/\s*>$/.test(tag))stack.push(name);
  }
  return layers;
}
// Colour values stay unchanged. Gradient geometry and effect extent may be
// fitted independently, without flattening paths, holes or stacking order.
export function svgAppearanceParameters(svg){
  const list=[];
  const view=attribute(svg.match(/<svg\b[^>]*>/)?.[0]||'','viewBox')?.trim().split(/[\s,]+/).map(Number);
  for(const [target,m] of [...svg.matchAll(/<(linearGradient|radialGradient|stop|feGaussianBlur|feDropShadow|feFlood)\b[^>]*>/g)].entries()){
    const tag=m[0],kind=m[1];
    const fields=kind==='linearGradient'?['x1','y1','x2','y2']:kind==='radialGradient'?['cx','cy','r']:kind==='stop'?['stop-opacity']:kind==='feFlood'?['flood-opacity']:['stdDeviation'];
    for(const field of fields){
      const raw=attribute(tag,field);if(raw===undefined||!/^[-+]?\d*\.?\d+%?$/.test(raw))continue;
      const percent=raw.endsWith('%'),value=Number(raw.replace('%',''))/(percent?100:1);if(!Number.isFinite(value))continue;
      const user=attribute(tag,'gradientUnits')==='userSpaceOnUse'&&!percent&&view?.length===4&&view.every(Number.isFinite);
      const vertical=['y1','y2','cy'].includes(field),extent=user?view[vertical?3:2]:1,origin=user?view[vertical?1:0]:0;
      list.push({kind:'appearance',target,field,percent,step:field==='stdDeviation'?Math.max(.35,value*.15):extent*.06,min:field==='stdDeviation'?0:field==='r'?extent*.01:user?origin-extent*.25:0,max:field==='stdDeviation'?Math.max(40,value*1.5):user?origin+extent*1.25:1});
    }
  }
  return list.slice(0,14);
}
export function mutateSVGGeometry(svg,parameter,delta){
  if(parameter.kind!=='appearance')return mutateSVGTree(svg,parameter,delta);
  if(parameter.kind==='appearance'){
    const m=[...svg.matchAll(/<(linearGradient|radialGradient|stop|feGaussianBlur|feDropShadow|feFlood)\b[^>]*>/g)][parameter.target];if(!m)return svg;
    const raw=attribute(m[0],parameter.field);if(raw===undefined)return svg;
    const value=Number(raw.replace('%',''))/(parameter.percent?100:1)+delta;
    if(!Number.isFinite(value)||value<parameter.min||value>parameter.max)return svg;
    const tag=setAttribute(m[0],parameter.field,number(value*(parameter.percent?100:1))+(parameter.percent?'%':''));
    return svg.slice(0,m.index)+tag+svg.slice(m.index+m[0].length);
  }
  return svg;
}

const regionFor=e=>{const pad=Math.min(40,Math.max(12,Math.min(e.w,e.h)*.15)),x=Math.max(0,e.x-pad),y=Math.max(0,e.y-pad);return {x,y,w:Math.min(1600,e.x+e.w+pad)-x,h:Math.min(900,e.y+e.h+pad)-y};};
const validTrialBox=(b,e)=>['x','y','w','h'].every(k=>Number.isFinite(b[k]))&&b.w>=4&&b.h>=4&&Math.abs(b.x-e.x)<=e.w*.12&&Math.abs(b.y-e.y)<=e.h*.12&&b.w>=e.w*.85&&b.w<=e.w*1.15&&b.h>=e.h*.85&&b.h<=e.h*1.15;
const safe=svg=>typeof svg==='string'&&svg.length<=180000&&!/<(?:text|image|foreignObject|script)\b|<!|<\?/i.test(svg);

function scoreSession(python,script,signal){
  signal?.throwIfAborted();const child=spawn(python,[script,'--serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']}),lines=createInterface({input:child.stdout});let pending,stderr='',closed=false;
  const reject=error=>{if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}};
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1200);});child.stdin.on('error',reject);
  child.on('error',error=>{closed=true;reject(error);});child.on('exit',code=>{closed=true;reject(Error('SVG拟合评分进程已结束（'+code+'）'+stderr));});
  lines.on('line',line=>{if(!pending)return;const current=pending;pending=null;clearTimeout(current.timer);try{current.resolve(JSON.parse(line));}catch(error){current.reject(error);}});
  const abort=()=>{reject(Error('任务已取消'));child.kill();};signal?.addEventListener('abort',abort,{once:true});
  return {request:spec=>new Promise((resolve,rejectRequest)=>{
    if(closed||signal?.aborted){rejectRequest(Error('SVG拟合已取消或结束'));return;}
    const timer=setTimeout(()=>{reject(Error('SVG拟合评分超时'));child.kill();},20000);
    pending={resolve,reject:rejectRequest,timer};child.stdin.write(JSON.stringify(spec)+'\n');
  }),close:async()=>{signal?.removeEventListener('abort',abort);reject(Error('SVG拟合评分已关闭'));lines.close();if(!closed){await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},1500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();});}}};
}

export async function refineReferenceSVGs({project,index,elements,reference,background,env,signal,maxElements=4,maxEvaluations=96,maxTimeMs=20000,allowControlPoints=true,targetKeys}){
  signal?.throwIfAborted();assertCurrentExecution();
  let started=Date.now();const output=[...elements],changes=[],records=[];
  const root=path.join(env.data,project.id),python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  for(const [position,e]of elements.entries()){
    if(records.length>=maxElements||Date.now()-started>maxTimeMs)break;
    if(targetKeys&&!targetKeys.includes(e.key))continue;
    if(e.type!=='image'||e.implementation!=='svg'||e.managed||e.artisticText||isTextCarrier(e))continue;
    const material=project.materials.find(m=>m.id===e.id),source=env.getImage(project,e.id);
    if(!material||!source||!fs.existsSync(source))continue;
    let svg=fs.readFileSync(source,'utf8');if(!safe(svg))continue;
    try{svg=expandSVGUses(svg);}catch{continue;}
    const layers=svgGeometryLayers(svg);if(!layers.length||layers.length>40)continue;
    const stamp=hash(JSON.stringify([5,index,e,allowControlPoints,hash(svg),fs.statSync(reference).mtimeMs,fs.statSync(background).mtimeMs]));
    const directory=path.join(root,'geometry-records','svg-reference',stamp),record=path.relative(root,directory);fs.mkdirSync(directory,{recursive:true});
    const region=regionFor(e),scale=Math.min(1.5,480/Math.max(region.w,region.h)),width=Math.max(16,Math.round(region.w*scale)),height=Math.max(16,Math.round(region.h*scale));
    if(region.w<4||region.h<4){records.push({key:e.key,status:'unobservable',record});continue;}
    const occluders=elements.filter((o,oi)=>o.key!==e.key&&(oi>position||o.type==='text'||o.type==='formula'||o.type==='image'&&!o.implementation));
    const objectMasks=await buildObjectMasks({elements:occluders,directory:path.join(root,'geometry-records','object-masks'),getImage:id=>env.getImage(project,id),signal});
    const exclude=[];
    let sequence=0,evaluations=0,scorer;
    let resolution=1;
    const evaluate=async states=>{
      signal?.throwIfAborted();assertCurrentExecution();const candidates=[];
      try{
      for(let start=0;start<states.length;start+=4)await Promise.all(states.slice(start,start+4).map(async state=>{
        const id=sequence++,file=path.join(directory,'candidate-'+id+'.png'),b=state.box;
        const template=`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(16,Math.round(width*resolution))}" height="${Math.max(16,Math.round(height*resolution))}" viewBox="${region.x} ${region.y} ${region.w} ${region.h}"><image href="data:image/svg+xml;base64,${Buffer.from(state.svg).toString('base64')}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="xMidYMid meet"/></svg>`;
        fs.writeFileSync(file,await renderSVG(template,{font:{loadSystemFonts:false}},signal));candidates.push({id,file});evaluations++;
      }));
      candidates.sort((a,b)=>a.id-b.id);
      const spec={reference,background,region,exclude,occluders,objectMasks,candidates};
      const input=path.join(directory,'score.json');fs.writeFileSync(input,JSON.stringify(spec));
      const result=scorer?await scorer.request(spec):JSON.parse((await env.run(python,[path.join(env.root,'tools','svg_fit_score.py'),input],{windowsHide:true,timeout:20000,maxBuffer:1000000,signal})).stdout);
      return states.map((state,i)=>({...state,measurement:result.scores?.find(s=>s.id===candidates[i].id),score:result.scores?.find(s=>s.id===candidates[i].id)?.score??-Infinity}));
      }finally{for(const {file}of candidates)fs.rmSync(file,{force:true});}
    };
    try{
      const queued=Date.now();
      const search=async()=>{
       started+=Date.now()-queued;scorer=scoreSession(python,path.join(env.root,'tools','svg_fit_score.py'),signal);
       try{
        const initial={svg,box:{x:e.x,y:e.y,w:e.w,h:e.h}};let best=(await evaluate([initial]))[0];let baseline=best.score;
        if(!Number.isFinite(baseline))return {best,baseline};
        const stages=svgGeometrySearchStages(svg,e,{allowControlPoints});
        const appearance=svgAppearanceParameters(svg),paint=appearance.filter(p=>!['stdDeviation','flood-opacity'].includes(p.field)),effects=appearance.filter(p=>['stdDeviation','flood-opacity'].includes(p.field));
        stages.push({name:'paint',weight:.10,parameters:paint},{name:'effects',weight:.05,parameters:effects});
        const nonempty=stages.filter(s=>s.parameters.length),weight=nonempty.reduce((n,s)=>n+s.weight,0),available=Math.max(0,maxEvaluations-evaluations-4-nonempty.length);
        for(const stage of nonempty){
        resolution=stage.name==='placement'?.6:stage.name==='components'?.8:1;
        best=(await evaluate([best]))[0];const stageStart=evaluations,quota=Math.max(2,Math.floor(available*stage.weight/weight));
        // Probe different parameters before refining the most responsive ones.
        // Every nonempty parameter group receives a reserved evaluation quota.
        const responsive=[];
        for(const parameter of stage.parameters){
        if(evaluations+2>maxEvaluations-4||evaluations-stageStart+2>quota||Date.now()-started>maxTimeMs)break;
        const factor=1,before=best.score;
        const states=[-1,1].map(sign=>{
          const delta=parameter.step*factor*sign,box={...best.box};let next=best.svg;
          if(parameter.kind==='box')box[parameter.field]+=delta;else next=mutateSVGGeometry(next,parameter,delta);
          if(!validTrialBox(box,e))return null;
          return {svg:next,box};
        }).filter(Boolean);
        if(!states.length)continue;
        const results=await evaluate(states);for(const candidate of results)if(candidate.score>best.score+.0015)best=candidate;
        responsive.push({parameter,gain:best.score-before});
        }
        for(const {parameter,gain}of responsive.sort((a,b)=>b.gain-a.gain)){
          if(gain<.0015||evaluations+2>maxEvaluations-4||evaluations-stageStart+2>quota||Date.now()-started>maxTimeMs)break;
          const states=[-1,1].map(sign=>{const box={...best.box};let next=best.svg;const delta=parameter.step*.4*sign;if(parameter.kind==='box')box[parameter.field]+=delta;else next=mutateSVGGeometry(next,parameter,delta);return {svg:next,box};}).filter(s=>validTrialBox(s.box,e));
          if(states.length){const results=await evaluate(states);for(const candidate of results)if(candidate.score>best.score+.0015)best=candidate;}
        }
        }
        resolution=1;const confirmed=await evaluate([initial,best]);baseline=confirmed[0].score;best=confirmed[1];
        if(JSON.stringify(svgComponentSignature(best.svg))!==JSON.stringify(svgComponentSignature(svg)))return {best:confirmed[0],baseline};
        return {best,baseline};
       }finally{await scorer.close();scorer=null;}
      };
      const {best,baseline}=env.run.session?await env.run.session(search,{signal}):await search();if(!Number.isFinite(baseline))continue;
      const entry={key:e.key,status:'unchanged',method:'staged-multiscale-component-geometry-paint-fit',beforeScore:baseline,afterScore:best.score,evaluations,layers:layers.length,record};records.push(entry);
      if(best.score<baseline+.012)continue;
      const assets=path.join(root,'assets');fs.mkdirSync(assets,{recursive:true});const id=crypto.randomUUID(),file=id+'.svg',target=path.join(assets,file),draft=path.join(directory,'fitted.svg');fs.writeFileSync(draft,best.svg);
      // Use the same strict SVG validator and raster compatibility repairs as
      // ordinary reconstruction. Never mutate a shared registered asset in place.
      await env.run(python,[path.join(env.root,'tools','visual_assets.py'),'svg',draft,target,String(Math.max(1,Math.min(1920,Math.round(e.w*1.2)))),String(Math.max(1,Math.min(1080,Math.round(e.h*1.2)))),JSON.stringify({frameKind:e.frameKind,contourKind:e.contourKind,arrowRole:e.arrowRole})],{windowsHide:true,timeout:45000,maxBuffer:1000000,signal});
      const validated=fs.readFileSync(target,'utf8');const confirmed=(await evaluate([{svg:validated,box:best.box}]))[0];
      if(confirmed.score<baseline+.01){entry.status='validation-reverted';continue;}
      const asset={id,file,name:'参考拟合 · '+(material.name||e.key),kind:'image',generated:true,reconstructed:true,purpose:'reconstruction',svg:true,sha256:hash(validated),size:Buffer.byteLength(validated),origin:'reference-svg-fit',parentAssetId:e.id,parentAssetHash:material.sha256,sourcePreviewHash:project.visualPages?.[index]?.previewHash,rebuildIdentity:rebuildAssetIdentity({method:'svg',svg:validated}),svgFitVersion:2};
      signal?.throwIfAborted();assertCurrentExecution();project.materials.push(asset);output[position]={...e,...best.box,id,referenceFitted:true};entry.status='trial';entry.afterScore=confirmed.score;entry.assetId=id;changes.push({...entry});
    }catch(error){if(signal?.aborted)throw error;records.push({key:e.key,status:'unavailable',record,error:String(error.stderr||error.message).slice(-700)});}
    finally{fs.writeFileSync(path.join(directory,'fit-report.json'),JSON.stringify(records.filter(r=>r.key===e.key),null,2));}
  }
  return {elements:output,changes,records,status:'available'};
}
