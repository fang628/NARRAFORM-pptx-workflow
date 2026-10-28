// Shared by the content model and browser editor; no HTML or executable source content.
export const tableLimits={columns:12,rows:20,cell:600,characters:24000};
export const sourceChartPlanningRule='材料图表选用：先判断图表中哪些信息服务于全篇主题与叙述，再分配到具体页面；仅局部相关、不能推进全篇叙述的信息不选用。先理解原图表，提取需要的指标、数据或结论及其条件，不照搬整张图表图片或全部行列。需要共同维度比较的有效信息重组为可编辑table节点；仅有一个数值或少量结论时用短分点，不为转换图表而强行制表。保留材料来源、单位及比较口径，不猜测模糊数值、不根据曲线目测补造精确数据；读不清的信息留在材料读取记录，不编入成品。不重复插入已用表格或文字呈现的原图表；原图仍保留在材料库。此规则适用于数据图、原表及表格截图，不将照片、流程图或机理示意机械改成表格；用户明确要求保留原图或原PPT版式时遵从其要求。';
export const tablePlanningRule=sourceChartPlanningRule+'表格规划：表格仅在多个对象或指标需要按共同维度对照、且比短分点更清楚时采用，不强制每页制表，不把流程、特点罗列或单项数据都做成表格。可承载材料支持的定性结论和定量数据，不限定数值数据，也不要求材料中已有原表。根据材料中明确支持的信息组织独立type=table节点，headers为表头数组、rows为数据行二维数组；同一比较维度对齐，不混淆条件、单位与结论归属。表格可以直接承载准确的关键结论，不必另建重复正文；关键结论仍用一句完整且简洁的话，其余单元格可用短语或数据。保留所选信息的必要结论、数值、单位、条件和来源；大表仅选取服务全篇叙述且与本页相关的行列，不能虚构、计算或补齐缺失数据。表格从属于对应真实小标题或主标题，与文字、图片使用同一内容树和来源索引；已入表的信息不与正文重复列出，表格标签仅供识别，不额外作为上屏小标题。';
export function validateTableContent(value){
  const {headers,rows}=value||{};
  if(!Array.isArray(headers)||!headers.length||headers.length>tableLimits.columns||!Array.isArray(rows)||!rows.length||rows.length>tableLimits.rows)throw Error('表格须有 1–12 列表头和 1–20 行数据');
  const cell=v=>{if(typeof v!=='string'&&typeof v!=='number')throw Error('表格单元格须为文字或数字');const text=String(v);if(text.length>tableLimits.cell)throw Error('单个表格单元格最多 600 字');return text;};
  const result={headers:headers.map(cell),rows:rows.map(row=>{if(!Array.isArray(row)||row.length!==headers.length)throw Error('表格每行列数须与表头一致');return row.map(cell);})};
  if(![...result.headers,...result.rows.flat()].some(v=>v.trim()))throw Error('表格内容不能为空');
  if(JSON.stringify(result).length>tableLimits.characters)throw Error('表格内容过长，请选取与本页相关的数据');
  return result;
}
const markdownCell=value=>String(value??'').replace(/\\/g,'\\\\').replace(/\|/g,'\\|').replace(/\r\n?|\n/g,'<br>');
export function tableMarkdown(table){
  const row=values=>'| '+values.map(markdownCell).join(' | ')+' |';
  return [row(table.headers),row(table.headers.map(()=>'---')),...table.rows.map(row)].join('\n');
}
// Each nonempty cell becomes an exact editable text object through the existing rebuild path.
export function tableCellTexts(table){
  return [table.headers,...table.rows].flatMap((row,r)=>row.flatMap((text,c)=>String(text).trim()?[{nodeId:table.id+'-cell-'+r+'-'+c,text:String(text),parentId:table.id,role:r?'table-cell':'table-header',tableId:table.id,row:r,column:c}]:[]));
}

export function sourceTableCatalog(material,source=String(material?.text||'')){
  // Rich document cell offsets address canonical source text, preserving provenance.
  const structures=material.richText?.structures||[];
  let tables=structures.filter(s=>s.type==='table'&&s.start<source.length).map((s,i)=>({id:'T'+(i+1),rows:s.rows.filter(row=>row.every(c=>c.end<=source.length)).map(row=>row.map(c=>source.slice(c.start,c.end).trim()))}));
  if(!tables.length&&/\.csv$/i.test(material.name||material.file||'')){
    const delimiter=source.split(/\r?\n/)[0]?.includes('\t')?'\t':',',rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<source.length;i++){const c=source[i];if(c==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===delimiter||c==='\n')){row.push(cell);cell='';if(c==='\n'){rows.push(row);row=[];}}else if(c!=='\r'||quoted)cell+=c;}
    if(cell||row.length){row.push(cell);rows.push(row);}if(rows.length>1)tables=[{id:'T1',rows}];
  }
  let budget=24000;
  return tables.slice(0,30).map(table=>{
    const rows=[];for(const row of table.rows.slice(0,40)){const values=row.slice(0,16).map(v=>v.slice(0,600)),cost=JSON.stringify(values).length;if(cost>budget)break;rows.push(values);budget-=cost;}
    return {...table,rows,rowCount:table.rows.length,columnCount:table.rows.reduce((max,row)=>Math.max(max,row.length),0),partial:rows.length<table.rows.length||table.rows.some(r=>r.length>16||r.some(v=>v.length>600))};
  }).filter(t=>t.rows.length);
}
