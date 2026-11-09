export const automaticConcurrencyHint='自动分配不设单项目配额，按需使用空闲额度；账户最多 6、服务总量最多 12。也可为本项目选择 1–6，运行中调整不会中断在途请求。';
export const concurrencyValue=project=>project.executionConcurrency==null&&project.optionalProjectConcurrencyEnabled?'auto':String(project.executionConcurrency??3);
export const concurrencyLimitFromInput=value=>value==='auto'?null:Number(value);
export const concurrencyLabel=value=>value==null?'自动分配 · 无单项目限制':'并发上限 '+value;
export function syncConcurrencySetting(form,project){
  const field=form.elements.executionConcurrency,automatic=field.querySelector('[value="auto"]');
  if(automatic)automatic.disabled=!project.optionalProjectConcurrencyEnabled;
  field.disabled=project.executionConcurrency===undefined&&!project.optionalProjectConcurrencyEnabled;
  field.value=concurrencyValue(project);
  return field.disabled?'当前后台尚未加载更新；重启本地服务后可设置并发上限。':project.optionalProjectConcurrencyEnabled?automaticConcurrencyHint:'当前服务支持单项目 1–6；重启后可启用自动分配。';
}
