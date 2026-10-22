// This mode is selected only by the user's brief plus actual uploaded PPTX,
// never by instructions found inside a document or a material-analysis response.
export function visualOptimizationRequested(brief={}){
  const purpose=String(brief.purpose||'').toLowerCase();
  const clauses=purpose.split(/[。；;\n]/).map(clause=>clause.replace(/(?:不是|而非|不要|不需要|不想|并非|而不是)\s*(?:重新制作|重新做|重做|重写|重新设计)(?:\s*(?:ppt|演示文稿))?/gi,'').replace(/\b(?:not|without)\s+(?:rebuilding|rewriting|remaking|rebuild|rewrite|remake)(?:\s+(?:the\s+)?(?:presentation|slides|ppt))?/g,''));
  return clauses.some(clause=>{
    if(/(?:不是|并非|不要|不需要)\s*(?:优化|美化|润色)|(?:重新制作|重新做|重做|重写).{0,15}(?:ppt|演示文稿)|\b(?:rebuild|rewrite|remake)\s+(?:the\s+)?(?:ppt|presentation|slides)\b/.test(clause))return false;
    return /美化|换肤|(?:优化|润色|改善|提升|调整).{0,30}(?:视觉|风格|外观|样式)|(?:ppt|演示文稿).{0,30}(?:视觉优化|风格优化|视觉风格|美化|换肤)|\b(?:restyle|beautify)\b|(?:improve|optimi[sz]e).{0,30}(?:visual|appearance)/.test(clause);
  });
}
export const originalPPTSources=p=>visualOptimizationRequested(p.brief)?p.materials.filter(m=>!m.generated&&!m.extracted&&!m.reconstructed&&/\.pptx$/i.test(m.file||m.name||'')):[];
export const optimizingOriginalPPT=p=>originalPPTSources(p).length>0;
export function originalPage(p,index){
  const source=p.slides?.[index]?.sourcePresentation;if(!source||!optimizingOriginalPPT(p))return null;
  const m=originalPPTSources(p).find(m=>m.id===source.materialId&&m.sha256===source.sha256),page=m?.presentation?.slides.find(page=>page.number===source.page);
  return page?{...source,original:page,material:m}:null;
}
export const preservePPTLayoutRule='本任务是优化原PPT的视觉风格，保持原稿，不重新创作内容或排版。逐页对应原稿，页数和顺序不变；完整保留原文、数字、公式、表格行列、内容图片及其出现次数，原有文本框划分、图文位置、尺寸比例、分组、对齐、阅读顺序、箭头连接与叙述逻辑均沿用。只调整配色、字体、字重、线条和视觉质感，不因短文案、单页字数、配图去重、默认封面目录或创意分块要求删改原内容、拆并文本、增删页面或重新布局。装饰图片不作为内容素材登记，原稿装饰的空间归属留在版式参考中；不把装饰升级为内容。用户明确提出的修改优先，其他原稿内容保持。';
export function originalPageContext(p,index){
  const source=originalPage(p,index);if(!source)return '';
  return preservePPTLayoutRule+'\n原稿页面与位置（1600×900参考坐标，仅作还原依据）：'+JSON.stringify({materialId:source.materialId,page:source.page,objects:source.original.objects,nodeMap:source.nodeMap,analysis:source.material.documentVisual?.pages.find(page=>page.number===source.page)?.analysis});
}
export function originalImageGeometry(p,index,images){
  const page=originalPage(p,index);if(!page)return null;
  return images.map(image=>{const position=page.nodeMap?.[image.nodeId]?.box;if(!position)throw Error('原稿配图位置缺失，请在01重新理解原PPT，不能另行猜测排版');return {...image,...position,aspect:position.w/position.h,plannedSize:{w:position.w*1.2,h:position.h*1.2},imageFit:'fill'};});
}
export function anchorOriginalDesign(p,index,plan){
  const page=originalPage(p,index);if(!page)return plan;
  return {...plan,layoutIntent:'沿用原稿分区、图文位置、尺寸比例及阅读关系，仅优化视觉样式。',nodes:plan.nodes.map(node=>{const b=page.nodeMap?.[node.id]?.box;return b?{...node,position:`原稿框位 x=${b.x}, y=${b.y}`,relativeSize:`原稿宽=${b.w}, 高=${b.h}`} :node;})};
}
export function anchorOriginalElements(p,index,elements){
  const page=originalPage(p,index);if(!page)return elements;
  return elements.map(element=>{
    if(!['text','image'].includes(element.type)||!element.nodeId)return element;
    let b=page.nodeMap?.[element.nodeId]?.box;
    if(!b){const cell=element.nodeId.match(/^(.*)-cell-(\d+)-(\d+)$/);if(cell)b=page.nodeMap?.[cell[1]]?.cellBoxes?.[Number(cell[2])]?.[Number(cell[3])];}
    return b&&b.x>=0&&b.y>=0&&b.w>0&&b.h>0&&b.x+b.w<=1600.1&&b.y+b.h<=900.1?{...element,...b}:element;
  });
}

export function importOriginalPPTSlides(p){
  const sources=originalPPTSources(p);if(!sources.length)return null;
  const count=sources.reduce((n,m)=>n+(m.presentation?.slides?.length||0),0);if(!count||count>30)throw Error('原稿视觉优化目前支持1–30页，不能通过删页或合并内容满足页数；请分段上传');
  const result=[];
  for(const m of sources){
    if(!m.presentation?.slides?.length||m.documentVisual?.sourceHash!==m.sha256||m.documentVisual.status!=='done')throw Error('请先在01完成原PPT的逐页布局与非装饰图片识别；有效结果已保留，可重新理解以补齐');
    for(const page of m.presentation.slides){
      const analysis=m.documentVisual.pages.find(record=>record.number===page.number),objects=page.objects||[],textObjects=objects.filter(o=>o.text?.trim()),titleObject=textObjects.find(o=>String(o.id)===analysis.analysis.titleObjectId)||textObjects.find(o=>['title','ctrTitle'].includes(o.placeholder))||textObjects[0];
      const titleId=titleObject?'ppt-'+titleObject.id:'ppt-title',nodes=[],links=[],nodeMap={},root={id:titleId,type:'text',role:'title',label:'原稿标题',text:titleObject?.text||'原稿第 '+page.number+' 页',parentId:null,layout:'stack'};nodes.push(root);
      const addText=(id,text,role,object,parentId=titleId)=>{
        if(!text.trim())return;
        if(text.length>2500)throw Error('原PPT第 '+page.number+' 页有超长文本框，请先在原稿中拆分；不会自动缩写或丢弃');
        if(id!==titleId)nodes.push({id,type:'text',role,label:role==='subtitle'?'原稿副标题':'原稿文字',text,parentId,layout:'stack'});
        nodeMap[id]={objectId:object.id,box:object.box};links.push({materialId:m.id,target:'element:'+id,quote:text,note:'原PPT第 '+page.number+' 页 · '+object.name});
      };
      if(titleObject)addText(titleId,titleObject.text,'title',titleObject);
      let hasSubtitle=false;
      for(const object of objects){
        if(object===titleObject)continue;
        if(object.text?.trim()){const subtitle=object.placeholder==='subTitle'&&!hasSubtitle;addText('ppt-'+object.id,object.text,subtitle?'subtitle':'body',object);if(subtitle)hasSubtitle=true;}
        if(object.table){
          const [headers,...rows]=object.table,id='ppt-table-'+object.id;
          if(headers?.length&&headers.length<=12&&rows.length>=1&&rows.length<=20&&object.table.every(row=>row.length===headers.length&&row.every(cell=>cell.length<=600))){
            nodes.push({id,type:'table',label:'原稿表格',headers,rows,parentId:titleId,layout:'stack'});nodeMap[id]={objectId:object.id,box:object.box,cellBoxes:object.cellBoxes};
            for(const row of object.table)if(row.some(cell=>cell.trim()))links.push({materialId:m.id,target:'element:'+id,quote:row.join('\t'),note:'原PPT第 '+page.number+' 页原表行列'});
          }else for(const [r,row]of object.table.entries())for(const [c,text]of row.entries())addText('ppt-'+object.id+'-cell-'+r+'-'+c,text,'body',{...object,box:object.cellBoxes?.[r]?.[c]||object.box});
        }
      }
      const selected=analysis.analysis.figures;
      for(const [i,figure]of selected.entries()){
        // An editable source table is already represented by its exact cells.
        const object=objects.find(o=>String(o.id)===figure.objectId);if(object?.table)continue;
        const material=p.materials.find(item=>analysis.materialIds.includes(item.id)&&item.sourceLocations?.some(location=>location.page===page.number&&(figure.objectId?location.objectId===figure.objectId:JSON.stringify(location.box)===JSON.stringify(figure.box))));
        if(!material)throw Error('原PPT第 '+page.number+' 页内容图片尚未完整提取，请在01补齐');
        const id='ppt-image-'+i,box=object?.box||{x:figure.box.x*1.6,y:figure.box.y*.9,w:figure.box.w*1.6,h:figure.box.h*.9};nodes.push({id,type:'image',label:figure.caption,materialId:material.id,parentId:titleId,layout:'stack'});nodeMap[id]={objectId:object?.id||null,box};
      }
      // Original group membership is authoritative; content nodes remain distinct.
      const groupIds=new Set(objects.filter(o=>o.type==='grpSp').map(o=>String(o.id)));
      for(const node of nodes.filter(n=>n!==root&&n.role!=='subtitle')){
        const entry=nodeMap[node.id],object=objects.find(o=>String(o.id)===String(entry?.objectId));let parent=object?.parentId;
        while(parent&&groupIds.has(String(parent))){
          // A source group has no invented heading; retain it in the source map.
          (entry.groupIds||=[]).push(String(parent));parent=objects.find(o=>String(o.id)===String(parent))?.parentId;
        }
      }
      const elements=nodes.filter(n=>n===root||n.type!=='text'||n.text.trim());
      for(const group of objects.filter(o=>o.type==='grpSp').reverse()){
        const members=elements.filter(node=>node!==root&&node.role!=='subtitle'&&nodeMap[node.id]?.groupIds?.includes(String(group.id))),anchor=members.find(node=>node.type==='text');
        if(anchor)for(const member of members)if(member!==anchor&&member.parentId===titleId)member.parentId=anchor.id;
      }
      const ordered=analysis.analysis.readingOrder||[];elements.sort((a,b)=>a===root?-1:b===root?1:(ordered.indexOf(String(nodeMap[a.id]?.objectId))<0?1e5:ordered.indexOf(String(nodeMap[a.id]?.objectId)))-(ordered.indexOf(String(nodeMap[b.id]?.objectId))<0?1e5:ordered.indexOf(String(nodeMap[b.id]?.objectId))));
      result.push({kind:analysis.analysis.kind,title:root.text,subtitle:'',body:[],notes:'',sources:links.length?[m.id]:[],sourceLinks:links,elements,imageId:elements.find(n=>n.type==='image')?.materialId||null,sourcePresentation:{version:1,materialId:m.id,sha256:m.sha256,page:page.number,reference:analysis.reference,referenceHash:analysis.referenceHash,nodeMap,hiddenTitle:!titleObject}});
    }
  }
  return result;
}
