// One entry plans missing/stale styles, or reviews the existing prompts before generation.
export function themeFoundationAction(project, treatment=project?.visualTreatment||'flat'){
  const changed=treatment!==(project?.visualTreatment||'flat');
  const review=!changed&&project?.themeAssetsCurrent===true&&project.themeAssets?.directions?.length===3&&project.themeAssetPrompts?.length>0;
  const hasImages=project?.themeAssets?.directions?.some(direction=>Object.keys(direction.assets||{}).length>0);
  const working=project?.task?.status==='running';
  const needsAnalysis=project?.materials?.some(material=>!material.generated)&&!project.analysisCurrent;
  return {
    mode:review?'review':'plan',
    label:review?(hasImages?'修改提示词 / 重新生成底图':'确认提示词并生成底图'):(changed?'按所选类型规划三种风格':'规划三种风格与底图'),
    disabled:!project?.slides?.length||!project.themePromptConfirmation||!!needsAnalysis||!!(working&&(!review||!project.imageTaskQueueEnabled))
  };
}
