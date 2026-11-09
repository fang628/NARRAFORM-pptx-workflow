// Small XML tree for safe geometry edits. Network/entity resolution is never used.
const decode=s=>s.replace(/&(?:amp|lt|gt|quot|apos);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[x]));
export const escapeXML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function parseSVGTree(svg){
  if(typeof svg!=='string'||svg.length>180000||/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(svg))throw Error('SVG XML无效');
  const root={name:'#root',attrs:{},children:[]},stack=[root];
  for(const token of svg.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g)){
    const text=token[0];if(text.startsWith('<!--')||text.startsWith('<?'))continue;
    if(!text.startsWith('<')){if(text.trim())stack.at(-1).children.push({name:'#text',text:decode(text)});continue;}
    const close=text.match(/^<\/([\w:-]+)\s*>$/);if(close){if(stack.at(-1).name!==close[1])throw Error('SVG XML层级不匹配');stack.pop();continue;}
    const m=text.match(/^<([\w:-]+)\b/);if(!m)throw Error('SVG XML标签无效');
    const attrs=Object.fromEntries([...text.slice(m[0].length).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(a=>[a[1],decode(a[2]??a[3])]));
    const node={name:m[1],attrs,children:[],selfClosing:/\/\s*>$/.test(text)};stack.at(-1).children.push(node);if(!node.selfClosing)stack.push(node);if(stack.length>80)throw Error('SVG层级过深');
  }
  if(stack.length!==1||root.children.length!==1||root.children[0].name!=='svg')throw Error('SVG须有单一根节点');return root.children[0];
}
export function serializeSVGTree(node){if(node.name==='#text')return escapeXML(node.text);const attrs=Object.entries(node.attrs).map(([k,v])=>' '+k+'="'+escapeXML(v)+'"').join('');return node.children.length||node.selfClosing===false?'<'+node.name+attrs+'>'+node.children.map(serializeSVGTree).join('')+'</'+node.name+'>':'<'+node.name+attrs+'/>';}
export function walkSVG(node,visitor,parents=[]){visitor(node,parents);for(const child of node.children||[])walkSVG(child,visitor,[...parents,node]);}
export const multiplyMatrix=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
export function svgTransform(value=''){
  const valid=/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  if(value.replace(valid,'').replace(/[\s,]/g,''))throw Error('不支持的SVG变换');
  let m=[1,0,0,1,0,0];for(const a of value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)){
    const n=a[2].trim().split(/[\s,]+/).map(Number);if(!n.every(Number.isFinite))throw Error('SVG变换无效');let t;
    if(a[1]==='rotate'&&![1,3].includes(n.length)||['translate','scale'].includes(a[1])&&![1,2].includes(n.length)||['skewX','skewY'].includes(a[1])&&n.length!==1)throw Error('SVG变换参数数量无效');
    if(a[1]==='matrix'){if(n.length!==6)throw Error('SVG矩阵无效');t=n;}
    else if(a[1]==='translate')t=[1,0,0,1,n[0],n[1]??0];else if(a[1]==='scale')t=[n[0],0,0,n[1]??n[0],0,0];
    else if(a[1]==='rotate'){const angle=n[0]*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),x=n[1]??0,y=n[2]??0;t=[c,s,-s,c,x-c*x+s*y,y-s*x-c*y];}
    else t=a[1]==='skewX'?[1,0,Math.tan(n[0]*Math.PI/180),1,0,0]:[1,Math.tan(n[0]*Math.PI/180),0,1,0,0];m=multiplyMatrix(m,t);
  }return m;
}
