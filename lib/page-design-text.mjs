import {isDeepStrictEqual} from 'node:util';
import {initialElements} from './elements.mjs';
import {pageDesignStamp,pageDesignInputStamp,pageDesignInputsCurrent,canonicalDesignTree} from './page-design.mjs';

// Only existing text may change. Node identity, hierarchy, images and table dimensions stay fixed.
function structure(slide){
 const {title,subtitle,body,notes,elements,...rest}=slide;
 return {...rest,elements:initialElements(slide).map(node=>{
  const next=structuredClone(node);
  if(node.type==='text')delete next.text;
  if(node.type==='group')delete next.label;
  if(node.type==='table'){next.headers=node.headers?.map(()=>null);next.rows=node.rows?.map(row=>row.map(()=>null));}
  return next;
 })};
}
const md=v=>String(v??'').replace(/[\\`*_{}\[\]<>|]/g,'\\$&').replace(/\r?\n/g,' / ');
export function syncPageDesignText(p,index,before){
 const d=p.pageDesigns?.[index],slide=p.slides[index];
 if(!d?.plan||!d.markdown)throw Error('本页尚无可同步的设计稿');
 const candidates=[d.contentSnapshot,before,p.reuseCheckpoint?.source.slides?.[index]].filter(Boolean);
 const baseline=candidates.find(slide=>pageDesignInputsCurrent({...p,slides:p.slides.map((s,i)=>i===index?slide:s)},index,d));
 if(!baseline)throw Error('设计依据或素材已变化，无法仅同步文案，请重新生成设计稿');
 if(!isDeepStrictEqual(structure(baseline),structure(slide)))throw Error('本页节点、层级或素材已变化，请重新生成设计稿；仅修改已有文案时可直接同步');
 const baselineProject={...p,slides:p.slides.map((s,i)=>i===index?baseline:s)};
 if(!pageDesignInputsCurrent(baselineProject,index,d))throw Error('设计依据或素材已变化，无法仅同步文案，请重新生成设计稿');
 const old=initialElements(baseline),current=initialElements(slide),pairs=[];
 for(const n of old){const next=current.find(v=>v.id===n.id);if(!next)continue;
  const a=n.type==='group'?n.label:n.type==='text'?n.text:undefined,b=n.type==='group'?next.label:n.type==='text'?next.text:undefined;
  if(a&&a!==b)pairs.push([md(a),md(b)],[String(a),String(b)]);
 }
 const map=new Map(pairs),keys=[...map.keys()].sort((a,b)=>b.length-a.length);
 const escaped=keys.map(v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const regex=keys.length?new RegExp(escaped.join('|'),'g'):null;
 const replace=s=>typeof s==='string'&&regex?s.replace(regex,v=>map.get(v)):s;
 const walk=v=>Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,value])=>[k,k==='id'||k==='readingOrder'?value:walk(value)])):replace(v);
 const plan=walk(d.plan),stamp=pageDesignStamp(p,index),at=new Date().toISOString();
 const markdown=replace(d.markdown).replace(/<!-- CONFIRMED-CONTENT:START -->[\s\S]*?<!-- CONFIRMED-CONTENT:END -->/,()=>canonicalDesignTree(p,index,plan));
 p.pageDesigns[index]={...d,contentInputStamp:pageDesignInputStamp(p,index),plan,markdown,draftStamp:stamp,layoutStamp:stamp,approvedAt:null,textSyncedAt:at,contentSnapshot:structuredClone(slide)};
 return p.pageDesigns[index];
}
