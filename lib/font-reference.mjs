import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {nativeFontFace} from './native-fonts.mjs';

// Candidate metrics are provisional. The pipeline accepts them only after a
// real PowerPoint render improves the same fixed local comparison regions.
export async function refineReferenceFonts({project,index,elements,reference,background,env,signal,targetKeys}){
  const candidates=elements.filter(e=>(!targetKeys||targetKeys.includes(e.key))&&e.type==='text'&&!e.managed&&!e.artisticText&&!e.gradient&&!e.outline&&!e.shadow&&!/[\^_$<>]|\\(?:frac|sqrt)/.test(e.text||'')&&e.text?.length<=350).slice(0,20).map(e=>({...e,fontFace:nativeFontFace(e.fontFace||'Microsoft YaHei')}));
  if(!candidates.length)return {elements,changes:[],status:'skipped'};
  try{
    const spec={reference,background,elements:candidates};
    const stamp=crypto.createHash('sha256').update(JSON.stringify([1,spec,fs.statSync(reference).mtimeMs])).digest('hex').slice(0,24);
    const directory=path.join(env.data,project.id,'geometry-records','font-reference',index+'-'+stamp),file=path.join(directory,'input.json'),output=path.join(directory,'result.json'),record=path.relative(path.join(env.data,project.id),directory);
    fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file,JSON.stringify(spec));
    let result;
    if(fs.existsSync(output))result=JSON.parse(fs.readFileSync(output,'utf8'));
    else{
      const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
      result=JSON.parse((await env.run(python,[path.join(env.root,'tools','font_reference.py'),file],{windowsHide:true,timeout:45000,maxBuffer:2000000,signal})).stdout);
      fs.writeFileSync(output,JSON.stringify(result));
    }
    const changes=[],proposals=new Map((result.proposals||[]).map(p=>[p.key,p]));
    const fitted=elements.map(e=>{
      const p=proposals.get(e.key);if(!p||!(p.confidence>=.8)||!Number.isFinite(p.beforeScore)||!Number.isFinite(p.afterScore)||p.afterScore<p.beforeScore+.025)return e;
      const v=p.properties;if(!v||typeof v.fontFace!=='string'||v.fontFace.length>120||/[\\/]/.test(v.fontFace)||!Number.isFinite(v.size)||v.size<Math.max(Math.min(20,e.size),e.size*.9)||v.size>e.size*1.1)return e;
      if(!Number.isFinite(v.charSpacing)||Math.abs(v.charSpacing-(e.charSpacing||0))>e.size*.07||!Number.isFinite(v.lineSpacing)||v.lineSpacing<v.size||v.lineSpacing>v.size*3)return e;
      const properties={fontFace:v.fontFace,size:v.size,charSpacing:v.charSpacing,lineSpacing:v.lineSpacing};
      changes.push({key:e.key,beforeScore:p.beforeScore,afterScore:p.afterScore,properties});const {requestedFontFace,fontSubstitution,...rest}=e;return {...rest,...properties};
    });
    return {elements:fitted,changes,record,status:result.status};
  }catch(error){if(signal?.aborted)throw error;return {elements,changes:[],status:'unavailable',error:String(error.stderr||error.message).slice(-500)};}
}
