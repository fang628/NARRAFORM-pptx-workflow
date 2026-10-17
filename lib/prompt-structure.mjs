import {imageCaptionRule} from './image-caption-rules.mjs';
import {roughLayoutImageGuidance} from './layout-guidance.mjs';
const singleLine=v=>String(v??'').replace(/\r?\n/g,' / ');
export const nestedPromptStructureRule='内容要求和排版要求均用多层 Markdown 列表表达真实结构：子项缩进表示从属，同一父项下的同级正文表示并列；主标题是唯一最高项，副标题为其标题附文，不参与正文并列；图片标题或图注二选一，仅一项嵌套为对应图片的子项；图片标题不作为分组小标题，图注不限定画面上下位置。按已有顺序保留全部层级，不展开成单层列表；列表层级表达内容关系，不要求画成树形图。同级观点优先并列组合，各段与各分点独立排布，不合入同一文本框；不强制所有并列项都排成单一横行，真实附属关系保留。'+imageCaptionRule;
export const slidePromptConcisenessRule='页顶导航文案与进度条样式只写在进度条要求中，内容列表不再列导航。平坦无字占位、本地贴回原图及图片数量集中在配图要求中各写一次；逐图只列名称、位置、具体宽高比、占位框像素尺寸及图注空间，不再重复占位块通用要求。仅具体宽高比按要求在内容、排版与配图项重复强调，不删除不同内容节点的相同文案。内容列表已表达分组归属，排版项不逐组重复“与所属内容共同成组”“沿用预设承载”等空泛说明，只保留有实际布局信息的补充。';

// The content tree, rather than free-form layout prose, owns parentage and order.
export function nestedContentList(nodes,navigation=[]){
  const labels={title:'标题',subtitle:'副标题',caption:'图注',imageTitle:'图片标题',body:'正文'};
  const walk=(parentId,depth)=>nodes.filter(n=>n.parentId===parentId).flatMap(n=>{
    const label=n.type==='group'?'小标题':n.type==='image'?'图片':n.type==='text'?labels[n.role]||'正文':'图形';
    const value=n.type==='text'?n.text:n.label;
    return [`${'  '.repeat(depth+1)}- ${label}：${singleLine(value)}`,...walk(n.id,depth+1)];
  });
  const lines=walk(null,0);
  if(navigation.length)lines.push('  - 页顶导航（独立于正文结构）：',...navigation.map(n=>'    - 页顶导航：'+singleLine(n.text)));
  return lines.join('\n');
}

// Clean known generated scaffolding only; repeated source text and image ratios are intentional.
export function deduplicateSlidePrompt(brief){
  // Only remove known generated scaffolding outside the verbatim content list.
  // Repeated source nodes, labels and cross-section image ratios are deliberate.
  const boilerplate=[roughLayoutImageGuidance,roughLayoutImageGuidance.replace(/^创意设计：/,''),
    '实际排版要有创意，保留合理的组合与局部构图发挥空间。',
    '适合内容时积极采用有表达作用的特殊分块；具体形状、装饰与局部组合交给生图AI，不改变内容关系或挤压文字。',
    '创意设计：适合内容时积极采用有表达作用的特殊分块、异形文本框或色块，以疏密、尺度和错落组合建立视觉重点；具体形状、装饰与局部组合交给生图AI，不改变内容关系或挤压文字。',
    '创意排版，特殊分块与弧形、扇形、斜切、阶梯等异形承载可结合内容自由组合。'];
  let content=false;
  brief=brief.split('\n').map(row=>{
    const header=row.match(/^- \*\*([^*]+)\*\*：/);if(header)content=header[1]==='内容要求';
    if(content)return row;
    for(const text of boilerplate)row=row.replaceAll(text,'');
    return row.replace(/(?:实际)?比例误差(?:不超过\s*2[%％]|控制在\s*2[%％]以内)[，,。]?/g,'');
  }).filter(row=>!/^\s*-\s*$/.test(row)).join('\n');
  const section=name=>{
    const headers=[...brief.matchAll(/^- \*\*([^*]+)\*\*：/gm)],at=headers.findIndex(h=>h[1]===name);
    if(at<0)return null;
    return {start:headers[at].index,end:headers[at+1]?.index??brief.length};
  };
  const replaceSection=(name,transform)=>{
    const range=section(name);if(!range)return;
    brief=brief.slice(0,range.start)+transform(brief.slice(range.start,range.end))+brief.slice(range.end);
  };
  replaceSection('排版要求',part=>part.split('\n').filter(row=>
    !/^\s+- [“"「][^”"」]+[”"」][:：]\s*与所属内容共同成组(?:[，,；;]\s*沿用预设承载)?[。.]?\s*$/.test(row)
  ).join('\n'));
  const progress=section('进度条要求'),progressText=progress?brief.slice(progress.start,progress.end):'';
  replaceSection('内容要求',part=>part.replace(/^  - 页顶导航（独立于正文结构）：\r?\n(?:    - 页顶导航：[^\r\n]*(?:\r?\n|$))+/gm,block=>{
    const names=[...block.matchAll(/^    - 页顶导航：(.+)$/gm)].map(m=>m[1].trim());
    return names.length&&names.every(name=>progressText.includes(name))?'':block;
  }));
  for(const name of ['图片占位框比例','底图与配图要求'])replaceSection(name,part=>{
    if(!part.includes('每张登记原图仅画一个等比、平坦无字占位块'))return part;
    return part.split('\n').map(row=>/^  - “[^”]+”：/.test(row)?row.replaceAll('，平坦无字占位块',''):row).join('\n');
  });
  for(const name of ['进度条要求','图片占位框比例','底图与配图要求'])replaceSection(name,part=>{
    const seen=new Set();
    return part.split('\n').filter(row=>{
      const text=row.replace(/^- \*\*[^*]+\*\*：|^\s*-\s*/,'').trim();
      if(!/^(?:页顶且仅一条粗分段进度条|无进度条。|每张登记原图仅画一个等比、平坦无字占位块|图片占位框与登记图片一一对应|本页没有登记图片，不画任何图片占位框)/.test(text))return true;
      if(seen.has(text))return false;seen.add(text);return true;
    }).join('\n');
  });
  for(const name of ['排版要求','风格要求'])replaceSection(name,part=>{
    const seen=new Set();
    return part.split('\n').map(row=>{
      if(!row.trim())return row;
      // Compare complete instructions, not clauses within field names or ratios.
      // Leave nested node-specific rows intact even when positions are identical.
      if(/^\s+- [“"「]/.test(row))return row;
      const prefix=row.match(/^- \*\*[^*]+\*\*：|^\s*-\s*/)?.[0]||'';
      const prose=row.slice(prefix.length);
      const clauses=prose.match(/[^。！？]+[。！？]?/g)||[];
      return prefix+clauses.filter(clause=>{
        const key=clause.trim();if(!key)return false;
        if(key.length<8||/\d+(?:\.\d+)?:1/.test(key))return true;
        if(seen.has(key))return false;seen.add(key);return true;
      }).join('');
    }).filter(row=>!/^\s*-\s*$/.test(row)).join('\n');
  });
  return brief;
}
