// Keep content and preview confirmation together without relaxing server validation.
export async function confirmPreviewForDelivery({getProject,action,context}){
  const original=getProject(),state=original?.previewApprovalState;
  if(!context||original?.id!==context.projectId||state?.stamp!==context.stamp)throw Error('预览图片或检查记录已变化，请重新打开确认窗口');
  if(!state.ready)throw Error('请先补齐当前预览或同步已有预览');
  if(!state.contentConfirmed&&!context.confirmContent)throw Error('请先确认当前内容版本');
  const version=original.version;
  if(!state.contentConfirmed)await action('approveContent');
  const current=getProject(),fresh=current?.previewApprovalState;
  if(current?.id!==context.projectId||current.version!==version||fresh?.stamp!==context.stamp||!fresh.ready||!fresh.contentConfirmed)throw Error('内容或预览已变化，请重新打开确认窗口');
  return action('approvePreview',{confirmAllPages:true,acceptIssues:context.acceptIssues,approvalStamp:context.stamp},4);
}
