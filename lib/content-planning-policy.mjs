// Apply while selecting and writing content, never to rewrite confirmed slides.
export const contentEmphasisRule='全篇内容规划围绕用户实际任务及材料支持的核心对象、问题、过程与结果展开；技术路线、方法、成果、优势与特点按任务需要选用，不作为所有演示的固定栏目。不主动新增“未考据”“不严谨”“劣势”“局限”“风险评判”等讨论或栏目，不把材料分析中的内部核对事项编入页面主题、正文或讲稿；只有用户明确要求这类专题时才安排。忠实呈现选用信息，保留数值、单位和适用条件，不把负向数据改写为正面成果，不补造材料没有的优势。questions仅用于影响制作的材料读取、引用定位或任务输入缺失，不用于评价材料观点。';

export const contentGoalRule='目标先行：上传材料下方的补充文字是主要制作意图，据此确定本次演示要回答的问题、受众需要知道什么、重点与排除范围；用户确认纠正同样参与取舍。主题、听众、用途、页数和页型是制作约束。补充文字为空时，结合表单和材料归纳目标，不猜测融资、商业化、教学或风险评估等未表达的任务。用户提示不是材料，不为其创建材料id或证据；事实仍须来自材料。';
export const contentSelectionRule='选材边界：完整理解与保留材料不等于全部上屏。仅选直接服务本次目标或理解所必需的信息，材料有依据不等于应该进入PPT；以相关、必要、有材料支持为取舍依据，不逐文件轮流汇报，不要求每份材料或每个原文章节各占一页。摘要、附录、参考文献、作者履历、操作说明及其他项目内容不自动成页，用户要求或本次任务确需时再选用；必要引用和选用信息的数值、单位、条件、对照与来源仍保留。内部读取问题、核对事项及模型用途建议不能变成页面主题或正文。未选范围只留在原材料与索引，不为证明完整性补入页面。';

export const taskArrangementGuides={
  research:'研究汇报：围绕研究问题组织必要背景、方法原理或技术路线、材料已有的结果与对照、研究结论；重点页数留给方法和结果。没有实验数据不补实验章，介绍性论文讲解不伪装为用户自己的研究成果。',
  product:'产品或技术介绍：先明确对象、用途或需要解决的问题，再按理解依赖说明能力、原理、工作流程、使用场景及已有价值证据；基础概念先于细节。不自动加入市场规模、融资、商业模式或竞品评价。',
  project:'项目介绍或答辩：按任务目标与需求、方案和分工、实现过程、实际成果与验证、目标完成情况组织；区分已完成、进行中与计划。答辩用途不等于必须套论文实验结构，计划不能写成已取得成果。',
  teaching:'教学讲解：从学习目标和必要先备知识进入核心概念，再由浅入深组织原理、步骤、已有例子或应用与归纳；有真实先后依赖时按依赖排序。练习仅在用户要求或材料已有时安排，不编造案例或参考答案。',
  report:'工作或经营汇报：先交代汇报范围和关键进展，再按工作主题组织目标、行动、实际指标或成果及必要对照，最后呈现材料已有的后续安排；保留时间与统计口径，不补造指标、行动计划或成绩。',
  pitch:'商业计划或路演：仅在用户明确此用途时，按受众决策需要组织问题与目标客户、产品方案、市场或竞争依据、商业模式、已有进展及用户要求的资源诉求；各模块以材料支持为前提，不补造规模、收入、预测、团队或融资要求。',
  mixed:'混合任务：依据用户明确的主次目标组合上述叙述顺序，以同一条主线连接；不要把每种任务模板完整串接成重复章节。',
  general:'一般说明：按材料实际内容和受众理解依赖安排主题，选择时间顺序、流程、比较或总分结构；不因文件格式是论文、报告或计划书就推断演示任务。'
};
export const taskArrangementRule='按任务编排：先理解用户实际用途，再选择taskType；根据语义和主次目标判断，不按关键词或材料文件类型硬分类。用户明确的页序与重点优先，以下是可调整的组织依据，不是必须补齐的栏目；缺少材料支持的模块应省略，不为套模板补事实。\n'+Object.entries(taskArrangementGuides).map(([type,rule])=>type+'：'+rule).join('\n');
export const deckArrangementRule='全篇编排：先预留已选封面、目录和致谢，再把剩余页数分给目标相关内容；单页模式遵守独立页面设置。按任务重要性、信息量与理解难度分配页数，不按文件数、章数或章节进度段数均分。章节包含相邻相关页，先总览后展开、先必要概念后方法细节；需要先给结论的决策汇报可先呈现有材料支撑的结论，再展开依据。时间、因果和包含关系必须有材料依据，承接只用于组织，不额外写成套话正文。同一事实或论点优先归属最能说明它的一页；总览与详解可以复用必要名词，但后页须增加不同信息，不反复抄写相同分点和整组数据。目录对应实际主题与顺序，不把目录条目强制做成章节过渡页；章节页仅在用户要求或长篇确需过渡时使用，不为每个导航章节增页。短篇可直接进入主题，不强加背景或总结；结尾仅归纳已有信息，不新增未要求的展望或行动建议。已选内容不足以填满目标页数时，优先拆分已有方法、步骤、比较或成果，保证每页有独立信息，不用宽泛背景、重复总结、空过渡或额外致谢凑页数；材料确实不足时只在制作缺口中说明，不将缺口制成页面，不虚构内容。页数紧张时合并相关主题并压缩重复与辅助叙述，保留用户指定内容和选用事实的必要条件。';
export const pageScopeRule='单页内容范围：scope.question规定本页唯一要回答的问题，mustInclude列出本页必须呈现的独立信息，doNotExpand列出明确排除或交给其他页展开的内容，无则空数组。正文围绕该问题，只从本页分配的材料与证据块组织必含信息及必要解释，不因材料还有其他内容、页标题宽泛或版面有空间而扩写其他主题；不展开项不进入正文或讲稿。不得把question、mustInclude、doNotExpand等制作说明直接抄到页面。封面、目录、章节、致谢只写其实际功能与允许文字，不强加结论、数据或问答文案。';
export const contentPlanningRules=[contentGoalRule,contentSelectionRule,contentEmphasisRule,taskArrangementRule,deckArrangementRule].join('\n');

function requiredText(value,label,max=800){
  if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'须为非空简短文字');
  return value.trim();
}
function textList(value,label,{required=false}={}){
  if(!Array.isArray(value)||value.length>12||required&&!value.length)throw Error(label+'须为简短文字数组'+(required?'且不得为空':''));
  return [...new Set(value.map(item=>requiredText(item,label,300)))];
}
export function validateContentIntent(raw){
  if(!raw||!Object.hasOwn(taskArrangementGuides,raw.taskType))throw Error('全篇规划须依据实际任务选择有效taskType');
  return {taskType:raw.taskType,goal:requiredText(raw.goal,'全篇制作目标'),focus:textList(raw.focus,'全篇重点',{required:true}),exclude:textList(raw.exclude,'全篇排除范围')};
}
export function validatePageScope(raw){
  if(!raw)throw Error('每页规划须明确scope内容范围');
  return {question:requiredText(raw.question,'本页问题',300),mustInclude:textList(raw.mustInclude,'本页必含信息',{required:true}),doNotExpand:textList(raw.doNotExpand,'本页不展开内容')};
}
export function contentPageTaskPrompt(spec,index,plan,intent){
  const neighbor=page=>page?{title:page.title,question:page.scope.question}:null;
  const task={page:index+1,total:plan.length,...spec,deckIntent:intent,previous:neighbor(plan[index-1]),next:neighbor(plan[index+1]),outline:plan.map(page=>({kind:page.kind,title:page.title,question:page.scope.question,...(page.progressSectionId?{progressSectionId:page.progressSectionId}:{})}))};
  return '当前任务（只返回本页）：'+JSON.stringify(task)+'\n本次任务编排依据：'+taskArrangementGuides[intent.taskType]+'\n'+contentGoalRule+'\n'+contentSelectionRule+'\n'+pageScopeRule+'\n遵守deckIntent的目标、重点与排除范围，本页scope不得突破全篇范围。全篇提纲与相邻页范围仅用于承接、目录及避免重复，不扩展本页scope。';
}
