export function crossThemePrompt({rendering,background,colors,hasStyleReference,instruction=''}){
  return '以图片1为结构原图，保留主体身份、轮廓、形状、部件数量、连接关系、位置、比例和构图，仅修改配色、材质及光影风格。'+
    (hasStyleReference?'图片2仅参考色调、材质与光影，不借用其主体或构图。':'')+
    (rendering?rendering+'；':'')+'底色 '+background+'，可用配色 '+colors.join('、')+'。'+
    (instruction.trim()?'调整意见（限配色与表现）：'+instruction.trim().replace(/[。；;]+$/u,'')+'。':'')+
    '保留原有文字留白与区域边界，不新增或删除对象。16:9（1920×1080），不含文字、数字、文本框或占位框。';
}

export function crossPreviewPrompt({rendering,background,colors,hasStyleReference,instruction=''}){
  return '以图片1为排版原图，保留全部文字与图注、图文关系、主体结构、形状、位置和比例，仅调整配色、字体气质、材质与光影。'+
    (hasStyleReference?'图片2仅作风格参考，不照搬其构图或替换主体。':'')+
    (rendering?rendering+'；':'')+'可用颜色 '+[...new Set([background,...colors])].join('、')+'。'+
    (instruction.trim()?'调整意见（限风格表现）：'+instruction.trim().replace(/[。；;]+$/u,'')+'。':'')+
    '登记图片继续使用平坦无字占位框，保留原框数量及宽高比，不生成原图内容；本地贴回原件。16:9（1920×1080），不新增文案或对象。';
}
