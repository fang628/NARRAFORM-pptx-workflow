import crypto from 'node:crypto';
import {workflowStyles,workflowLibraryVersion} from './workflow-library.mjs';

const fields=['name','description','style','coreColor','typography','frames','decoration','layoutLanguage'];
const fingerprint=definition=>crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');
export const styleDefinitionSchema=`referenceStyleId:"可选的参考样例 A-F 或本项目已登记 STYLE 编号；原创风格填 null",name:"风格名称",description:"适用题材、受众及选择理由",style:"实际主色、辅助色、强调色及各自用途",coreColor:"#六位核心底色色值",typography:"标题、小标题、正文的字体气质与字色",frames:"各角色框形或无框、填充与描边",decoration:"装饰图形、图片的语言、用途和密度",layoutLanguage:"宏观分块、阅读路径及真实内容关系，可创造新的版式"`;

export function validateStyleDefinition(raw,p={}, {allowDeleted=false}={}){
  if(!raw||typeof raw!=='object')throw Error('风格登记缺少完整定义');
  const definition={};
  for(const key of fields){
    const value=key==='style'?(raw.styleSummary??raw.style):raw[key];
    if(typeof value!=='string'||!value.trim()||value.length>(key==='style'?6000:key==='name'?100:2000))throw Error('风格登记缺少有效的 '+key);
    definition[key]=value.trim();
  }
  if(!/^#[\da-f]{6}$/i.test(definition.coreColor))throw Error('风格登记的核心底色无效');
  const ref=raw.referenceStyleId==null||raw.referenceStyleId===''?null:raw.referenceStyleId;
  if(ref!==null&&(typeof ref!=='string'||!workflowStyles.some(s=>s.id===ref&&(allowDeleted||!s.deletedAt))&&!(p.styleRegistry||[]).some(s=>s.id===ref&&(allowDeleted||!s.deletedAt))))throw Error('参考风格编号不存在；原创风格请将 referenceStyleId 填为 null');
  return {...definition,referenceStyleId:ref};
}

// Append immutable definitions; revised rules receive another ID and preserve earlier jobs.
export function registerStyleDirections(p,directions,stage){
  const definitions=directions.map(d=>validateStyleDefinition(d,p,{allowDeleted:!!p.styleRegistry?.some(r=>r.id===d.styleRegistrationId)}));
  p.styleRegistry??=[];
  return directions.map((d,i)=>{
    const definition=definitions[i],hash=fingerprint(definition);
    let record=p.styleRegistry.find(s=>s.fingerprint===hash&&(!s.deletedAt||s.id===d.styleRegistrationId));
    if(!record){
      record={id:'STYLE-'+hash.slice(0,16)+(p.styleRegistry.some(s=>s.fingerprint===hash)?'-'+crypto.randomUUID().slice(0,8):''),fingerprint:hash,definition,origin:definition.referenceStyleId?'reference-adaptation':'custom',libraryVersion:workflowLibraryVersion,registeredAt:new Date().toISOString(),stage};
      p.styleRegistry.push(record);
    }
    return {...d,...definition,styleRegistrationId:record.id};
  });
}

export function requireStyleRegistration(p,direction){
  const record=(p.styleRegistry||[]).find(s=>s.id===direction?.styleRegistrationId);
  if(!record)throw Error('此视觉方向尚未登记，请重新规划三方向底图或生成三版方案');
  const definition=validateStyleDefinition(direction,p,{allowDeleted:true}),hash=fingerprint(definition);
  if(record.fingerprint!==hash||fingerprint(record.definition)!==hash)throw Error('风格定义与登记记录不一致，请重新规划并登记后生成');
  return record;
}

export function registeredStyleContext(p){
  const records=(p.styleRegistry||[]).filter(r=>!r.deletedAt);
  return records.length?'本项目最近登记风格（可参考复用，发生变化需登记新版本）：\n'+JSON.stringify(records.slice(-20).map(({id,definition})=>({id,...definition}))):'本项目尚无已登记风格。新风格将自动登记后再用于生图。';
}

export function describeStyle(d){
  return `${d.styleSummary??d.style}\n核心底色：${d.coreColor}；文字层级与字色：${d.typography}；文本承载、填充与描边：${d.frames}；装饰语言：${d.decoration}；宏观分块语言：${d.layoutLanguage}。保持同方向底图的核心底色，排版按内容关系有创意，底图细节不压过文字。`;
}

// Retain immutable provenance for existing images, remove from future selection.
export function deleteRegisteredStyle(p,id){
  const record=p.styleRegistry?.find(r=>r.id===id&&!r.deletedAt);
  if(!record)throw Error('风格登记不存在或已删除');
  record.deletedAt=new Date().toISOString();
  for(const old of p.reuseCheckpoint?.source?.styleRegistry||[])if(old.id===id)old.deletedAt=record.deletedAt;
  return record;
}
