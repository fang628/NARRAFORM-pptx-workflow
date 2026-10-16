import test from 'node:test';
import assert from 'node:assert/strict';
import {initAIImageEditor} from '../public/provenance.js';

test('底图和三版预览共用三模式单输入弹窗，保留当前方向风格并参考其他方向结构，结果与撤回均指向当前图片',async()=>{
  const original=globalThis.document,fields=new Map(),calls=[],errors=[];let html='';
  const field=id=>{if(!fields.has(id))fields.set(id,{id:id.slice(1),value:'',checked:false,disabled:false,dataset:{},handlers:{},setAttribute(){},hasAttribute(){return false;},addEventListener(n,fn){this.handlers[n]=fn;},closest(){return this;}});return fields.get(id);};
  const dialog={open:false,handlers:{},querySelector:field,addEventListener(n,fn){this.handlers[n]=fn;},showModal(){this.open=true;},close(){this.open=false;}};
  globalThis.document={body:{insertAdjacentHTML(_,v){html=v;}},querySelector:()=>dialog};
  try{
    const image=id=>({materialId:id,previewHash:'hash-'+id,jobFile:id+'.json',normalized:id+'.png',prompt:'完整提示词',editHistory:{past:[{previewHash:'previous'}],future:[]}});
    const styles=['a','b'].map(id=>({id,styleId:'style-'+id,name:'方向'+id,background:'浅灰色',colors:['浅灰色','深蓝色']}));
    const p={id:'p',apiReady:true,imageReady:true,aiImageUndo:true,imageTaskQueueEnabled:true,themeAssetsCurrent:true,themeCrossStyleOptions:styles,previewCrossStyleOptions:styles,
      themeAssets:{directions:['a','b'].map(id=>({id,name:id,styleRegistrationId:'style-'+id,assets:{'hero-image':image(id)}}))},themeAssetPrompts:['a','b'].map(theme=>({theme,use:'hero-image',revision:1,prompt:'完整提示词'})),
      concepts:['a','b'].map(id=>({id,styleRegistrationId:'style-'+id,representatives:[{...image('preview-'+id),index:1}]}))};
    const editor=initAIImageEditor({getProject:()=>p,busy:()=>false,openAPI(){},onError:e=>errors.push(e),act:async(action,b)=>{
      calls.push({action,...b});if(action==='restoreAIImage')p.themeAssets.directions[0].assets['hero-image']={...image('a'),previewHash:'restored',jobFile:'restored.json'};
    }});
    const flush=()=>new Promise(r=>setImmediate(r)),click=async id=>{dialog.handlers.click({stopPropagation(){},target:field(id)});await flush();};
    field('[data-edit-mode="cross"]').dataset.editMode='cross';field('[data-edit-mode="adjust"]').dataset.editMode='adjust';
    editor.open({targetType:'theme',theme:'a',use:'hero-image'});field('#aiEditCrossTarget').value='b';await click('[data-edit-mode="cross"]');
    assert.equal((html.match(/<textarea\b/g)||[]).length,1);assert.ok(html.includes('data-edit-mode="cross"'));assert.equal(field('#aiEditCrossFields').hidden,false);assert.match(field('#aiEditCrossDestination').textContent,/当前方向 A/);assert.match(field('#aiEditCrossPrompt').textContent,/目标风格：方向a/);
    field('#aiEditInstruction').value='降低反光';field('#aiEditInstruction').handlers.input();assert.match(field('#aiEditCrossPrompt').textContent,/降低反光/);
    await click('[data-edit-mode="adjust"]');assert.equal(field('#aiEditCrossFields').hidden,true);await click('[data-edit-mode="cross"]');assert.equal(field('#aiEditInstruction').value,'降低反光');
    await click('#aiEditImageUndo');assert.equal(calls.at(-1).theme,'a');assert.equal(calls.at(-1).sourceHash,'hash-a');assert.equal(p.themeAssets.directions[1].assets['hero-image'].previewHash,'hash-b');
    field('#aiEditConsent').checked=true;field('#aiImageEditForm').handlers.submit({preventDefault(){},stopPropagation(){}});await flush();assert.equal(calls.at(-1).action,'generateThemeAsset');assert.equal(calls.at(-1).theme,'a');assert.equal(calls.at(-1).crossStyleSource.theme,'b');assert.equal(calls.at(-1).crossStyleTargetHash,'restored');
    editor.open({targetType:'visual',kind:'concept',theme:'a',index:1});field('#aiEditCrossTarget').value='b';await click('[data-edit-mode="cross"]');
    assert.match(field('#aiEditCrossPrompt').textContent,/保留全部文字与图注/);assert.doesNotMatch(field('#aiEditCrossPrompt').textContent,/不含文字/);
    field('#aiEditConsent').checked=true;field('#aiImageEditForm').handlers.submit({preventDefault(){},stopPropagation(){}});await flush();assert.equal(calls.at(-1).action,'generateConceptPage');assert.equal(calls.at(-1).index,1);assert.equal(calls.at(-1).theme,'a');assert.equal(calls.at(-1).crossStyleSource.theme,'b');assert.equal(calls.at(-1).imageEditMode,undefined);assert.deepEqual(errors,[]);
  }finally{globalThis.document=original;}
});
