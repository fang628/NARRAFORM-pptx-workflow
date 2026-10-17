// Count and ratio inspection happen before any originals are pasted.
import {placeholderTargetRatioTolerance} from './image-placement-policy.mjs';
export const placeholderRatioTolerance=placeholderTargetRatioTolerance;
export const placeholderRepairLimit=2;
export const placeholderCountRepairLimit=2;

export function placeholderCountReport(raw,expected){
  if(!Number.isInteger(expected)||expected<0)throw Error('原设计图片数量无效');
  if(!Number.isInteger(raw?.placeholderCount)||raw.placeholderCount<0||raw.placeholderCount>220||typeof raw.countEvidence!=='string'||!raw.countEvidence.trim())throw Error('占位框数量检查须返回实际数量 placeholderCount 与看图依据 countEvidence');
  return {expected,observed:raw.placeholderCount,passed:raw.placeholderCount===expected,evidence:raw.countEvidence.trim().slice(0,1200)};
}

export function placeholderReport(images){
  return images.map(e=>{
    const observedAspect=e.w/e.h,expectedAspect=e.aspect;
    if(!Number.isFinite(expectedAspect)||expectedAspect<=0||!Number.isFinite(observedAspect)||observedAspect<=0)throw Error('无法确定登记原图或占位框的有效比例');
    const relativeError=Math.abs(observedAspect/expectedAspect-1);
    return {nodeId:e.nodeId,id:e.id,label:e.label,box:{x:e.x,y:e.y,w:e.w,h:e.h},expectedAspect,observedAspect,relativeError,passed:relativeError<=placeholderRatioTolerance+1e-9};
  });
}

export function placeholderCorrectionPrompt(checks,{foundation=true}={}){
  return '【占位框比例修正】\n'+(foundation?'图片1是尚未贴回原图的当前整页，图片2是对应底图；在该底图基础上修正当前页。':'随附图片是尚未贴回原图的当前整页。')+'仅调整以下无字占位框及相邻留白，必要时移动邻近文字，保留其他布局、文案、风格与主题主体：\n'+checks.filter(c=>!c.passed).map(c=>`- “${c.label||c.nodeId}”：当前宽高比 ${c.observedAspect.toFixed(3)}:1，改为 ${c.expectedAspect.toFixed(3)}:1；位置约 (${Math.round(c.box.x)},${Math.round(c.box.y)})，1600×900坐标。`).join('\n')+'\n宽高比指宽÷高；过宽的框应增高或减宽，过窄的框应增宽或减高，不要反向调整或反复缩小成细条。占位框保持平坦、干净、无字，不生成原图内容；原图将在比例复查后由本地完整贴回。画布16:9（1920×1080）。\n【占位框比例修正结束】';
}

export async function repairPlaceholders({initial,inspect,regenerate,regenerateCount,signal,progress=()=>{},saveCheck=()=>{}}){
  let candidate=initial,attempts=0,countAttempts=0,lastChecked;const history=[];
  const countState=()=>({countAttempts,countLimit:placeholderCountRepairLimit,...(lastChecked?.countReport?{countReport:lastChecked.countReport}:{})});
  const fallback=error=>{
    const reason=String(error.message).slice(0,2000);
    progress('done','占位框修正未完成，使用上一张已定位底稿贴回原图；检查记录已保留');
    return {candidate:lastChecked.candidate,images:lastChecked.images,review:{status:'fallback',attempts,limit:placeholderRepairLimit,tolerance:placeholderRatioTolerance,checks:lastChecked.checks,history,...countState(),error:reason}};
  };
  for(;;){
    signal?.throwIfAborted();progress('checking',`检查占位框数量与比例${attempts?' · 修正后 '+attempts+'/'+placeholderRepairLimit:''}`);
    let images,checks,countReport;
    try{const inspection=await inspect(candidate);images=Array.isArray(inspection)?inspection:inspection.images;countReport=inspection.countReport;checks=countReport&&!countReport.passed?[]:placeholderReport(images);}
    catch(error){if(signal?.aborted||!lastChecked)throw error;return fallback(error);}
    const passed=(!countReport||countReport.passed)&&checks.every(c=>c.passed);
    const check={attempt:attempts,...(countReport?{countAttempt:countAttempts,countReport}:{}),checks,passed};history.push(check);await saveCheck(candidate,check);
    if(countReport&&!countReport.passed){
      const error=Error(`占位框数量与原设计不一致：应为 ${countReport.expected} 个，实际 ${countReport.observed} 个；已按原提示词重生成 ${countAttempts} 次，生成图片与检查记录已保留`);
      if(countAttempts>=placeholderCountRepairLimit||!regenerateCount){
        if(lastChecked)return fallback(error);
        progress('done','占位框数量仍不符，保留最后生成图与检查记录，暂不贴回原图');
        return {candidate,images:[],review:{status:'count_exhausted',attempts,limit:placeholderRepairLimit,tolerance:placeholderRatioTolerance,checks,history,...countState(),countReport,error:error.message}};
      }
      countAttempts++;progress('repairing',`占位框数量不符（设计 ${countReport.expected} / 实际 ${countReport.observed}），按原提示词重生成 ${countAttempts}/${placeholderCountRepairLimit}`);
      signal?.throwIfAborted();
      try{candidate=await regenerateCount(candidate,countReport,countAttempts);}
      catch(error){if(signal?.aborted||!lastChecked)throw error;return fallback(error);}
      continue;
    }
    lastChecked={candidate,images,checks,countReport};
    if(passed||attempts>=placeholderRepairLimit){
      const status=!images.length?'not_needed':passed?'passed':'exhausted';
      progress('done',status==='exhausted'?`占位框已修正 ${placeholderRepairLimit} 次，按原图适配规则完整贴回`:images.length?'占位框比例检查通过，贴回原图':'本页无登记原图，未发现额外占位框');
      return {candidate,images,review:{status,attempts,limit:placeholderRepairLimit,tolerance:placeholderRatioTolerance,checks,history,...countState()}};
    }
    attempts++;progress('repairing',`占位框比例偏差超过 ${Math.round(placeholderRatioTolerance*100)}%，修正 ${attempts}/${placeholderRepairLimit}`);
    signal?.throwIfAborted();
    try{candidate=await regenerate(candidate,checks,attempts);}
    catch(error){if(signal?.aborted)throw error;return fallback(error);}
  }
}
