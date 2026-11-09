// Starting visual generation also accepts the current content/design, just like leaving 02.
export function conceptPreviewEntryState(p){
  const confirmed=p?.confirmedVisualPages||[],hasPages=!!p?.slides?.length;
  const needsConfirmation=hasPages&&!confirmed.length;
  const contentReady=confirmed.length>0||needsConfirmation&&p.enterVisualStageEnabled&&p.approvals?.requirements;
  const foundationsReady=p?.previewImageToImage?
    (needsConfirmation?p.themeAssetsCurrent&&p.themeAssets?.directions?.length===3:p.conceptFoundationReadiness?.passed):!p?.themeAssetsQualityBlocked;
  const working=p?.task?.status==='running';
  const disabled=!contentReady||!foundationsReady||working&&(needsConfirmation||!p.imageTaskQueueEnabled);
  const reason=!contentReady?'先在02生成页面内容':!foundationsReady?'先生成当前三方向对应底图':working&&disabled?'当前任务完成后可继续':'';
  return {disabled:!!disabled,needsConfirmation,reason};
}

export async function prepareConceptPreview(project,confirm){
  if(!project?.slides?.length)throw Error('请先生成逐页内容');
  if(!(project.confirmedVisualPages||[]).length){
    if(!project.enterVisualStageEnabled)throw Error('请在02保存并确认内容与设计');
    project=await confirm();
  }
  if(!(project.confirmedVisualPages||[]).length)throw Error('当前页面尚未准备好，请检查02的内容与设计');
  if(project.previewImageToImage&&!project.conceptFoundationReadiness?.passed)throw Error(project.conceptFoundationReadiness?.issues?.join('；')||'请先生成对应底图');
  return project;
}
