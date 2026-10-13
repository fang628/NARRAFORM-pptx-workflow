import crypto from 'node:crypto';
import {scene} from './scene.mjs';
export function reconstructionStamp(p){const theme=p.concepts.find(t=>t.id===p.selectedTheme);return crypto.createHash('sha256').update(JSON.stringify({slides:p.slides,brief:p.brief,theme,materials:p.materials.filter(m=>m.kind==='image').map(m=>({id:m.id,sha256:m.sha256}))})).digest('hex');}
export const reconstructionCurrent=p=>!!p.reconstruction&&p.reconstruction.stamp===reconstructionStamp(p);
export function originalPrimitives(p,index){return scene(p.slides[index],p.concepts.find(t=>t.id===p.selectedTheme),index,p.slides.length,p.brief).map((e,i)=>({...e,key:'el-'+String(i).padStart(3,'0')}));}
export function validateReconstruction(raw,original){
  if(!Array.isArray(raw)||raw.length!==original.length||new Set(raw.map(e=>e.key)).size!==original.length)throw Error('重组必须完整保留全部已登记元素');
  const result=raw.map(e=>{
    const base=original.find(o=>o.key===e.key);if(!base||e.type!==base.type)throw Error('重组元素身份或类型不一致');
    if(base.type==='text'&&e.text!==base.text)throw Error('重组不能改写准确文字');if(base.type==='image'&&e.id!==base.id)throw Error('重组不能替换登记图片');
    const out={...base};for(const k of ['x','y','w','h']){if(typeof e[k]!=='number'||!Number.isFinite(e[k]))throw Error('重组坐标无效');out[k]=e[k];}
    if(out.x<0||out.y<0||out.w<=0||out.h<=0||out.x+out.w>1601||out.y+out.h>901)throw Error('重组元素超出 16:9 页面');
    for(const k of ['fill','color'])if(e[k]!==undefined){if(typeof e[k]!=='string'||!/^[a-f\d]{6}$/i.test(e[k]))throw Error('重组颜色格式无效');out[k]=e[k];}
    if(base.type==='text'){if(typeof e.size!=='number'||e.size<10||e.size>100||e.h<e.size||typeof e.bold!=='boolean')throw Error('重组文字样式无效');out.size=e.size;out.bold=e.bold;}
    return out;
  });return result;
}
