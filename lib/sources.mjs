import crypto from 'node:crypto';
import {materialText} from '../public/material-text-policy.js';

export const sourceSchema='sourceLinks:[{materialId:"原材料id",target:"title|subtitle|body:0|body:1|notes|element:文字或分组节点id",excerptId:"该材料证据目录中的真实编号，如E0001",quote:"从该编号片段逐字摘录最短支持句、表格单元格或公式；留空由程序回填。不要引用整段来代替具体依据",note:"说明对应的具体字段与原文信息，可留空；图片来源索引由程序自动建立"}]';
// Evidence IDs always address the original text, never the model's summary.
export function evidenceCatalog(source,maxLength=500){
  const entries=[];let start=0;
  while(start<source.length){
    let end=Math.min(start+maxLength,source.length);
    if(end<source.length){const segment=source.slice(start,end),boundary=Math.max(segment.lastIndexOf('\n'),segment.lastIndexOf('。')+1,segment.lastIndexOf('；')+1);if(boundary>maxLength/3)end=start+boundary;}
    const value=source.slice(start,end);if(value.trim())entries.push({id:'E'+String(entries.length+1).padStart(4,'0'),start,end,text:value});start=end;
  }
  return entries;
}
export function sourceEvidenceCatalog(m){
  if(m.generated||m.kind==='image'&&!m.ocrTextApprovedAt&&!m.ocr?.approvedAt)return [];
  const source=materialText(m);
  if(m.richText?.version!==1)return evidenceCatalog(source);
  const special=(m.richText.structures||[]).flatMap(s=>s.type==='table'?s.rows.flat():s.type==='formula'?[s]:[]).filter(s=>s.start>=0&&s.end<=source.length&&s.end>s.start).sort((a,b)=>a.start-b.start);
  const entries=[];let start=0;
  while(start<source.length){
    const block=special.find(s=>s.start===start),next=special.find(s=>s.start>start);
    let end=block?block.end:Math.min(start+180,next?.start??source.length,source.length);
    if(!block){const local=source.slice(start,end),cut=local.search(/[\n。；！？]|[.!?](?=\s)/);if(cut>=0)end=start+cut+1;}
    const text=source.slice(start,end);if(text.trim()&&!/^\[第 \d+ 页\]\s*$/.test(text))entries.push({id:'E'+String(entries.length+1).padStart(4,'0'),start,end,text});start=end;
  }
  return entries;
}
export function targetText(s,target){
  if(target.startsWith('element:')){const n=s.elements?.find(n=>n.id===target.slice(8));return n?(n.type==='image'?n.materialId:n.type==='group'?n.label:n.type==='text'?n.text:null):null;}
  if(['title','subtitle','notes'].includes(target))return s[target]||'';
  if(target==='image')return s.imageId||'';
  const m=/^body:(\d+)$/.exec(target);return m?s.body[Number(m[1])]??null:null;
}
export function findQuote(text,quote){
  if(!quote?.trim())return null;
  let start=text.indexOf(quote);if(start>=0)return {start,end:start+quote.length};
  const chars=[],offsets=[];for(let i=0;i<text.length;i++)if(!/\s/.test(text[i])){chars.push(text[i]);offsets.push(i);}
  const normalized=quote.replace(/\s/g,'');if(!normalized)return null;
  start=chars.join('').indexOf(normalized);return start<0?null:{start:offsets[start],end:offsets[start+normalized.length-1]+1};
}
export function bindSources(p,slides,{requireLinks=false,resolveExcerptIds=requireLinks}={}){
  const issues=[],catalogs=new Map(),bound=[];
  for(const [slideIndex,s] of slides.entries()){
    const links=s.sourceLinks||[];
    const sourceLinks=links.map((l,linkIndex)=>{
      const m=p.materials.find(m=>m.id===l.materialId);if(!m||m.generated)throw Error('对应关系只能引用实际上传的原材料');
      const value=targetText(s,l.target);if(value===null||value==='')throw Error('对应的页面内容不存在');
      let location=null,quote=l.quote;
      const mismatch=reason=>{const issue={slideIndex,linkIndex,materialId:m.id,materialName:m.name||m.id,target:l.target,quote,excerptId:l.excerptId,reason};issues.push(issue);return l;};
      const imageTarget=l.target==='image'||(l.target.startsWith('element:')&&s.elements?.find(n=>n.id===l.target.slice(8))?.type==='image');
      if(m.kind==='image'&&!((m.ocrTextApprovedAt||m.ocr?.approvedAt)&&!imageTarget)){
        if(imageTarget&&value!==m.id){const current=p.materials.find(m=>m.id===value);throw Error(`第 ${slideIndex+1} 页第 ${linkIndex+1} 条配图对应关系与当前图片不一致：${l.target} 实际使用「${current?.name||value}」，来源却指向「${m.name||m.id}」`);}
        if(!l.note)throw Error('图片来源需要填写对应说明');
      }else{
        if(imageTarget)throw Error('配图来源必须为图片材料');
        if(l.excerptId!==undefined&&!catalogs.has(m.id))catalogs.set(m.id,sourceEvidenceCatalog(m));
        const entry=catalogs.get(m.id)?.find(e=>e.id===l.excerptId);
        if(resolveExcerptIds&&l.excerptId!==undefined){
          if(!entry)return mismatch('原文片段编号不存在');
          const precise=quote&&findQuote(entry.text,quote);
          location=precise?{start:entry.start+precise.start,end:entry.start+precise.end}:{start:entry.start,end:entry.end};quote=m.text.slice(location.start,location.end);
        }else{
          if(!quote)return mismatch('文档对应关系需要填写原文摘录');
          // An unchanged numbered excerpt keeps its exact occurrence in repeated text.
          // Edited quotes must still match the original; an ID cannot override them.
          location=entry&&quote===entry.text?{start:entry.start,end:entry.end}:findQuote(m.text||'',quote);if(!location)return mismatch('摘录无法在原材料中定位，请使用原文');
          quote=m.text.slice(location.start,location.end);
        }
        const prefix=m.text.slice(0,location.start),page=[...prefix.matchAll(/\[第 (\d+) 页\]/g)].at(-1);
        location={...location,line:prefix.split('\n').length,page:page?Number(page[1]):null,columnStart:location.start-prefix.lastIndexOf('\n'),columnEnd:location.end-prefix.lastIndexOf('\n')-1};
        const structures=m.richText?.structures||[],tables=structures.filter(s=>s.type==='table'),formulas=structures.filter(s=>s.type==='formula');
        for(const [ti,table] of tables.entries())for(const [ri,row] of table.rows.entries())for(const [ci,cell] of row.entries())if(cell.start<=location.start&&cell.end>=location.end)Object.assign(location,{table:ti+1,row:ri+1,column:ci+1});
        const fi=formulas.findIndex(s=>s.start<=location.start&&s.end>=location.end);if(fi>=0)location.formula=fi+1;
      }
      return {...l,quote,id:l.id||crypto.randomUUID(),boundText:l.boundText??value,stale:l.boundText!==undefined&&l.boundText!==value,location,materialHash:m.sha256||null};
    });
    const sources=[...new Set([...(s.sources||[]),...sourceLinks.map(l=>l.materialId)])];
    if(requireLinks&&sources.some(id=>!sourceLinks.some(l=>l.materialId===id)))throw Error('模型引用了材料但未提供对应关系，请重试');
    bound.push({s,sourceLinks,sources});
  }
  if(issues.length){const first=issues[0],error=Error(`第 ${first.slideIndex+1} 页「${first.materialName}」${first.target}：${first.reason}`);error.code='SOURCE_EVIDENCE_MISMATCH';error.issues=issues;throw error;}
  for(const {s,sourceLinks,sources} of bound)Object.assign(s,{sourceLinks,sources});
}
