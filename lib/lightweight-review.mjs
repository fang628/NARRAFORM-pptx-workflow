export const lightweightReviewRule='采用轻量检查：只把明显文案遗漏、错图、严重遮挡或重叠、文字不可读、原图损坏、错误内容关系，以及生图底稿中明显的图片占位框数量或比例问题列为必须修正。生成占位框时逐图按登记宽高比核对，2%容差，超出时最多修正两次。之后原图按占位框位置与宽高完整铺满，不限制显示比例或拉伸幅度，不回退等比留边。05重建对照已确认预览的图片位置、尺寸、铺满方式和原件身份；不得重新以原始宽高比容差否决已确认的图片显示比例，不据此要求等比贴回或缩窄图片。轻微配色、字体气质、留白、对齐、装饰密度或局部构图差异只列入 warnings，不判失败、不触发重生成。不要求精确色值，不评判材料的学术严谨性，不因常规布局或个人审美偏好否决；深底浅字和文本框底色差按实际可读性判断。';
export const advisoryDesignChecks=['academic_fill','restrained_decoration'];

export function partitionVisualIssues(issues=[]){
  const critical=[],warnings=[];
  for(const value of issues){
    const text=String(value).slice(0,2000);
    const serious=/遮挡|重叠|溢出|越界|不可读|无法阅读|难以辨认|遗漏|缺失|错图|错误图片|损坏|截断|裁切|扭曲|拉伸|占位.{0,15}(?:多余|重复|数量|比例)|(?:多余|重复).{0,10}占位|改变.{0,10}(?:语义|从属|因果)/i.test(text);
    const minor=/轻微|细微|略微|稍微|可优化|academic_fill|restrained_decoration|渐变|色调偏差|装饰.{0,12}(?:过多|稍多|不够克制)|字体.{0,12}(?:气质|风格)/i.test(text);
    (minor&&!serious?warnings:critical).push(text);
  }
  return {issues:[...new Set(critical)],warnings:[...new Set(warnings)]};
}

export function previewReviewConclusion(review,designChecks,blockingKeys){
  const reported=[...(review.issues||[])];
  for(const key of [...new Set([...blockingKeys,...advisoryDesignChecks])]){
    if(designChecks[key]===false)reported.push('设计规范未通过：'+key+'；'+designChecks.reason);
  }
  const result=partitionVisualIssues(reported);
  result.warnings.push(...(Array.isArray(review.warnings)?review.warnings.map(String):[]));
  if(!review.passed&&!result.issues.length&&!result.warnings.length)result.issues.push('模型判定画面需修改：'+review.notes);
  return result;
}
