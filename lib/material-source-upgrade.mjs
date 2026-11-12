import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Upgrade only a previously truncated extraction, without altering approved OCR.
// The old source must be an exact prefix so existing evidence offsets stay valid.
export async function upgradeMaterialSource(material,{root,data,projectId,run,signal,save=()=>{}}){
  if(!material.truncated||material.extractionVersion>=2||material.textRecovery||material.ocrTextApprovedAt||material.ocr?.approvedAt||!material.file)return false;
  const directory=path.resolve(data,projectId,'assets'),source=path.resolve(directory,material.file);
  if(!source.startsWith(directory+path.sep))throw Error('原材料路径越出assets，停止扩展读取');
  if(!fs.existsSync(source))return false;
  if(material.sha256&&crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')!==material.sha256)throw Error('原材料文件哈希不一致，停止扩展读取并保留已有原文');
  const python=process.env.PPT_AGENT_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const result=JSON.parse((await run(python,[path.join(root,'tools','extract.py'),source],{signal,windowsHide:true,timeout:120000,maxBuffer:64e6})).stdout);
  signal?.throwIfAborted();
  if(result.error)throw Error(result.error);
  if(!String(result.text||'').startsWith(material.text||''))throw Error('扩展原文与已登记前文不一致，保留原文及引用，请重新上传该材料');
  Object.assign(material,result);save();return true;
}
