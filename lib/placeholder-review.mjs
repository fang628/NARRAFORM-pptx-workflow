// Ratio inspection happens on the uncomposited image, before any originals are pasted.
export const placeholderRatioTolerance=.05;
export const placeholderRepairLimit=2;

export function placeholderReport(images){
  return images.map(e=>{
    const observedAspect=e.w/e.h,expectedAspect=e.aspect;
    if(!Number.isFinite(expectedAspect)||expectedAspect<=0||!Number.isFinite(observedAspect)||observedAspect<=0)throw Error('无法确定登记原图或占位框的有效比例');
    const relativeError=Math.abs(observedAspect/expectedAspect-1);
    return {nodeId:e.nodeId,id:e.id,label:e.label,box:{x:e.x,y:e.y,w:e.w,h:e.h},expectedAspect,observedAspect,relativeError,passed:relativeError<=placeholderRatioTolerance+1e-9};
  });
}

export function placeholderCorrectionPrompt(checks,{foundation=true}={}){
  return '【占位框比例修正】\n'+(foundation?'图片1是尚未贴回原图的当前整页，图片2是对应底图；在该底图基础上修正当前页。':'随附图片是尚未贴回原图的当前整页。')+'仅调整以下无字占位框及相邻留白，必要时移动邻近文字，保留其他布局、文案、风格与主题主体：\n'+checks.filter(c=>!c.passed).map(c=>`- “${c.label||c.nodeId}”：当前宽高比 ${c.observedAspect.toFixed(3)}:1，改为 ${c.expectedAspect.toFixed(3)}:1；位置约 (${Math.round(c.box.x)},${Math.round(c.box.y)})，1600×900坐标。`).join('\n')+'\n占位框保持平坦、干净、无字，不生成原图内容；原图将在比例复查后由本地等比贴回。画布16:9（1920×1080）。\n【占位框比例修正结束】';
}

export async function repairPlaceholders({initial,inspect,regenerate,signal,progress=()=>{},saveCheck=()=>{}}){
  let candidate=initial,attempts=0,lastChecked;const history=[];
  const fallback=error=>{
    const reason=String(error.message).slice(0,2000);
    progress('done','占位框修正未完成，使用上一张已定位底稿等比贴回原图；检查记录已保留');
    return {candidate:lastChecked.candidate,images:lastChecked.images,review:{status:'fallback',attempts,limit:placeholderRepairLimit,tolerance:placeholderRatioTolerance,checks:lastChecked.checks,history,error:reason}};
  };
  for(;;){
    signal?.throwIfAborted();progress('checking',`检查占位框比例${attempts?' · 修正后 '+attempts+'/'+placeholderRepairLimit:''}`);
    let images,checks;
    try{images=await inspect(candidate);checks=placeholderReport(images);}
    catch(error){if(signal?.aborted||!lastChecked)throw error;return fallback(error);}
    const passed=checks.every(c=>c.passed);lastChecked={candidate,images,checks};
    const check={attempt:attempts,checks,passed};history.push(check);await saveCheck(candidate,check);
    if(passed||attempts>=placeholderRepairLimit){
      const status=!images.length?'not_needed':passed?'passed':'exhausted';
      progress('done',status==='exhausted'?`占位框已修正 ${placeholderRepairLimit} 次，按原图比例完整贴回`:images.length?'占位框比例检查通过，贴回原图':'本页无登记原图，跳过占位框检查');
      return {candidate,images,review:{status,attempts,limit:placeholderRepairLimit,tolerance:placeholderRatioTolerance,checks,history}};
    }
    attempts++;progress('repairing',`占位框比例偏差超过 ${Math.round(placeholderRatioTolerance*100)}%，修正 ${attempts}/${placeholderRepairLimit}`);
    signal?.throwIfAborted();
    try{candidate=await regenerate(candidate,checks,attempts);}
    catch(error){if(signal?.aborted)throw error;return fallback(error);}
  }
}
