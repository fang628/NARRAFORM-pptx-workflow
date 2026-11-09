// A page-local save must never send the rest of the deck, including other unsaved drafts.
export function pageContentSaveRequest(project,index,slide){
  if(!project?.pageContentSaveEnabled)throw Error('当前服务尚未启用单页保存，请重启服务后重试');
  if(!Number.isInteger(index)||index<0||index>=project.slides.length)throw Error('页面已变化，请重新打开本页');
  if(!slide||typeof slide!=='object'||Array.isArray(slide))throw Error('本页内容格式无效');
  return {index,slide:structuredClone(slide),baseSlide:structuredClone(project.slides[index])};
}
