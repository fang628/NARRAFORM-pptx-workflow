import {sourceEvidenceCatalog} from './sources.mjs';
import {sourceTableCatalog} from './table-content.js';
import {sourceFormulaCatalog} from './formula-content.mjs';

// A request-only view: retain source offsets/IDs and complete structures, never edit the source.
export function scopeMaterialEvidence(material,blocks){
  if(!blocks?.length)return material;
  const catalog=sourceEvidenceCatalog(material),selected=new Set(blocks.flatMap(b=>b.excerptIds||[]));
  if(!selected.size)return material; // Older indexes without excerpt membership retain full evidence.
  if([...selected].some(id=>!catalog.some(e=>e.id===id)))return material;
  const original=new Set(selected);
  for(let i=0;i<catalog.length;i++)if(original.has(catalog[i].id)){
    if(i>0)selected.add(catalog[i-1].id);
    if(i+1<catalog.length)selected.add(catalog[i+1].id);
  }
  // Tables/formulas crossing a selected range are indivisible evidence units.
  let changed;
  do{
    changed=false;
    const ranges=catalog.filter(e=>selected.has(e.id));
    for(const structure of material.richText?.structures||[]){
      if(!['table','formula'].includes(structure.type)||!Number.isFinite(structure.start)||!Number.isFinite(structure.end))continue;
      if(!ranges.some(r=>r.start<structure.end&&r.end>structure.start))continue;
      for(const e of catalog)if(e.start<structure.end&&e.end>structure.start&&!selected.has(e.id)){selected.add(e.id);changed=true;}
    }
  }while(changed);
  const ranges=catalog.filter(e=>selected.has(e.id)).map(({start,end})=>({start,end}));
  const pages=new Set(blocks.flatMap(b=>b.pageNumbers||[]));
  for(const b of blocks)if(Number.isInteger(b.pageStart)&&Number.isInteger(b.pageEnd))for(let n=b.pageStart;n<=b.pageEnd;n++)pages.add(n);
  const text=String(material.text||'');
  const markers=[...text.matchAll(/\[第 (\d+) 页\]|\[ppt\/slides\/slide(\d+)\.xml\]/g)];
  for(const range of ranges){
    const at=markers.findLast(m=>m.index<=range.start);if(at)pages.add(Number(at[1]||at[2]));
    for(const marker of markers)if(marker.index>=range.start&&marker.index<range.end)pages.add(Number(marker[1]||marker[2]));
  }
  return {...material,promptExcerptIds:[...selected],promptEvidenceScope:{ranges,pages:[...pages],
    tableIds:[...new Set(blocks.flatMap(b=>(b.tables||[]).map(t=>t.tableId).filter(Boolean)))],
    formulaIds:[...new Set(blocks.flatMap(b=>(b.formulas||[]).map(f=>f.formulaId).filter(Boolean)))]}};
}

export function materialStructureContext(material,source){
  const scope=material.promptEvidenceScope;
  if(!scope)return {tables:sourceTableCatalog(material,source),formulas:sourceFormulaCatalog(material,source),
    ...(material.documentVisual?{pageVisuals:material.documentVisual.pages.map(p=>({number:p.number,analysis:p.analysis}))}:{})};
  const overlaps=s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||scope.ranges.some(r=>r.start<s.end&&r.end>s.start);
  const rich=material.richText?.structures||[];
  const richTables=rich.filter(s=>s.type==='table'&&s.start<source.length);
  const tables=sourceTableCatalog(material,source).filter((t,i)=>{
    if(t.page&&scope.pages.length)return scope.pages.includes(t.page);
    if(i<richTables.length)return overlaps(richTables[i]);
    // Unlocated CSV/legacy tables cannot safely be dropped based on guessed IDs.
    return true;
  });
  const formulas=sourceFormulaCatalog(material,source).filter(f=>Number.isFinite(f.start)?overlaps(f):
    f.page&&scope.pages.length?scope.pages.includes(f.page):true);
  return {tables,formulas,...(material.documentVisual?{pageVisuals:material.documentVisual.pages
    .filter(p=>!scope.pages.length||scope.pages.includes(p.number)).map(p=>({number:p.number,analysis:p.analysis}))}:{})};
}

export function scopedReading(reading,blocks){
  if(!blocks?.length)return reading;
  return {...reading,summary:blocks.map(b=>b.summary).filter(Boolean).join('\n'),
    keyPoints:blocks.flatMap(b=>b.keyPoints||[]),facts:blocks.flatMap(b=>b.facts||[]),
    tables:blocks.flatMap(b=>b.tables||[]),formulas:blocks.flatMap(b=>b.formulas||[]),
    questions:blocks.flatMap(b=>b.questions||[]),suggestedUse:blocks.map(b=>b.suggestedUse).filter(Boolean).join('\n'),
    informationIndex:{...reading.informationIndex,blocks}};
}
