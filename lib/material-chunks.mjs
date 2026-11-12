import crypto from 'node:crypto';
import {runConcurrent} from './concurrency.mjs';
import {readMaterialWithEvidence} from './material-reading.mjs';
import {sourceEvidenceCatalog} from './sources.mjs';
import {materialText,materialTextLimit} from '../public/material-text-policy.js';
import {reportTask} from './task-progress.mjs';

const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const materialChunkVersion=1;

export function materialChunks(material,{maxChars=18000,maxPromptChars=materialTextLimit}={}){
  const source=materialText(material),catalog=sourceEvidenceCatalog(material),chunks=[];
  const markers=[...source.matchAll(/\[第 (\d+) 页\]|\[ppt\/slides\/slide(\d+)\.xml\]/g)];
  const locate=offset=>Number(markers.findLast(m=>m.index<=offset)?.slice(1).find(Boolean))||null;
  let selected=[],cost=0,chars=0;
  const flush=()=>{
    if(!selected.length)return;
    const start=selected[0].start,end=selected.at(-1).end;
    const pageNumbers=[...new Set(selected.map(e=>locate(e.start)).filter(Boolean))];
    chunks.push({id:'C'+String(chunks.length+1).padStart(4,'0'),start,end,pageStart:pageNumbers.length?Math.min(...pageNumbers):null,
      pageEnd:pageNumbers.length?Math.max(...pageNumbers):null,pageNumbers,catalog:selected});
    selected=[];cost=0;chars=0;
  };
  for(const entry of catalog){
    const size=JSON.stringify(entry).length;
    if(selected.length&&(chars+entry.text.length>maxChars||cost+size>maxPromptChars*.65))flush();
    // Respect page/chapter boundaries when a block has enough substance.
    if(selected.length&&chars>maxChars*.55&&/^\s*(?:\[第 \d+ 页\]|\[ppt\/slides\/slide\d+\.xml\]|#{1,3} |\d+(?:\.\d+)*\s+[A-Z\u4e00-\u9fff])/.test(entry.text))flush();
    selected.push(entry);cost+=size;chars+=entry.text.length;
  }
  flush();return chunks;
}

export async function readMaterialChunks({material,config,system,signal,buildUser,save=()=>{},limit,call}){
  const source=materialText(material),chunks=materialChunks(material);
  if(!chunks.length)throw Error('材料没有可读取正文');
  const users=new Map(chunks.map(c=>[c.id,buildUser(c.catalog,c)]));
  for(const user of users.values())if(typeof user==='string'&&user.length>materialTextLimit)throw Error('分块提示超过单次读取预算，已保留原文；请缩短补充提示或拆分过密表格');
  const stamp=hash([materialChunkVersion,source,config?.baseURL,config?.model,system,chunks.map(c=>[c.start,c.end,hash(users.get(c.id))])]);
  let state=material.readingChunks;
  if(state?.stamp!==stamp)state=material.readingChunks={version:materialChunkVersion,stamp,blocks:{}};
  const results=await runConcurrent(chunks,async chunk=>{
    signal?.throwIfAborted();
    const prior=state.blocks[chunk.id];if(prior?.status==='read')return prior.reading;
    reportTask(signal,{kind:'step',message:`理解 ${material.name} · 分块 ${chunk.id} / ${chunks.length}${chunk.pageStart?' · 第 '+chunk.pageStart+'–'+chunk.pageEnd+' 页':''}`});
    const result=await readMaterialWithEvidence({material,config,system,signal,call,examinedText:source,catalog:chunk.catalog,user:users.get(chunk.id)});
    const facts=result.reading.informationIndex.blocks.flatMap(b=>b.facts);
    if(facts.some(f=>f.location&&!chunk.catalog.some(e=>f.location.start>=e.start&&f.location.end<=e.end)))throw Error('分块事实引用越出当前证据范围，已保留其他有效块');
    signal?.throwIfAborted();state.blocks[chunk.id]={status:'read',reading:result.reading,usage:result.usage};save();return result.reading;
  },{signal,limit:limit||1,settle:true,label:chunk=>material.name+' · '+chunk.id});
  const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  const readings=results.map(r=>r.value),blocks=readings.map((r,i)=>({...r.informationIndex.blocks[0],
    id:chunks[i].id,start:chunks[i].start,end:chunks[i].end,pageStart:chunks[i].pageStart,pageEnd:chunks[i].pageEnd,
    excerptIds:chunks[i].catalog.map(e=>e.id)}));
  const keyPoints=blocks.flatMap(b=>b.keyPoints),facts=blocks.flatMap(b=>b.facts),questions=blocks.flatMap(b=>b.questions);
  const tables=blocks.flatMap(b=>b.tables),formulas=blocks.flatMap(b=>b.formulas);
  const usedRanges=chunks.map(({id,start,end,pageStart,pageEnd})=>({id,start,end,pageStart,pageEnd}));
  const incomplete=String(material.text||'').length>source.length||material.truncated||material.needsOCR||material.documentVisual?.partial||material.documentVisual?.pages?.some(p=>p.status!=='done'||['uncertain','unavailable'].includes(p.transcript?.status));
  const reading={...readings[0],summary:blocks.map(b=>b.summary).join('\n').slice(0,1500),keyPoints:keyPoints.slice(0,12),facts:facts.slice(0,12),questions:questions.slice(0,12),tables,formulas,
    informationIndex:{version:1,blocks,coverage:{characters:source.length,totalCharacters:String(material.text||'').length,ranges:usedRanges,complete:!incomplete,
      excludedReason:incomplete?'原文件读取上限、页面失败或OCR不确定部分待补齐':null}},
    readChars:source.length,totalChars:source.length,partial:!!incomplete,...(material.textRecovery?{sourceRecoveryHash:material.textRecovery.hash}:{})};
  const usage={};for(const block of Object.values(state.blocks))for(const [key,value]of Object.entries(block.usage||{}))if(typeof value==='number')usage[key]=(usage[key]||0)+value;
  return {reading,usage};
}

// Presentation summaries stay short; semantic consumers receive every block's
// information, not only the twelve items selected for the report card.
export function readingForModel(reading){
  if(!reading.informationIndex)return reading;
  const {informationIndex,keyPoints,facts,tables,formulas,...rest}=reading;
  return {...rest,informationIndex:{version:informationIndex.version,coverage:informationIndex.coverage,
    blocks:informationIndex.blocks.map(b=>({id:b.id,pageStart:b.pageStart,pageEnd:b.pageEnd,summary:b.summary,keyPoints:b.keyPoints,
      facts:b.facts,tables:b.tables,formulas:b.formulas,questions:b.questions,suggestedUse:b.suggestedUse}))}};
}

export function readingIndexOverview(reading){
  if(!reading.informationIndex)return reading;
  const {informationIndex,...rest}=reading;
  return {...rest,informationIndex:{version:1,coverage:informationIndex.coverage,blocks:informationIndex.blocks.map(b=>({id:b.id,
    pageStart:b.pageStart,pageEnd:b.pageEnd,summary:b.summary,topics:b.keyPoints,questions:b.questions,
    evidence:b.facts.map(({claim,excerptId})=>({claim,excerptId})),tableTopics:b.tables.map(t=>({tableId:t.tableId,headers:t.headers,suggestedUse:t.suggestedUse})),
    formulaTopics:b.formulas.map(f=>({formulaId:f.formulaId,meaning:f.meaning,suggestedUse:f.suggestedUse}))}))}};
}

export function publicMaterialRecord(material){
  const {readingChunks,textRecovery,...record}=material;
  return {...record,...(textRecovery?{textRecovery:{version:textRecovery.version,hash:textRecovery.hash,sourceHash:textRecovery.sourceHash,nativeTextEnd:textRecovery.nativeTextEnd,pages:textRecovery.pages}}:{})};
}
