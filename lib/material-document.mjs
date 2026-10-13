import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export async function materialDocument(p,m,{root,data,run,save}){
  if(m.richText?.version===1)return {text:m.text,richText:m.richText,truncated:m.truncated};
  if(m.documentView?.richText?.version===1)return m.documentView;
  if(!/\.(docx|pdf|md)$/i.test(m.file||''))return {text:m.text||''};
  const dir=path.join(data,p.id),input=path.join(dir,'source-format-'+crypto.randomUUID()+'.json');
  const venv=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),python=process.env.PPT_AGENT_PYTHON||(fs.existsSync(venv)?venv:'python');
  fs.writeFileSync(input,JSON.stringify({text:m.text||''}));
  try{
    const r=await run(python,[path.join(root,'tools','extract.py'),path.join(dir,'assets',m.file),input],{maxBuffer:32_000_000,timeout:60000,windowsHide:true});
    const view=JSON.parse(r.stdout);if(view.error)throw Error(view.error);
    // Enrich the reader only; canonical text, material hashes and approvals stay intact.
    if(p.materials.includes(m)){m.documentView=view;save(p);}
    return view;
  }finally{fs.rmSync(input,{force:true});}
}
