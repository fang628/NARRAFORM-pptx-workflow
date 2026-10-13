const singleLine=v=>String(v??'').replace(/\r?\n/g,' / ');
export const nestedPromptStructureRule='内容要求和排版要求均用多层 Markdown 列表表达真实结构：子项缩进表示从属，同一父项下的同级正文表示并列；主标题是唯一最高项，副标题为其标题附文，不参与正文并列；图注嵌套在对应图片下面。按已有顺序保留全部层级，不展开成单层列表；列表层级表达内容关系，不要求画成树形图，也不把语义并列强制画为横向排列。';

// The content tree, rather than free-form layout prose, owns parentage and order.
export function nestedContentList(nodes,navigation=[]){
  const labels={title:'标题',subtitle:'副标题',caption:'注释',body:'正文'};
  const walk=(parentId,depth)=>nodes.filter(n=>n.parentId===parentId).flatMap(n=>{
    const label=n.type==='group'?'小标题':n.type==='image'?'图片':n.type==='text'?labels[n.role]||'正文':'图形';
    const value=n.type==='text'?n.text:n.label;
    return [`${'  '.repeat(depth+1)}- ${label}：${singleLine(value)}`,...walk(n.id,depth+1)];
  });
  const lines=walk(null,0);
  if(navigation.length)lines.push('  - 页顶导航（独立于正文结构）：',...navigation.map(n=>'    - 页顶导航：'+singleLine(n.text)));
  return lines.join('\n');
}
