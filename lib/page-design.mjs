import {registeredStyleContext} from './style-registry.mjs';
import {contentCheckState,contentLayoutAdvice} from './content-check.mjs';
import {runConcurrent,concurrencyLimit} from './concurrency.mjs';
import {designPolicyVersion,designRulesFor,navigationTexts,pageNeedsImage} from './design-rules.mjs';
import crypto from 'node:crypto';
import {initialElements,orderedElements,headingBodyAlignmentRule} from './elements.mjs';
import {chat,parseJSON} from './provider.mjs';
import {workflowPageContext,workflowStyleContext,workflowLibraryVersion} from './workflow-library.mjs';
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const md=v=>String(v??'').replace(/[\\`*_{}\[\]<>|]/g,'\\$&').replace(/\r?\n/g,' / ');
export function pageDesignStamp(p,index){
  const s=p.slides[index];if(!s)return null;
  const ids=new Set([...s.sources,...initialElements(s).filter(n=>n.materialId).map(n=>n.materialId)]);
  return hash({designPolicyVersion,workflowLibraryVersion,navigation:navigationTexts(p,index),progressPlacement:p.brief.progress!==false?'top':null,slide:s.elements?{...s,elements:initialElements(s)}:s,brief:p.brief,materials:p.materials.filter(m=>ids.has(m.id)).map(m=>({id:m.id,sha256:m.sha256,ocrText:(m.ocrTextApprovedAt||m.ocr?.approvedAt)?m.text:undefined,prompt:m.prompt}))});
}
export function pageDesignInputCheck(p,index){
  const nodes=initialElements(p.slides[index]),images=nodes.filter(n=>n.type==='image'),warnings=[...(contentCheckState(p,index)?.warnings||[])];
  for(const n of images){if(!n.materialId)warnings.push(`「${n.label}」尚未指定图片素材，请在内容树补充或删除该字段`);else if(!nodes.some(c=>c.parentId===n.id&&c.type==='text'&&c.role==='caption'&&c.text?.trim()))warnings.push(`「${n.label}」缺少图注，请在内容树补充；封面或目录若不适用可保留为空。缺图注不作为新增装饰问题在生图时否决。`);}
  if(pageNeedsImage(p,index)&&!['cover','toc'].includes(p.slides[index].kind)&&!images.some(n=>n.materialId))warnings.push('本页尚无登记配图，请在设计稿中说明主题示意的生成意图；事实图须由用户提供');
  return {stage:'page-design',warnings,visualChecks:'实际装饰、可读性与原图完整性在视觉方案/完整预览生成结束时看图检查，不在下一步重新发起'};
}
export function pageDesignState(p,index){const d=p.pageDesigns?.[index],stamp=pageDesignStamp(p,index);return d?{...d,inputCheck:pageDesignInputCheck(p,index),layoutCurrent:d.layoutStamp===stamp&&!!d.layoutApprovedAt,current:d.draftStamp===stamp,approvedCurrent:d.draftStamp===stamp&&!!d.approvedAt}:null;}
const required=(v,label,max=1500)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('设计稿的'+label+'无效');return v.trim();};
export function validatePageDesign(raw,nodes){
  const ids=nodes.map(n=>n.id),complete=list=>Array.isArray(list)&&list.length===ids.length&&new Set(list).size===ids.length&&list.every(id=>ids.includes(id));
  if(!raw||!complete(raw.nodes?.map(n=>n.id))||!complete(raw.readingOrder))throw Error('设计稿必须逐一覆盖全部节点，不能改写内容树');
  const order=orderedElements(nodes).map(n=>n.id);if(raw.readingOrder.some((id,i)=>id!==order[i]))throw Error('设计稿阅读顺序必须保留已确认内容树的顺序');
  const out={};for(const key of ['purpose','conclusion','logic','layoutIntent','style','differences'])out[key]=required(raw[key],key,2500);
  out.readingOrder=raw.readingOrder;
  out.nodes=raw.nodes.map(n=>{const next={id:n.id};for(const k of ['position','relativeSize','alignment','carrier','relation'])next[k]=required(n[k],k,800);return next;});
  if(!Array.isArray(raw.missingMaterials)||raw.missingMaterials.length>20)throw Error('设计稿缺少材料缺口清单');
  out.missingMaterials=raw.missingMaterials.map(v=>required(v,'待补充材料',500));return out;
}
export function pageDesignPrompt(p,index,{instruction='',markdown=''}={}){const s=p.slides[index],nodes=orderedElements(initialElements(s));return `按照 pptx-workflow 1.3 的单页设计稿结构设计这一页。为当前 AI 初稿或用户修改后的内容树生成设计方案，不改写文案、分组名、素材身份、节点层级或顺序。主标题是唯一根项；副标题从属于主标题，是标题附文，不能与正文或图片参与并列分组。readingOrder 必须逐字使用下方“已有节点”给出的 id 顺序，它已按内容树排好。分组名就是必须上屏的小标题，不能当作内部容器名。${headingBodyAlignmentRule} 在小标题及其正文的 alignment、position 中明确共同对齐轴或顶端基准，沿用已有多层归属，不把多段正文合并。不要写精确坐标或像素框，只写大致方位、相对大小、对齐、承载方式和真实内容关系。layoutIntent与logic各用1–2句，节点position/relativeSize/alignment用短语，relation只写无法由树层级直接表达的真实并列、支撑或连接关系，不重复父项全文和通用规范；共同框形、配色、字体与装饰集中写在style，不在每个节点重复。按内容和受众选风格，不把网页 UI 的电路装饰直接套在所有 PPT。准确文字保持原生可编辑，事实图片用登记原件，不生成替代证据。版式要有创意，探索适合本页逻辑的特殊分块，以及弧形、扇形、斜切、阶梯或其他异形文本框与色块。特殊承载写入对应节点carrier，说明与分区的衔接，给轮廓细节保留发挥空间，不以重复圆角卡片替代设计。每页一个主观点；封面/标题页和目录页默认无配图，不要求补图；其他页面有缺图或图注应列出缺口，不编造。不得生成图片。
${instruction?`根据用户意见修订下方上一版设计稿，返回完整的新设计方案，不只回复建议或差异。优先调整用户指定的布局、层次、风格与图片意图，其余合理设计保留。上一版若已过期，内容以当前已有节点为准。若意见涉及改写文字、增删素材或改变内容归属，只在 missingMaterials 说明需回到内容树修改，不擅自变更节点。
用户修改意见：${JSON.stringify(instruction)}
上一版设计稿：${JSON.stringify(markdown)}
`:''}
输出 {purpose:"页面任务",conclusion:"已有文案表达的核心结论",logic:"承接与阅读逻辑",layoutIntent:"页面分块、区域关系和选择依据",style:"页面可用配色（不为各文字指定颜色）、背景、按文字角色的参考字号pt、框形与装饰密度",readingOrder:["全部节点id，恰好每个一次"],nodes:[{id:"原节点id",position:"大致位置",relativeSize:"相对大小",alignment:"对齐",carrier:"无框或内容承载方式",relation:"与其他节点的并列/附属及阅读关系"}],differences:"本页视觉差异与特殊说明",missingMaterials:["待补充材料，无则空数组"]}。
需求：${JSON.stringify(p.brief)}
前页标题：${p.slides[index-1]?.title||'无'}；后页标题：${p.slides[index+1]?.title||'无'}
本页：${JSON.stringify(s)}
${contentLayoutAdvice(p,index)}
已有节点：${JSON.stringify(nodes)}
使用的材料：${JSON.stringify(p.materials.filter(m=>s.sources.includes(m.id)||nodes.some(n=>n.materialId===m.id)).map(m=>({id:m.id,name:m.name,kind:m.kind,generated:!!m.generated,prompt:m.prompt,text:m.text?.slice(0,4000)})))}\n${designRulesFor(p,index)}\n${workflowPageContext(p,index)}\n${workflowStyleContext()}\n${registeredStyleContext(p)}`;}
export function canonicalDesignTree(p,index,plan){
  const nodes=initialElements(p.slides[index]);
  return ['<!-- CONFIRMED-CONTENT:START -->',...orderedElements(nodes).flatMap(n=>{
    const spec=plan.nodes.find(o=>o.id===n.id),pad='  '.repeat(n.depth),role=n.type==='group'?'小标题':n.type==='text'?{title:'标题',subtitle:'副标题',body:'正文',caption:'图注'}[n.role]:n.type==='image'?'图片':'原生图形';
    const m=p.materials.find(m=>m.id===n.materialId),content=n.type==='group'?n.label:n.type==='text'?n.text:n.type==='image'?m?.name||'尚未指定素材':'矩形色块';
    return [`${pad}- ${md(n.id)} · ${role}：**${md(content)}**`,`${pad}  - 位置：${md(spec.position)}；相对大小：${md(spec.relativeSize)}；对齐：${md(spec.alignment)}`,`${pad}  - 承载：${md(spec.carrier)}；关系：${md(n.type==='text'&&n.role==='title'?'固定最高根项，统领本页内容，不参与并列':n.type==='text'&&n.role==='subtitle'?'从属于主标题的附文，不参与正文和图片的并列排列':spec.relation)}；子项${n.layout==='row'?'横向并列':'纵向排列'}`];
  }),'<!-- CONFIRMED-CONTENT:END -->'].join('\n');
}
export function renderPageDesign(p,index,plan){
  const s=p.slides[index],nodes=initialElements(s),images=nodes.filter(n=>n.type==='image'),name='S'+String(index+1).padStart(2,'0');
  const imageLines=images.flatMap(n=>{const m=p.materials.find(m=>m.id===n.materialId),spec=plan.nodes.find(o=>o.id===n.id),caption=nodes.filter(c=>c.parentId===n.id&&c.type==='text'&&c.role==='caption').map(c=>c.text).join('；');return [`- ${md(n.id)}：${md(m?.name||'待补充图片')} / 材料 ${md(m?.id||'未指定')}`,`  - 用途与放置：${md(spec.position)}；${md(spec.relation)}；${md(spec.relativeSize)}`,`  - 适配：完整保留关键信息，默认 contain；图注：${md(caption||'待在内容树中补充或确认不适用')}`,`  - 事实边界：${m?.generated?'AI 生成示意，不代表真实事件、人物或数据；提示词：'+md(m.prompt):'使用登记原件，不用 AI 重画事实证据'}`];});
  return `# ${name} 单页设计稿 · ${md(s.title)}

## 设计状态
- 内容树与设计稿：AI 初稿 / 用户修改稿，待用户复核；只有用户确认的页面可生成视觉方案
- 页面比例：16:9；后续整页生图：16:9，优先 1920×1080，接受较小的同等比例图片；本地展示统一为 1920×1080
- 本稿规划版式意图，不改变已确认的最终文案与素材

## 1. 页面信息
- 页码：${name} / ${p.slides.length}；页型：${s.kind}
- 受众：${md(p.brief.audience||'通用受众')}；用途：${md(p.brief.purpose||'演示汇报')}
- 标题页：${p.brief.cover!==false?'启用':'关闭'}；目录：${p.brief.toc?'启用':'关闭'}；致谢：${p.brief.thanks?'启用':'关闭'}；演讲稿：${p.brief.speaker?'启用':'关闭'}；页顶进度条：${p.brief.progress!==false?'启用':'关闭'}

## 2. 页面目的与阅读逻辑
- 页面任务：${md(plan.purpose)}
- 核心结论：${md(plan.conclusion)}
- 承接与逻辑：${md(plan.logic)}
- 阅读顺序：${plan.readingOrder.map(md).join(' → ')}
- 分块依据：${md(plan.layoutIntent)}

## 风格与文本承载要求
${md(plan.style)}
准确文字、分组小标题与简单图形原生可编辑；同级语义保持一致层次，先精简内容再缩小字号。
${headingBodyAlignmentRule}

## 3. 嵌套排版树
${canonicalDesignTree(p,index,plan)}

## 4. 本页视觉差异与特殊说明
${md(plan.differences)}

## 图片意图与素材保真边界
${imageLines.join('\n')||(pageNeedsImage(p,index)?'- 本页尚无图片；按内容需要补充合适的主视觉、主题图或示意图，事实图片须由用户提供。':'- 本页默认无配图，采用文字、留白与必要的几何版式；不要求补图。')}

## 原材料对应索引
${(s.sourceLinks||[]).map(l=>`- ${md(l.target)} → ${md(p.materials.find(m=>m.id===l.materialId)?.name||l.materialId)} / ${md(l.materialId)}${l.location?.page?' / 第 '+l.location.page+' 页':''}${l.location?.line?' / 第 '+l.location.line+' 行':''}；${md(l.note)}`).join('\n')||'- 用户自拟内容；尚无材料对应。'}

## 顶部进度条要求
${navigationTexts(p,index).length?'页面顶部使用以下原名，突出当前项：'+navigationTexts(p,index).map(n=>md(n.text)+(n.current?'（当前）':'')).join(' / ')+'。封面和目录不显示，不放在页底。':'本页不显示进度条。'}

## 待补充材料
${plan.missingMaterials.map(v=>'- '+md(v)).join('\n')||(pageNeedsImage(p,index)?'- 无额外缺口；请核对图片与图注是否完整。':'- 本页默认无配图，无额外材料缺口。')}

## 本步结束检查
${pageDesignInputCheck(p,index).warnings.map(v=>'- '+md(v)).join('\n')||'- 本页图注与素材登记无新增缺口。'}
- 原图自带底色、边框与图例按原件保留，不视为新增装饰。实际画面规范在生图阶段结束时检查并显示于该阶段。
`;
}
// Initial AI drafts never count as user approval. Commit each completed page so retries keep good drafts.
export async function draftPageDesigns(p,env,signal,{all=false}={}){
  const cfg=env.credentials.get(p.id)?.text;env.ensure(p,!!cfg?.key,'请先配置文字 API');p.pageDesigns||={};
  const report={completed:[],failed:[],at:new Date().toISOString()};
  const indices=p.slides.map((_,i)=>i).filter(i=>all||!pageDesignState(p,i)?.current);
  await runConcurrent(indices,async index=>{
    if(signal.aborted)throw Error('任务已取消');p.task.message=`AI 初次设计 ${index+1} / ${p.slides.length} · ${p.slides[index].title}`;env.save(p);
    try{
      const stamp=pageDesignStamp(p,index),r=await chat(cfg,env.system,pageDesignPrompt(p,index),signal),plan=validatePageDesign(parseJSON(r.text),initialElements(p.slides[index]));
      if(signal.aborted)throw Error('任务已取消');env.ensure(p,pageDesignStamp(p,index)===stamp,'本页内容已变化');
      p.pageDesigns[index]={layoutStamp:stamp,layoutApprovedAt:null,draftStamp:stamp,plan,markdown:renderPageDesign(p,index,plan),generatedAt:new Date().toISOString(),approvedAt:null,model:cfg.model,origin:'ai-initial'};p.lastUsage=r.usage;report.completed.push(index);env.save(p);
    }catch(e){if(signal.aborted)throw e;report.failed.push({index,message:String(e.message).slice(0,300)});throw e;}
  },{signal,limit:concurrencyLimit(p.executionConcurrency),label:index=>'单页设计 · 第 '+(index+1)+' 页',settle:true});
  report.completed.sort((a,b)=>a-b);report.failed.sort((a,b)=>a.index-b.index);
  p.initialDesign=report;p.task.completionMessage=report.failed.length?`内容已保存；${report.failed.length} 页设计稿未完成，可点击“补齐 AI 设计稿”重试`:'AI 文案、内容树与单页设计稿已完成，请修改或确认';env.save(p);
}
export function checkDesignEdits(markdown,p,index,plan){
  if(typeof markdown!=='string'||!markdown.trim()||markdown.length>80000)throw Error('设计稿须为 1–80,000 字');
  const start='<!-- CONFIRMED-CONTENT:START -->',end='<!-- CONFIRMED-CONTENT:END -->',a=markdown.indexOf(start),b=markdown.indexOf(end);
  if(a<0||b<a||markdown.slice(a,b+end.length)!==canonicalDesignTree(p,index,plan))throw Error('准确文案和排版树请回到内容树修改，再确认并重新生成；可直接编辑其余设计说明');
  return markdown;
}
