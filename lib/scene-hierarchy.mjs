import {applyLayerInventory} from './overlap-layers.mjs';

const area=e=>Math.max(0,e.w)*Math.max(0,e.h);
const contains=(a,b)=>a.x<=b.x+4&&a.y<=b.y+4&&a.x+a.w>=b.x+b.w-4&&a.y+a.h>=b.y+b.h-4;
const carrier=e=>['shape','rect','ellipse'].includes(e.type)&&!e.managed&&e.role!=='effect'&&!e.effectOf;

// Visual containment is distinct from content-tree parentage. Keep explicit front/back evidence.
export function arrangeScene(elements,{inventory=[]}={}){
  const list=elements.map(element=>({...element})),byKey=new Map(list.map(element=>[element.key,element]));
  const edges=new Map(list.map(element=>[element.key,new Set()]));
  for(const item of inventory||[])if(edges.has(item.key))for(const back of item.frontOf||[])if(byKey.has(back))edges.get(item.key).add(back);
  const parents=list.filter(element=>carrier(element)&&area(element)>6000);
  for(const element of list){
    if(element.managed)continue;
    const explicit=byKey.get(element.parentKey);
    const parent=explicit&&explicit.key!==element.key&&area(explicit)>area(element)*1.15&&contains(explicit,element)?explicit:parents.filter(other=>other.key!==element.key&&area(other)>area(element)*1.15&&contains(other,element))
      .sort((a,b)=>area(a)-area(b))[0];
    if(parent&&!edges.get(parent.key).has(element.key)){
      element.parentKey=parent.key;edges.get(element.key).add(parent.key);
    }else delete element.parentKey;
  }
  for(const band of list.filter(element=>element.role==='title-band')){
    for(const text of list.filter(element=>['text','formula','image'].includes(element.type)&&contains(band,element))){
      // A generated carrier must sit behind all of its foreground content.
      edges.get(band.key).delete(text.key);edges.get(text.key).add(band.key);
    }
  }
  const normalized=[...edges].filter(([,back])=>back.size).map(([key,back])=>({key,frontOf:[...back]}));
  const ordered=applyLayerInventory(list,normalized,{allowUncertainGeometry:true});
  return ordered.elements.map(element=>({...element,memberKeys:ordered.elements.filter(child=>child.parentKey===element.key).map(child=>child.key)}));
}

export function foregroundVisibilityIssues(elements){
  const issues=[];
  for(const [index,element]of elements.entries()){
    if(!['text','formula'].includes(element.type)||element.managed)continue;
    const covering=elements.slice(index+1).find(other=>carrier(other)&&contains(other,element)
      && (other.opacity??1)*(other.fillOpacity??1)>=.8&&other.fill);
    if(covering)issues.push({key:element.key,kind:'covered-content',covering:covering.key});
  }
  return issues;
}

export function fitContentToParents(elements){
  // Independent bullets cannot move canonical text. Only an explicitly fitted
  // carrier may move content attached to that carrier.
  const anchors=new Map(elements.filter(element=>carrier(element)&&element.type!=='ellipse').flatMap(element=>(element.geometryEvidence?.children||[]).map(anchor=>[anchor.key,anchor])));
  const anchored=elements.map(element=>{
    if(element.objectIdentity?.component)return element;
    const anchor=anchors.get(element.key);
    if(!anchor||Math.abs(element.x-anchor.x)>1||Math.abs(element.y-anchor.y)>1
      ||Math.abs(anchor.dx)>160||Math.abs(anchor.dy)>80)return element;
    return {...element,x:element.x+anchor.dx,y:element.y+anchor.dy};
  });
  const arranged=arrangeScene(anchored),byKey=new Map(arranged.map(e=>[e.key,e]));
  return arranged.map(element=>{
    if(element.objectIdentity?.component)return element;
    if(!['text','formula'].includes(element.type)||element.managed)return element;
    if(element.tableAlignment?.version)return element;
    let parent=byKey.get(element.parentKey);
    if(!parent){
      // Audit text boxes can overhang their carrier even when the actual text is short.
      parent=arranged.filter(other=>carrier(other)&&area(other)>area(element)*2
        &&element.x>=other.x&&element.x<other.x+other.w&&element.y>=other.y&&element.y+element.h<=other.y+other.h
        &&other.x+other.w-element.x>=element.w*.7).sort((a,b)=>area(a)-area(b))[0];
    }
    // A short heading whose original box has room for only one text row must
    // not be "fixed" later by growing into the next content band.
    const singleHeading=element.type==='text'&&['title','page-title','subtitle','heading'].includes(element.role)
      &&!String(element.text).includes('\n')&&element.h<=element.size*1.65;
    if(singleHeading)element={...element,noWrap:true};
    if(!parent)return element;
    const available=parent.x+parent.w-12-element.x;
    return available>=element.size*3&&element.w>available?{...element,parentKey:parent.key,w:available}:{...element,parentKey:parent.key};
  });
}

export function contentSafeAreas(elements){
  const byKey=new Map(elements.map(element=>[element.key,element]));
  return Object.fromEntries(elements.filter(element=>byKey.has(element.parentKey)).map(element=>{
    if(element.tableAlignment?.version){const a=element.tableAlignment;return[element.key,{x:a.left+1,y:a.top+1,w:a.right-a.left-2,h:a.bottom-a.top-2}];}
    const parent=byKey.get(element.parentKey),inset=element.tableRole==='cell'?3:8;
    return [element.key,{x:parent.x+inset,y:parent.y+inset,w:parent.w-2*inset,h:parent.h-2*inset}];
  }));
}
