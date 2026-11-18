// Apply while selecting and writing content, never to rewrite confirmed slides.
import {topicCopyRule,naturalCopyRule} from './content-copy-policy.mjs';
export const contentEmphasisRule='全篇内容规划围绕用户实际任务及材料支持的核心对象、问题、过程与结果展开；技术路线、方法、成果、优势与特点按任务需要选用，不作为所有演示的固定栏目。材料中已有且服务本次任务的限制、风险、问题及反向结果应按原意编排，不要求用户另行点名；不能为突出成果删掉必要限定或把负向数据改写为正面成果。不主动评价材料本身的科学有效性，不补造材料没有的优势、风险或批评；材料分析中的内部读取问题与核对事项不编入页面主题、正文或讲稿。questions仅用于影响制作的材料读取、引用定位或任务输入缺失，不用于评价材料观点。';

export const contentGoalRule='目标先行：上传材料下方的补充文字是主要制作意图，据此确定本次演示要回答的问题、受众需要知道什么、重点与排除范围；用户确认纠正同样参与取舍。主题、听众、用途、页数和页型是制作约束。补充文字为空时，结合表单和材料归纳目标，不猜测融资、商业化、教学或风险评估等未表达的任务。用户提示不是材料，不为其创建材料id或证据；事实仍须来自材料。';
export const contentSelectionRule='选材边界：完整理解与保留材料不等于全部上屏。仅选直接服务本次目标或理解所必需的信息，材料有依据不等于应该进入PPT；以相关、必要、有材料支持为取舍依据，不逐文件轮流汇报，不要求每份材料或每个原文章节各占一页。摘要、附录、参考文献、作者履历、操作说明及其他项目内容不自动成页，用户要求或本次任务确需时再选用；必要引用和选用信息的数值、单位、条件、对照与来源仍保留。内部读取问题、核对事项及模型用途建议不能变成页面主题或正文。未选范围只留在原材料与索引，不为证明完整性补入页面。';

export const taskArrangementGuides={
  research:'研究汇报或学术答辩：以研究问题为起点，用必要背景和已有工作说明研究缺口，再展开方法、结果与讨论，最终回应问题并归纳贡献和结论；重点页数留给方法和结果，必要限制与反向结果随证据说明。没有实验数据不补实验章，论文讲解不伪装为用户自己的研究成果。',
  product:'产品或技术介绍：先让听众明白是什么、解决什么问题，再用整体能力建立认识，展开工作方式与关键特点，最后以材料已有的应用和价值回应开场用途；基础概念先于细节。不自动加入市场规模、融资、商业模式或竞品评价。',
  project:'项目介绍或成果答辩：从目标与要求进入整体方案，再突出关键实现，以实际成果与验证回答是否完成目标，最后归纳完成情况；分工只在与任务有关时安排。区分已完成、进行中与计划，答辩不等于必须套论文实验结构，计划不能写成已取得成果。',
  teaching:'教学或知识讲解：以学习目标或引入问题建立学习动机，按必要概念、原理与步骤、已有示例或应用逐层展开，最后归纳所学并回应起点；按理解依赖由浅入深。练习仅在用户要求或材料已有时安排，不编造案例或参考答案。',
  report:'工作、经营或决策汇报：结论先行，先说明核心结论或当前状态及必要汇报范围，再给关键依据，展开材料已有的问题与原因，最后落到任务需要且有依据的行动或决策；让听众先知道重点，再理解为什么。保留时间与统计口径，不补造指标、因果、行动计划或成绩。',
  pitch:'商业计划或路演：仅在用户明确此用途时，先提出机会或痛点，再给解决方案，用市场与竞争依据说明机会，以商业模式和已有进展解释可行性，最后按任务需要呈现团队及资源诉求；各模块以材料支持为前提，不补造规模、收入、预测、团队或融资要求。',
  mixed:'混合任务：依据用户明确的主次目标组合上述叙述顺序，以同一条主线连接；不要把每种任务模板完整串接成重复章节。',
  general:'一般说明：按材料实际内容和受众理解依赖安排主题，选择时间顺序、流程、比较或总分结构；不因文件格式是论文、报告或计划书就推断演示任务。'
};
export const taskArrangementRule='按任务编排：先理解用户实际用途，再选择taskType；根据语义和主次目标判断，不按关键词或材料文件类型硬分类。任务类型决定叙事逻辑，不只是章节列表；汇报可结论先行，教学按理解依赖，研究围绕问题与证据。用户明确的页序与重点优先，以下是可调整的组织依据，不是必须补齐的栏目；缺少材料支持的模块应省略，不为套模板补事实。\n'+Object.entries(taskArrangementGuides).map(([type,rule])=>type+'：'+rule).join('\n');
export const deckArrangementRule='全篇编排顺序：按实际任务选择叙事逻辑，建立贯穿开场、展开、收束的主线，再分配各部分页数，明确每页主要表达任务，提交前自查递进、重复及必要铺垫，不增加独立审核请求。封面之后尽快让听众知道讲什么、为什么与其有关；中间按所选任务组织论述层次和必要过渡，不统一强制先总览后展开或先依据后结论。结尾回应开头的目标或问题，归纳材料已有的关键信息或任务需要的行动决策，不复述目录、不新增未支持的展望；致谢不能替代内容收束，短篇可在最后一张内容页收束，不必额外加总结页。先预留已选封面、目录和致谢，剩余页数按重要性、信息量与理解难度分配，不按文件数、章数或导航段数均分；单页模式遵守独立页面设置。相关页面连续编排，时间、因果和包含关系必须有材料依据，承接不写成套话正文。同一事实或论点优先归属最能说明它的一页，总览与详解只复用必要名词，后页须增加不同信息，不重复相同分点和整组数据。目录对应实际主题与顺序，不强制逐条新增过渡页；章节页仅在用户要求或长篇确需过渡时使用，不为导航增页。内容不足时优先拆分已有方法、步骤、比较或成果，不用宽泛背景、重复总结、空过渡凑页数；材料确实不足时在制作缺口中说明，不制成页面或虚构内容。页数紧张时合并相关主题并压缩重复和辅助叙述，保留用户指定内容及选用事实的必要条件。';
export const pageExpressionRule='每页承担一个主要表达任务，有一个明确中心；可以提出问题、解释概念、展示流程、比较方案或呈现结论，不强制转成问答。页面标题按任务选主题型或结论型，不统一要求问句或完整结论句；结论型表达必须有材料支持。';
export const pageScopeRule='单页内容范围：'+pageExpressionRule+'scope.question沿用兼容字段名，填写本页主要表达任务或功能描述，不要求是问题；mustInclude列出必须呈现的独立信息，doNotExpand列出明确排除或交给其他页展开的内容，无则空数组。正文围绕该任务，只从本页分配的材料与证据块组织必含信息及必要解释，不因材料还有其他内容、标题宽泛或版面有空间而扩写其他主题；不展开项不进入正文或讲稿。不得把question、mustInclude、doNotExpand等制作说明直接抄到页面。封面、目录、章节、致谢只写其实际功能与允许文字，不强加结论、数据或问答文案。';
export const contentPlanningRules=[contentGoalRule,contentSelectionRule,contentEmphasisRule,taskArrangementRule,deckArrangementRule,topicCopyRule,naturalCopyRule].join('\n');

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
  return {question:requiredText(raw.question,'本页表达任务',300),mustInclude:textList(raw.mustInclude,'本页必含信息',{required:true}),doNotExpand:textList(raw.doNotExpand,'本页不展开内容')};
}
export function contentPageTaskPrompt(spec,index,plan,intent){
  const neighbor=page=>page?{title:page.title,question:page.scope.question}:null;
  const task={page:index+1,total:plan.length,...spec,deckIntent:intent,previous:neighbor(plan[index-1]),next:neighbor(plan[index+1]),outline:plan.map(page=>({kind:page.kind,title:page.title,question:page.scope.question,...(page.progressSectionId?{progressSectionId:page.progressSectionId}:{})}))};
  return '当前任务（只返回本页）：'+JSON.stringify(task)+'\n本次任务编排依据：'+taskArrangementGuides[intent.taskType]+'\n'+contentGoalRule+'\n'+contentSelectionRule+'\n'+pageScopeRule+'\n遵守deckIntent的目标、重点与排除范围，本页scope不得突破全篇范围。全篇提纲与相邻页范围仅用于承接、目录及避免重复，不扩展本页scope。objective、scope、材料角色、关系解释及用途建议是内部写作依据，不直接充当标题、副标题或正文。';
}
