import {imageCaptionRule,isImageAnnotation} from './image-caption-rules.mjs';
export {isImageAnnotation};
export const parallelContentRule='发现并列信息时必须拆为独立分点：不同方法、结果、优势或条件分别建立独立text节点，共用真实父项，不用顿号、分号、换行或一段长句把多个并列信息塞进一个节点；各分点可以用准确的短语组合表达，不要求补成完整句子，关键结论的一句完整表达仍保留。不要机械拆开术语、公式、数值与单位；有真实附属关系才继续嵌套。';
export const contentNodeMeaningRule='字段语义：type=text 的 label 只是网页排版树中的内部识别标签，没有上屏含义，不是小标题，不得据此新增、改写或推断任何页面文案、分组名或论点；文本实际上屏内容只取 text。只有明确建立的 type=group 才是小标题节点，其 label 按现有数据结构保存实际的小标题文案；没有真正小标题时，正文直接归属已有主题或主标题，不把文本标签升级为小标题。图片 label 仅定位配图，不能替代实际图片标题或图注。图片标题用text、role=imageTitle，不是group小标题。';
export const contentNodesForModel=nodes=>nodes.map(n=>{
  if(n.type!=='text')return n;
  const {label,...content}=n;return content;
});
export const headingBodyAlignmentRule='小标题与其一段或多段正文构成同一内容单元：上下排时共用左对齐轴；左右排时小标题与首段正文顶端对齐，多段正文共用起始线；同级单元保持一致的对应方式，小标题紧邻所属正文，不跨组错配，标题与正文分别保留为独立文本框。';
export const contentHierarchyRules='按真实语义主动生成多层嵌套，避免将所有正文、数据、说明和图片平铺在标题下一层。典型结构为：主标题 → 小标题/主题观点 → 论据、数据或图片 → 补充说明/图注。论据从属于其支撑的观点，细节从属于对应论据，图片从属于描述它的主题，图片标题或图注是图片的直接子节点（type=text、role=imageTitle或caption、parentId=图片id），每图二选一、只留一项，不用group承载图片标题。同级节点才表示并列；需要独立小标题时使用 group，其 label 就是准确上屏文案。一个小标题对应一段正文时把正文作为该 group 的直接子项，对应多段正文时把各段作为该 group 下的同级子项；段内的条件、论据与解释继续嵌套，涉及多个子主题则再建子 group，不把“结论、条件、依据、限制”塞进一个粗分点，也不把所有小标题与正文放成同级列表。同一小标题下连续正文默认 layout=stack；多个主题需并排时在它们共同父组使用 layout=row，不把小标题和对应正文当成横排同级项。一般内容页按语义组织 2–4 层，标题下最多 5 层、整页最多 40 项；封面、目录或简单内容可保持浅层，不为凑层级创建空分组、重复标题或虚构信息。示例关系：title → findings(group) → finding(text) → evidence(image) → caption(text)。elements 是完整内容，不受兼容字段 body 的段数限制，body 只作旧格式摘要，不为满足它而合并或丢弃内容节点。层级表达内容归属，不强制 PPT 采用树形视觉。'+headingBodyAlignmentRule+imageCaptionRule+parallelContentRule+contentNodeMeaningRule;
export const elementSchema='elements:[{id:"节点id",type:"text|image|group",role:"title|subtitle|body|imageTitle|caption",label:"内部识别标签；仅group填写实际小标题",text:"实际文字；text节点的上屏内容",materialId:"图片材料id或null",parentId:"上级节点id或null",layout:"stack|row"}]。主标题恒为唯一根项；可选副标题至多一个，直接从属于主标题，作为标题附文，不参与正文和图片的并列排列。'+contentHierarchyRules;

// A caption is a normal editable text node: all design, provenance and export paths share it.
export function setImageAnnotation(nodes,imageId,captionId,value,role='caption'){
  const image=nodes.find(n=>n.id===imageId&&n.type==='image');if(!image)throw Error('图片字段不存在');
  if(!['imageTitle','caption'].includes(role))throw Error('请选择图片标题或图注');
  const text=String(value||'').trim(),requested=nodes.find(n=>n.id===captionId);
  if(requested&&!(isImageAnnotation(requested)&&requested.parentId===imageId))throw Error('图注字段已变化，请重新打开页面');
  const caption=requested||nodes.find(n=>isImageAnnotation(n)&&n.parentId===imageId),id=caption?.id||captionId;
  if(text.length>600)throw Error('图片标题或图注最多 600 字');
  const removed=new Set(nodes.filter(n=>isImageAnnotation(n)&&n.parentId===imageId&&(!text||n.id!==id)).map(n=>n.id));
  const retained=nodes.filter(n=>!removed.has(n.id)).map(n=>removed.has(n.parentId)?{...n,parentId:imageId}:n);
  if(!text)return retained;
  if(caption)return retained.map(n=>n.id===id?{...n,text,role,label:role==='imageTitle'?'图片标题':'图注'}:n);
  if(nodes.length>=40)throw Error('每页最多 40 个元素，请先移除一个字段再添加图注');
  return [...nodes,{id:captionId,type:'text',role,label:role==='imageTitle'?'图片标题':'图注',text,parentId:imageId,layout:'stack',materialId:null}];
}
export const setImageCaption=(nodes,imageId,captionId,value)=>setImageAnnotation(nodes,imageId,captionId,value,'caption');
export function validateImageAnnotations(nodes,{required=false}={}){
  for(const image of nodes.filter(n=>n.type==='image')){
    const annotations=nodes.filter(n=>isImageAnnotation(n)&&n.parentId===image.id&&n.text?.trim());
    if(annotations.length>1)throw Error('每张图片只能有一个图片标题或一条图注，不能同时存在或重复');
    if(required&&image.materialId&&!annotations.length)throw Error('图片「'+(image.label||image.id)+'」必须补充一个图片标题或一条图注，二选一，作为该图片的直接子节点');
  }
}
function titleRoot(nodes){
  const title=nodes.find(n=>n.type==='text'&&n.role==='title');if(!title)return nodes;
  return [title,...nodes.filter(n=>n.type==='text'&&n.role==='subtitle'),...nodes.filter(n=>n!==title&&!(n.type==='text'&&n.role==='subtitle'))].map(n=>n!==title&&!n.parentId?{...n,parentId:title.id}:n);
}
export function initialElements(s){
  if(s.elements)return titleRoot(structuredClone(s.elements));
  return titleRoot([{id:'title',type:'text',role:'title',label:'标题',text:s.title,parentId:null,layout:'stack'},...(s.subtitle?[{id:'subtitle',type:'text',role:'subtitle',label:'副标题',text:s.subtitle,parentId:null,layout:'stack'}]:[]),...s.body.map((text,i)=>({id:'body-'+i,type:'text',role:'body',label:'正文 '+(i+1),text,parentId:null,layout:'stack'})),...(s.imageId?[{id:'image',type:'image',label:'配图',materialId:s.imageId,parentId:null,layout:'stack'}]:[])]);
}
export function validateElements(raw){
  if(!Array.isArray(raw)||!raw.length||raw.length>40)throw Error('每页须有 1–40 个元素');
  const ids=new Set();let out=raw.map(n=>{
    if(!n||typeof n.id!=='string'||!/^[-\w]{1,100}$/.test(n.id)||ids.has(n.id))throw Error('元素编号无效或重复');ids.add(n.id);
    if(!['text','image','shape','group'].includes(n.type))throw Error('不支持的元素类型');
    const text=n.type==='group'?String(n.label||n.text||'小标题').trim().slice(0,80):String(n.text||'');if(text.length>600)throw Error('单个文本元素最多 600 字');
    if(n.type==='text'&&!text.trim())throw Error('文本元素不能为空');
    return {id:n.id,type:n.type,role:['title','subtitle','body','imageTitle','caption'].includes(n.role)?n.role:'body',label:n.type==='group'?text:String(n.label||'元素').slice(0,80),text,materialId:n.materialId?String(n.materialId):null,parentId:n.parentId?String(n.parentId):null,layout:n.layout==='row'?'row':'stack',color:/^[\da-f]{6}$/i.test(n.color)?n.color:'FFF238'};
  });
  if(out.filter(n=>n.role==='title'&&n.type==='text').length!==1)throw Error('每页需要且仅需要一个标题元素');
  if(out.filter(n=>n.role==='subtitle'&&n.type==='text').length>1)throw Error('每页至多一个副标题');
  const title=out.find(n=>n.type==='text'&&n.role==='title');if(title.parentId)throw Error('页面标题必须固定为最高顶层项');out=titleRoot(out);
  for(const n of out){const seen=new Set([n.id]);let parent=n.parentId,depth=0;while(parent){if(!ids.has(parent))throw Error('上级元素不存在');if(seen.has(parent))throw Error('元素关系不能形成循环');seen.add(parent);parent=out.find(x=>x.id===parent).parentId;if(++depth>5)throw Error('标题下内容关系最多 5 层');}if(n.role==='subtitle'&&n.type==='text'&&n.parentId!==title.id)throw Error('副标题须位于标题下的第一层');}
  validateImageAnnotations(out);
  if(out.some(n=>n.role==='imageTitle'&&n.type==='text'&&!out.some(image=>image.id===n.parentId&&image.type==='image')))throw Error('图片标题必须直接从属于对应图片，不能作为分组小标题');
  return out;
}
export function orderedElements(nodes,parentId=null,depth=0){return nodes.filter(n=>n.parentId===parentId).flatMap(n=>[{...n,depth},...orderedElements(nodes,n.id,depth+1)]);}
export function syncLegacy(s){
  const nodes=orderedElements(s.elements);s.title=nodes.find(n=>n.type==='text'&&n.role==='title').text;
  s.subtitle=nodes.find(n=>n.type==='text'&&n.role==='subtitle')?.text||'';
  s.body=nodes.filter(n=>n.type==='text'&&n.role==='body').slice(0,5).map(n=>n.text.slice(0,180));
  s.imageId=nodes.find(n=>n.type==='image'&&n.materialId)?.materialId||null;return s;
}
export function descendants(nodes,id){const found=new Set([id]);let count;do{count=found.size;for(const n of nodes)if(found.has(n.parentId))found.add(n.id);}while(count!==found.size);return found;}
// Move an entire branch. Stable IDs preserve image assignments and provenance.
export function moveElementBranch(nodes,id,targetId,position='inside'){
  nodes=titleRoot(structuredClone(nodes));
  if(!['before','after','inside','root'].includes(position))throw Error('无效的拖动位置');
  const source=nodes.find(n=>n.id===id),target=nodes.find(n=>n.id===targetId);
  if(!source)throw Error('拖动的节点不存在');
  const title=nodes.find(n=>n.type==='text'&&n.role==='title');
  if(source===title)throw Error('标题固定为最高顶层项，不能移动');
  if(source.type==='text'&&source.role==='subtitle')throw Error('副标题固定从属于主标题，不参与内容排序');
  if(position!=='root'&&!target)throw Error('目标节点不存在');
  const branch=descendants(nodes,id);
  if(targetId&&branch.has(targetId))throw Error('不能移入自身或自己的附属节点');
  if(target===title&&['before','after'].includes(position))throw Error('标题不能参与并列，请放在标题下方');
  if(target?.type==='text'&&target.role==='subtitle'&&['before','after'].includes(position))throw Error('副标题不参与内容并列，请放入正文分支');
  const parentId=position==='root'?title.id:position==='inside'?target.id:target.parentId;
  if(source.type==='text'&&source.role==='subtitle'&&parentId!==title.id)throw Error('副标题须保留在标题下第一层');
  const moved=orderedElements(nodes).filter(n=>branch.has(n.id)).map(({depth,...n})=>n.id===id?{...n,parentId}:n);
  const rest=orderedElements(nodes).filter(n=>!branch.has(n.id)).map(({depth,...n})=>n);
  let at=rest.length;
  if(position==='before')at=rest.findIndex(n=>n.id===targetId);
  if(position==='after'||position==='inside'){
    const targetBranch=descendants(rest,targetId);
    at=rest.reduce((last,n,i)=>targetBranch.has(n.id)?i+1:last,0);
  }
  rest.splice(at,0,...moved);
  return validateElements(rest);
}
// One horizontal gesture changes one level, moving descendants with their parent.
export function elementLevelTarget(nodes,id,direction){
  nodes=titleRoot(structuredClone(nodes));
  const source=nodes.find(n=>n.id===id);if(!source)throw Error('移动的节点不存在');
  const title=nodes.find(n=>n.type==='text'&&n.role==='title');if(source===title)throw Error('标题固定为最高顶层项，不能移动');
  if(source.type==='text'&&source.role==='subtitle')throw Error('副标题固定从属于主标题，不参与内容排序');
  let target;
  if(direction==='left'){
    if(!source.parentId||source.parentId===title.id)throw Error('已经位于标题下内容顶层');
    target={targetId:source.parentId,position:'after'};
  }else if(direction==='right'){
    const siblings=nodes.filter(n=>n.parentId===source.parentId&&!(n.type==='text'&&n.role==='subtitle')),previous=siblings[siblings.findIndex(n=>n.id===id)-1];
    if(!previous)throw Error('前方没有同级节点，无法下移一级');
    target={targetId:previous.id,position:'inside'};
  }else throw Error('无效的层级方向');
  moveElementBranch(nodes,id,target.targetId,target.position);
  return target;
}
