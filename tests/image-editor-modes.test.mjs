import test from 'node:test';
import assert from 'node:assert/strict';
import {initAIImageEditor} from '../public/provenance.js';

test('底图四种修改方式独立：纯文生图不携带照片，交叉入口显示可用条件',async()=>{
  const previous=globalThis.document,fields=new Map(),calls=[],errors=[];
  const field=key=>{
    if(!fields.has(key))fields.set(key,{id:key.slice(1),value:'',checked:false,disabled:false,dataset:{},style:{},classList:{toggle(){}},handlers:{},textContent:'',setAttribute(){},hasAttribute(){return false;},addEventListener(name,fn){this.handlers[name]=fn;},closest(){return this;}});
    return fields.get(key);
  };
  const dialog={open:false,handlers:{},querySelector:field,addEventListener(name,fn){this.handlers[name]=fn;},showModal(){this.open=true;},close(){this.open=false;}};
  globalThis.document={body:{insertAdjacentHTML(){}},querySelector:()=>dialog};
  try{
    const image={materialId:'bg-a',previewHash:'hash-a',file:'a.png',prompt:'主体：建筑。城市主题，无字底图。',photoReference:{materialId:'photo'}};
    const p={id:'p',brief:{title:'城市更新答辩'},apiReady:true,imageReady:true,imageTaskQueueEnabled:true,themePhotoReferenceEnabled:true,themeAssetsCurrent:true,
      materials:[{id:'photo',name:'街景.png',kind:'image',file:'photo.png',sha256:'photo-hash'}],
      themeAssets:{directions:[{id:'a',styleRegistrationId:'style-a',heroSubject:'城市建筑',assets:{'hero-image':image},promptDrafts:{'hero-image':{revision:1,prompt:image.prompt}}},{id:'b',styleRegistrationId:'style-b',assets:{}}]},
      themeCrossStyleOptions:[{id:'a',name:'当前风格',styleId:'style-a',colors:['#aabbcc']},{id:'b',name:'其他风格',styleId:'style-b',colors:['#ddeeff']}],
      themeAssetPrompts:[{theme:'a',use:'hero-image',revision:1,prompt:image.prompt}]};
    const target={targetType:'theme',theme:'a',use:'hero-image'};
    const editor=initAIImageEditor({getProject:()=>p,busy:()=>false,openAPI:()=>errors.push('API'),onError:e=>errors.push(e),act:async(action,b)=>{
      calls.push({action,...b});
      if(action==='prepareAIImageEdit')p.aiImageEditDrafts={'theme:a:hero-image':{mode:b.imageEditMode,sourceHash:'hash-a',photoMaterialId:b.photoMaterialId||null,revision:1,prompt:'AI 照片重绘最终稿'}};
    }});
    const flush=()=>new Promise(r=>setImmediate(r));
    const click=async key=>{dialog.handlers.click({stopPropagation(){},target:field(key)});await flush();};
    const mode=async name=>{const key='[data-edit-mode="'+name+'"]';field(key).dataset.editMode=name;await click(key);};
    const input=field('#aiEditInstruction');
    const submit=async()=>{field('#aiEditConsent').checked=true;field('#aiImageEditForm').handlers.submit({preventDefault(){},stopPropagation(){}});await flush();};

    editor.open(target);
    assert.equal(field('[data-edit-mode="cross"]').hidden,false);
    assert.equal(field('[data-edit-mode="cross"]').disabled,true);
    assert.equal(field('#aiEditCrossAvailability').hidden,false);
    assert.match(field('#aiEditCrossAvailability').textContent,/另一方向/);
    assert.equal(field('[data-edit-mode="photo"]').hidden,false);
    await mode('redraw');
    assert.equal(field('#aiEditPhotoFields').hidden,true);
    input.value='  纯文生图最终稿，不使用任何照片  ';input.handlers.input();await submit();
    assert.equal(calls.at(-1).imageEditMode,'redraw');assert.equal(calls.at(-1).photoMaterialId,null);
    assert.equal(calls.at(-1).prompt,input.value);assert.equal(calls.at(-1).instruction,undefined);

    editor.open(target);await mode('photo');
    assert.equal(field('#aiEditPhotoFields').hidden,false);
    input.value='照片主体的草稿';await click('#aiEditPrepare');
    assert.equal(calls.at(-1).photoMaterialId,'photo');assert.equal(calls.at(-1).imageEditMode,'redraw');
    assert.equal(input.value,'AI 照片重绘最终稿');
    input.value+='，人工修订';input.handlers.input();await click('#aiEditPromptUndo');
    assert.equal(input.value,'AI 照片重绘最终稿');await submit();
    assert.equal(calls.at(-1).photoMaterialId,'photo');assert.equal(calls.at(-1).photoSourceHash,'photo-hash');
    assert.equal(calls.at(-1).prompt,input.value);
    editor.open(target);await mode('redraw');
    assert.equal(input.value,'  纯文生图最终稿，不使用任何照片  ','文生图和照片重绘分别保留草稿');

    p.themeAssets.directions[1].assets['hero-image']={materialId:'bg-b',previewHash:'hash-b',file:'b.png'};
    editor.open(target);assert.equal(field('[data-edit-mode="cross"]').disabled,false);
    assert.equal(field('#aiEditCrossAvailability').hidden,true);
    field('#aiEditCrossTarget').value='b';await mode('cross');
    assert.equal(field('#aiEditCrossFields').hidden,false);assert.equal(field('#aiEditPhotoFields').hidden,true);
    input.value='保持本方向色调，借用另一方向构图';await submit();
    assert.equal(calls.at(-1).theme,'a');assert.equal(calls.at(-1).crossStyleSource.theme,'b');
    assert.equal(calls.at(-1).crossStyleTargetStyleId,'style-a');assert.equal(calls.at(-1).photoMaterialId,undefined);
    assert.deepEqual(errors,[]);
  }finally{globalThis.document=previous;}
});
