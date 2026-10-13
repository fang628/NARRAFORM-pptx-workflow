export const contentHierarchyRules='按真实语义主动生成多层嵌套，避免将所有正文、数据、说明和图片平铺在标题下一层。典型结构为：主标题 → 小标题/主题观点 → 论据、数据或图片 → 补充说明/图注。论据从属于其支撑的观点，细节从属于对应论据，图片从属于描述它的主题，图注是图片的直接子节点（type=text、role=caption、parentId=图片id）。同级节点才表示并列；需要独立小标题时使用 group，其 label 就是准确上屏文案。一般内容页按语义组织 2–4 层，标题下最多 5 层、整页最多 40 项；封面、目录或简单内容可保持浅层，不为凑层级创建空分组、重复标题或虚构信息。示例关系：title → findings(group) → finding(text) → evidence(image) → caption(text)。层级表达内容归属，不强制 PPT 采用树形视觉。';
export const elementSchema='elements:[{id:"节点id",type:"text|image|group",role:"title|subtitle|body|caption",label:"元素名称",text:"文字",materialId:"图片材料id或null",parentId:"上级节点id或null",layout:"stack|row"}]。主标题恒为唯一根项；可选副标题至多一个，直接从属于主标题，作为标题附文，不参与正文和图片的并列排列。'+contentHierarchyRules;

// A caption is a normal editable text node: all design, provenance and export paths share it.
export function setImageCaption(nodes,imageId,captionId,value){
  const image=nodes.find(n=>n.id===imageId&&n.type==='image');if(!image)throw Error('图片字段不存在');
  const text=String(value||'').trim(),requested=nodes.find(n=>n.id===captionId);
  if(requested&&!(requested.type==='text'&&requested.role==='caption'&&requested.parentId===imageId))throw Error('图注字段已变化，请重新打开页面');
  const caption=requested||nodes.find(n=>n.type==='text'&&n.role==='caption'&&n.parentId===imageId),id=caption?.id||captionId;
  if(text.length>600)throw Error('图注最多 600 字');
  if(!text)return nodes.filter(n=>n.id!==id).map(n=>n.parentId===id?{...n,parentId:imageId}:n);
  if(caption)return nodes.map(n=>n.id===id?{...n,text}:n);
  if(nodes.length>=40)throw Error('每页最多 40 个元素，请先移除一个字段再添加图注');
  return [...nodes,{id:captionId,type:'text',role:'caption',label:'图注',text,parentId:imageId,layout:'stack',materialId:null}];
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
    return {id:n.id,type:n.type,role:['title','subtitle','body','caption'].includes(n.role)?n.role:'body',label:n.type==='group'?text:String(n.label||'元素').slice(0,80),text,materialId:n.materialId?String(n.materialId):null,parentId:n.parentId?String(n.parentId):null,layout:n.layout==='row'?'row':'stack',color:/^[\da-f]{6}$/i.test(n.color)?n.color:'FFF238'};
  });
  if(out.filter(n=>n.role==='title'&&n.type==='text').length!==1)throw Error('每页需要且仅需要一个标题元素');
  if(out.filter(n=>n.role==='subtitle'&&n.type==='text').length>1)throw Error('每页至多一个副标题');
  const title=out.find(n=>n.type==='text'&&n.role==='title');if(title.parentId)throw Error('页面标题必须固定为最高顶层项');out=titleRoot(out);
  for(const n of out){const seen=new Set([n.id]);let parent=n.parentId,depth=0;while(parent){if(!ids.has(parent))throw Error('上级元素不存在');if(seen.has(parent))throw Error('元素关系不能形成循环');seen.add(parent);parent=out.find(x=>x.id===parent).parentId;if(++depth>5)throw Error('标题下内容关系最多 5 层');}if(n.role==='subtitle'&&n.type==='text'&&n.parentId!==title.id)throw Error('副标题须位于标题下的第一层');}
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
