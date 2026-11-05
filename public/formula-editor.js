import {formulaLatex,formulaMarkdown} from './formula-content.js';
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let library;
const snippets=[['分数','\\frac{#0}{#?}'],['上下标','x_{#0}^{#?}'],['根式','\\sqrt{#0}'],['求和','\\sum_{i=1}^{n} #0'],['积分','\\int_{a}^{b} #0\\,dx'],['矩阵','\\begin{pmatrix}#0 & #?\\\\#? & #?\\end{pmatrix}']];
export function formulaEditorMarkup(n){
  return `<div class="tree-formula-editor"><math-field aria-label="可视化编辑公式" virtual-keyboard-mode="manual">${h(n.latex)}</math-field><div class="formula-tools">${snippets.map(([label,latex])=>`<button type="button" class="text-button" data-formula-insert="${h(latex)}">${label}</button>`).join('')}</div><details class="formula-source"><summary>Markdown 公式</summary><textarea data-formula-source aria-label="Markdown公式源代码" rows="4" maxlength="4020" spellcheck="false">${h(formulaMarkdown(n))}</textarea></details><span class="formula-edit-state" role="status"></span></div>`;
}
export function collectFormula(row,n){
  const source=row.querySelector('[data-formula-source]');
  try{const latex=formulaLatex(source?.value??n);return {latex,markdown:formulaMarkdown(latex)};}
  catch{return {latex:String(source?.value||'').trim().replace(/^\$\$\s*|\s*\$\$$/g,''),markdown:source?.value||''};}
}
export async function bindFormulaEditors(root){
  const editors=[...root.querySelectorAll('.tree-formula-editor')],previews=[...root.querySelectorAll('math-field[read-only]')];if(!editors.length&&!previews.length)return;
  try{
    library??=import('/vendor/mathlive/mathlive.min.mjs').then(module=>{module.MathfieldElement.fontsDirectory='/vendor/mathlive/fonts';module.MathfieldElement.soundsDirectory=null;module.MathfieldElement.locale='zh-CN';return module;}).catch(error=>{library=null;throw error;});
    await library;
    await customElements.whenDefined('math-field');
    for(const field of previews){
      if(!field.isConnected||field.dataset.formulaBound)continue;
      field.readOnly=true;field.mathVirtualKeyboardPolicy='manual';
      field.setValue(formulaLatex(field.dataset.formulaLatex||field.textContent),{silenceNotifications:true});
      field.dataset.formulaBound='true';
    }
    for(const editor of editors){
      if(!editor.isConnected)continue;
      const field=editor.querySelector('math-field'),source=editor.querySelector('[data-formula-source]'),state=editor.querySelector('.formula-edit-state');
      field.readOnly=source.disabled;
      let initial='';try{initial=formulaLatex(source.value);}catch(error){state.textContent=error.message;editor.querySelector('.formula-source').open=true;}
      field.setValue(initial,{silenceNotifications:true});
      if(editor.dataset.restoreFocus){delete editor.dataset.restoreFocus;field.focus();if(editor.formulaSelection)field.selection=editor.formulaSelection;delete editor.formulaSelection;}
      if(editor.dataset.bound)continue;editor.dataset.bound='true';field.mathVirtualKeyboardPolicy='manual';
      let updating=false;
      field.addEventListener('input',()=>{
        if(updating||source.disabled)return;
        const latex=field.getValue('latex');source.value='$$\n'+latex+'\n$$';
        try{formulaLatex(latex);state.textContent='';}catch(error){state.textContent=error.message;}
        // Notify the form without feeding our own update back into setValue(),
        // which resets the caret inside fractions and superscripts on each key.
        updating=true;try{source.dispatchEvent(new Event('input',{bubbles:true}));}finally{updating=false;}
      });
      source.addEventListener('input',()=>{if(updating)return;try{updating=true;field.setValue(formulaLatex(source.value),{silenceNotifications:true});state.textContent='';}catch(error){state.textContent=error.message;}finally{updating=false;}});
      editor.addEventListener('click',event=>{const button=event.target.closest('[data-formula-insert]');if(!button||source.disabled)return;field.focus();field.insert(button.dataset.formulaInsert);});
    }
  }catch{
    for(const editor of editors){editor.querySelector('.formula-source').open=true;editor.querySelector('.formula-edit-state').textContent='可视化编辑器暂不可用，可直接编辑Markdown公式';}
  }
}
