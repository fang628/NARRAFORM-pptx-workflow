import {rememberImage} from './image-history.mjs';
export const visualRepairLimit=2;

function snapshot(record){
  const keys=['index','theme','stamp','materialId','intendedUse','generationMode','imageEditMode','redrawPrompt','parentSourceHash','reference','references','placeholderReview','generationAttempts','geometryAdjustment','source','normalized','file','providerHash','previewHash','dimensions','prompt','promptVersion','images','previewReview','designChecks','review','jobFile','model','at'];
  return structuredClone(Object.fromEntries(keys.filter(k=>record[k]!==undefined).map(k=>[k,record[k]])));
}

export function correctionPrompt(original,issues){
  const names={related_visual:'相关配图',semantic_layout:'内容关系',independent_text:'独立文段',title_hierarchy:'标题层级',readability:'可读性',restrained_decoration:'装饰主次',image_integrity:'原图完整性',top_progress:'页顶导航',academic_fill:'文本承载'};
  const changes=new Set();
  for(const value of issues){
    const issue=String(value),match=issue.match(/^设计规范未通过：([^；]+)；([\s\S]*)$/);
    if(match){changes.add(names[match[1]]||'画面需调整');changes.add(match[2]);}
    else changes.add(issue);
  }
  // The attached current image carries the design. Send only this pass's changes.
  return '【本步自动视觉修正】\n基于随附当前图片，仅修改：\n'+
    [...changes].map(v=>'- '+v).join('\n')+
    '\n保留文案、层级、风格及材料身份；不得编造图注。原图仍等比无字占位块，展示前贴回原件。';
}

// The existing batch worker owns this loop, so retries never multiply concurrency.
export async function reviewAndRepair(record,{review,generate,save,signal,progress=()=>{},makePrompt=correctionPrompt,canRepair=()=>true}){
  const original=record.prompt;let attempts=0;
  try{
    await review(record);
    while(record.previewReview?.status==='needs_revision'&&attempts<visualRepairLimit&&canRepair(record)){
      if(signal?.aborted)throw Error('任务已取消');
      const issues=[...record.previewReview.issues],previous=snapshot(record),history=[...(record.repairHistory||[]),previous];
      attempts++;
      record.autoRepair={limit:visualRepairLimit,attempts,status:'repairing',issues};
      await save(record);
      progress('running',`自动修正 ${attempts}/${visualRepairLimit}：${issues.join('；')}`);
      const next=await generate(makePrompt(original,issues));
      rememberImage({...previous,editHistory:record.editHistory},next);
      // Keep object identity: the project exposes each saved version during polling.
      for(const key of Object.keys(record))delete record[key];
      Object.assign(record,next,...(previous.imageEditMode?[{imageEditMode:previous.imageEditMode,redrawPrompt:previous.redrawPrompt,parentSourceHash:previous.parentSourceHash}]:[]),{repairHistory:history,autoRepair:{limit:visualRepairLimit,attempts,status:'checking',issues}});
      await save(record);
      if(signal?.aborted)throw Error('任务已取消');
      progress('running',`第 ${attempts} 次修正图片已保存并贴回原图，正在复查`);
      await review(record);
    }
    if(attempts){
      const passed=record.previewReview?.status==='passed';
      record.autoRepair={limit:visualRepairLimit,attempts,status:passed?'passed':'exhausted',issues:[...(record.previewReview?.issues||[])]};
      await save(record);
      progress('done',passed?`自动修正 ${attempts} 次后检查通过`:`已自动修正 ${attempts} 次，仍需调整；保留全部版本，停留在当前步骤`);
    }
    return record;
  }catch(error){
    if(attempts){record.autoRepair={...record.autoRepair,status:signal?.aborted?'cancelled':'failed',error:String(error.message).slice(0,2000)};await save(record);}
    throw error;
  }
}
