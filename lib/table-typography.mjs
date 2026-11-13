import {cellIdentity} from './table-objects.mjs';

export const TABLE_TYPOGRAPHY_VERSION=1;
export const tableTypographyRule='表格文字整表统一加粗和斜体状态；只允许有参考证据的一条完整行或一条完整列作为加粗/斜体强调例外，同一表不能同时设置不同的强调行和强调列。表头若加粗也计作这一条强调行。不得零散单元格或行内局部加粗，不为强调改动字号、颜色、对齐或位置。';
const flags=['bold','italic'];
const clamp=value=>Math.max(0,Math.min(1,Number(value)||0));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

function observation(element,parameter){
  const evidence=element.parameterEvidence?.[parameter];
  const source=evidence?.inherited||evidence?.independent===false?evidence.observation:evidence;
  if(source?.independent===true&&typeof source.value==='boolean')return {...source,confidence:clamp(source.confidence)};
  if(evidence?.inherited||evidence?.independent===false)return {value:element[parameter]===true,confidence:0,independent:false};
  return {value:element[parameter]===true,confidence:clamp(source?.confidence??.6),independent:true,source:'audit-table-style'};
}

function collectTables(elements){
  const declared=new Map();
  for(const anchor of elements)for(const cell of anchor.tableObject?.cells||[]){
    declared.set(cell.key,{tableId:anchor.tableObject.tableId,row:cell.row,column:cell.column});
  }
  const tables=new Map();
  for(const element of elements){
    if(element.type!=='text'||element.managed)continue;
    const identity=declared.get(element.key)||cellIdentity(element);
    if(!identity||!Number.isInteger(identity.row)||!Number.isInteger(identity.column))continue;
    const id=identity.tableId||element.tableId;
    if(!id)continue;
    if(!tables.has(id))tables.set(id,[]);
    tables.get(id).push({element,row:identity.row,column:identity.column,
      observations:Object.fromEntries(flags.map(p=>[p,observation(element,p)]))});
  }
  return tables;
}

function decide(members){
  const cells=new Map();
  // Split number/label text is one cell, not two independent votes.
  for(const member of members){
    const id=member.row+':'+member.column;
    if(!cells.has(id))cells.set(id,{row:member.row,column:member.column,observations:{}});
    const cell=cells.get(id);
    for(const p of flags)if(!cell.observations[p]||member.observations[p].confidence>cell.observations[p].confidence)cell.observations[p]=member.observations[p];
  }
  const list=[...cells.values()],rows=[...new Set(list.map(c=>c.row))].sort((a,b)=>a-b),columns=[...new Set(list.map(c=>c.column))].sort((a,b)=>a-b);
  const lines=[];
  for(const [axis,indices,opposite]of [['row',rows,columns],['column',columns,rows]])for(const index of indices){
    const own=list.filter(c=>c[axis]===index);
    if(own.length<2||own.length!==opposite.length||list.length-own.length<2)continue;
    const supported=flags.filter(p=>{
      const reliable=own.filter(c=>c.observations[p].independent&&c.observations[p].confidence>=.55);
      const total=reliable.reduce((s,c)=>s+c.observations[p].confidence,0);
      return reliable.length>=2&&reliable.length>=own.length*.75&&total>0
        &&reliable.filter(c=>c.observations[p].value).reduce((s,c)=>s+c.observations[p].confidence,0)/total>=.85;
    });
    if(supported.length)lines.push({axis,index,supported});
  }
  const reliable=list.flatMap(c=>flags.map(p=>c.observations[p])).filter(o=>o.independent&&o.confidence>=.55);
  if(!reliable.length)return null;
  let best;
  for(const line of [null,...lines])for(const bold of [false,true])for(const italic of [false,true]){
    const base={bold,italic};
    for(const mask of line?[1,2,3]:[0]){
      const emphasis=flags.filter((p,i)=>(mask&(1<<i))&&!base[p]&&line?.supported.includes(p));
      if(line&&emphasis.length!==flags.filter((_,i)=>mask&(1<<i)).length)continue;
      let cost=line ? .2 : 0;
      for(const cell of list)for(const p of flags){
        const o=cell.observations[p];if(!o.independent||o.confidence<.55)continue;
        const value=base[p]||Boolean(line&&cell[line.axis]===line.index&&emphasis.includes(p));
        if(value!==o.value)cost+=o.confidence;
      }
      if(!best||cost<best.cost-1e-9)best={cost,base,emphasis:line?{axis:line.axis,index:line.index,properties:emphasis}:null};
    }
  }
  return best;
}

export function normalizeTableTypography(elements,{targetKeys=null}={}){
  const targets=targetKeys?new Set(targetKeys):null,patches=new Map(),decisions=[];
  for(const [tableId,members]of collectTables(elements)){
    const decision=decide(members);
    const prior=members.find(m=>m.element.tableTypography?.version===TABLE_TYPOGRAPHY_VERSION)?.element.tableTypography;
    const policy=decision?{version:TABLE_TYPOGRAPHY_VERSION,tableId,base:decision.base,emphasis:decision.emphasis}:prior
      ||{version:TABLE_TYPOGRAPHY_VERSION,tableId,base:{bold:false,italic:false},emphasis:null,pending:true};
    for(const member of members){
      const element=member.element;if(targets&&!targets.has(element.key))continue;
      const next={...element,tableTypography:policy},evidence={...element.parameterEvidence};
      for(const p of flags){
        next[p]=policy.base[p]||Boolean(policy.emphasis&&member[policy.emphasis.axis]===policy.emphasis.index&&policy.emphasis.properties.includes(p));
        const sources=members.filter(m=>m.observations[p].independent&&m.observations[p].confidence>=.55);
        evidence[p]={confidence:Math.max(0,...sources.map(m=>m.observations[p].confidence)),independent:false,inherited:true,
          sources:[...new Set(sources.map(m=>m.element.key))],method:'table-row-column-consensus',observation:member.observations[p]};
      }
      next.parameterEvidence=evidence;delete next.boldRuns;
      if(!equal(next,element))patches.set(element.key,next);
    }
    decisions.push(policy);
  }
  return {elements:elements.map(e=>patches.get(e.key)||e),decisions,changes:[...patches.keys()]};
}
