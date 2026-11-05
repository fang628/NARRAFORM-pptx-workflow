import {renderInlineText} from './inline-text.js';
import {renderMathText} from './math-markup.js';
import {bindFormulaEditors} from './formula-editor.js';
const rich=value=>/<\/?(?:sup|sub)>|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎]|\$[^\n]+\$|\\[([]/.test(value);
export function bindInlineTextEditors(root){
  for(const field of root.querySelectorAll('.tree-inline-text,.tree-caption-inline')){
    if(field.dataset.inlineBound)continue;
    field.dataset.inlineBound='true';
    const wrapper=document.createElement('div');wrapper.className='inline-text-editor';
    field.before(wrapper);wrapper.append(field);
    const preview=document.createElement('div');preview.className='tree-rich-text-preview';preview.tabIndex=0;preview.setAttribute('role','button');preview.setAttribute('aria-label','编辑'+(field.getAttribute('aria-label')||'文字'));
    wrapper.prepend(preview);
    const toolbar=document.createElement('div');toolbar.className='inline-text-tools';
    for(const [tag,label] of [['sup','上标'],['sub','下标']]){
      const button=document.createElement('button');button.type='button';button.className='text-button';button.innerHTML=tag==='sup'?'x<sup>2</sup>':'x<sub>2</sub>';button.setAttribute('aria-label',label);button.disabled=field.disabled;
      button.addEventListener('pointerdown',event=>event.preventDefault());
      button.addEventListener('click',()=>{if(field.disabled)return;const start=field.selectionStart,end=field.selectionEnd;if(start===end)return;field.setRangeText('<'+tag+'>'+field.value.slice(start,end)+'</'+tag+'>',start,end,'select');field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();});
      toolbar.append(button);
    }
    wrapper.append(toolbar);
    const update=()=>{const formatted=rich(field.value);wrapper.classList.toggle('has-rich-text',formatted);preview.hidden=!formatted;preview.innerHTML=formatted?renderMathText(field.value,renderInlineText):'';if(formatted)bindFormulaEditors(preview);};
    const edit=()=>{if(field.disabled)return;wrapper.classList.add('is-editing');field.focus();field.style.height='auto';field.style.height=field.scrollHeight+'px';};
    preview.addEventListener('click',edit);preview.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();edit();}});
    field.addEventListener('focus',()=>wrapper.classList.add('is-editing'));
    wrapper.addEventListener('focusout',event=>{if(!wrapper.contains(event.relatedTarget)){wrapper.classList.remove('is-editing');update();}});
    field.addEventListener('input',update);update();
  }
}
