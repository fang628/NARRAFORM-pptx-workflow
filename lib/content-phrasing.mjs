import {plainInlineText} from '../public/inline-text.js';
// 02 copy expression: parallel body items must be information phrases, not a long paragraph
// chopped into complete sentences and laid out as sibling points. Detection is deliberately
// conservative: short labels, data tags, a single complete conclusion and independent points
// are all allowed; only a group of narrative sentences stacked in the same content group is
// treated as flat sentence stacking. Chinese and English drafts are both recognized.
import {initialElements} from './elements.mjs';

export const contentPhrasingRule='并列文案表达：同一父项下的并列正文项优先写信息短语（对象/指标 + 数据 + 单位 + 条件或对照），不用多条完整叙述句平铺堆字；不把同一段长文按标点（。；！？或逗号分句、英文句末 .）直接切成多个并列文本项。只保留一句简短完整的关键核心结论，其余改写为可独立阅读的信息短语；数据用“指标/条件 + 数值 + 单位 + 对照”的紧凑标签。必须保留全部数字、单位、适用条件、来源、独立观点与真实附属说明，附属说明保持原有归属层级，不把必要上屏信息只写进讲稿notes。判断对象是“同一父项下多条完整叙述句/流水句被平铺成并列项”，不是把所有带句号的短项判错：短语标签、数据标签、单个结论句、事实明确的独立短分点都可以保留；公式、引用、表格与用户明确要求完整保留的原文不套用此改写。中英文一致适用：英文并列项同样用信息短语，不把一段英文叙述拆成多个完整句并列；英文小数点（如 3.5）、e.g./i.e./etc./Dr. 等缩写与单字母缩写不是句末。改写只调整表达，在原文本节点上短语化，不按标点机械切句、不删节点合并、不强行删除谓语所表达的事实、不改数字与公式、不拆断术语、不合并或删除独立分点，也不改变主副标题归属与多层关系。';

const visibleLength=value=>Array.from(plainInlineText(value).replace(/\s/g,'')).length;
const clausePattern=/[，、；,;]/g;
// Continuation words mark sentences that continue one paragraph rather than independent points.
const narrativeConnective=/因此|因而|所以|同时|此外|另外|并且|而且|然而|但是|由于|随着|从而|进而|使得|其中|上述|总体|最终|最后|随后|然后|一方面|另一方面|综上|据此|可见|这意味着|\b(?:therefore|however|moreover|furthermore|thus|hence|in addition|as a result|because|since|while|whereas|although|overall|meanwhile|consequently|also|then)\b/i;
const narrativePredicate=/表明|说明|体现|显示|需要|可以|能够|提升|提高|降低|增加|减少|增长|下降|保持|达到|实现|构成|形成|成为|具有|属于|导致|带来|支持|保证|确保|意味着|代表|取决于|依赖于|来源于|受益于|有效|显著|\b(?:show|shows|showed|indicate|indicates|indicated|suggest|suggests|suggested|improve|improves|improved|increase|increases|increased|decrease|decreases|decreased|remain|remains|remained|achieve|achieves|achieved|demonstrate|demonstrates|demonstrated|result|results|resulted|provide|provides|provided|require|requires|required|reduce|reduces|reduced|reach|reaches|reached|grow|grew|grows|rise|rose|rises|drop|drops|dropped|maintain|maintains|maintained)\b/i;
const continuationStart=/^(这|该|其|此|上述|因此|因而|所以|同时|此外|另外|并且|而且|然而|但是|由于|随着|从而|进而|使得|其中|最终|最后|随后|然后|一方面|另一方面|综上|据此|可见|(?:this|these|that|it|therefore|however|moreover|furthermore|thus|hence|in addition|as a result|because|since|meanwhile|also|then|overall|finally))\b/i;

// English sentence periods only count when they are real sentence ends: decimal points,
// ellipses, common abbreviations and single-letter initials never split a sentence.
const englishAbbreviations=new Set(['eg','ie','etc','vs','fig','figs','eq','eqs','no','nos','dr','mr','mrs','ms','prof','al','approx','cf','ref','refs','sec','sect','inc','ltd','co','jr','sr','st','min','max','tab','resp','dep','vol','pp','ed','eds','us','uk','eu','un','jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec']);
const precedingWord=before=>{const match=before.match(/([A-Za-z]+(?:\.[A-Za-z]+)*)$/);return match?match[1].toLowerCase().replace(/\./g,''):'';};
export function chineseSentenceCount(text){return (String(text||'').match(/[。！？!?]+/g)||[]).length;}
export function englishSentenceCount(text){
  const value=String(text||'');let count=0;
  for(let index=value.indexOf('.');index>=0;index=value.indexOf('.',index+1)){
    const before=value.slice(Math.max(0,index-16),index),after=value.slice(index+1);
    if(/^\d/.test(value[index-1]||'')&&/^\d/.test(after))continue;
    if(value.slice(Math.max(0,index-2),index)==='..'||after.startsWith('..'))continue;
    if(after&&!/^[\s"')\]},;:!?]/.test(after))continue;
    const token=precedingWord(before);
    if(token&&(englishAbbreviations.has(token)||/^[a-z]$/.test(token)))continue;
    count++;
  }
  return count;
}
export function sentenceCount(text){return chineseSentenceCount(text)+englishSentenceCount(text);}
export function isNarrativeSentence(text){
  const value=String(text||'').trim(),length=visibleLength(value);
  if(!value||length<16)return false;
  const clauses=(value.match(clausePattern)||[]).length,narrative=narrativeConnective.test(value)||narrativePredicate.test(value),chinese=chineseSentenceCount(value),english=englishSentenceCount(value);
  if(chinese)return length>=18||narrative;
  if(english)return length>=30&&value.split(/\s+/).length>=5;
  return length>=28&&clauses>=2&&narrative;
}
// Groups body text nodes by their real parent and returns only stacks that a draft rewrite
// should fix; nested groups are judged separately and a lone conclusion is never an issue.
export function phrasingIssues(slide){
  const groups=new Map();
  for(const node of initialElements(slide)){
    if(node.type!=='text'||(node.role||'body')!=='body')continue;
    const key=node.parentId??null;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(node);
  }
  const issues=[];
  for(const [parentId,items] of groups){
    const narrative=items.filter(item=>isNarrativeSentence(item.text)),sentences=items.reduce((sum,item)=>sum+sentenceCount(item.text),0);
    const packed=items.length===1&&sentences>=2&&visibleLength(items[0].text)>=36&&isNarrativeSentence(items[0].text);
    const stacked=narrative.length>=3&&sentences>=3;
    const splitIntoTwo=narrative.length===2&&items.length===2&&sentences>=4&&narrative.some(item=>continuationStart.test(String(item.text).trim()));
    if(!stacked&&!splitIntoTwo&&!packed)continue;
    issues.push({parentId,ids:narrative.map(item=>item.id),length:narrative.length,sentences,reason:packed?'同一正文项含多个完整叙述句':'同一父项下多条完整叙述句被平铺为并列项',texts:narrative.map(item=>item.text)});
  }
  return issues;
}
