import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const channels=['text','image','elementImage','rebuild'];
// The command is static: credentials travel only through stdin, never arguments.
async function dpapi(operation,bytes,projectId){
  const script=`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$payload=ConvertFrom-Json ([Console]::In.ReadToEnd())
$bytes=[Convert]::FromBase64String($payload.data)
$entropy=[Text.Encoding]::UTF8.GetBytes('ppt-agent-api-v1:'+ $payload.projectId)
$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($result))`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    const chunks=[];let size=0,failed=false;
    const fail=()=>{if(failed)return;failed=true;clearTimeout(timer);child.kill();reject(Error('本机 API 密钥加密存储不可用'));};
    const timer=setTimeout(fail,15000);
    child.on('error',fail);child.stdin.on('error',fail);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>200000)fail();else chunks.push(chunk);});
    child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0)return fail();const output=Buffer.concat(chunks).toString().trim();if(!/^[A-Za-z0-9+/]+={0,2}$/.test(output))return fail();resolve(Buffer.from(output,'base64'));});
    child.stdin.end(JSON.stringify({projectId,data:bytes.toString('base64')}));
  });
}

function normalized(value){
  const result={};
  for(const channel of channels){
    const c=value?.[channel];if(c==null)continue;
    if(typeof c.baseURL!=='string'||typeof c.model!=='string'||typeof c.key!=='string'||!c.key.trim()||c.key.length>2000)throw Error('保存的 API 配置无效');
    result[channel]={baseURL:c.baseURL,model:c.model,key:c.key};
  }
  if(!result.text)throw Error('保存的主模型配置无效');
  return result;
}

export function credentialStore(data){
  const supported=process.platform==='win32';
  const file=id=>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error('项目编号无效');
    const dir=path.join(data,id);
    if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw Error('项目目录无效');
    return path.join(dir,'.api-credentials.dpapi');
  };
  return {
    mode:supported?'windows-dpapi':'memory',
    async save(id,value){
      if(!supported)return;
      const config=normalized(value),destination=file(id);
      const encrypted=await dpapi('Protect',Buffer.from(JSON.stringify(config)),id);
      const temporary=destination+'.tmp';fs.mkdirSync(path.dirname(destination),{recursive:true});
      try{fs.writeFileSync(temporary,JSON.stringify({version:1,method:'windows-dpapi-current-user',data:encrypted.toString('base64')}),{mode:0o600});fs.renameSync(temporary,destination);}
      finally{fs.rmSync(temporary,{force:true});}
    },
    async load(id){
      if(!supported)return null;
      const destination=file(id);if(!fs.existsSync(destination))return null;
      try{
        const envelope=JSON.parse(fs.readFileSync(destination,'utf8'));
        if(envelope.version!==1||envelope.method!=='windows-dpapi-current-user'||typeof envelope.data!=='string'||envelope.data.length>100000||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data))throw Error();
        const decrypted=await dpapi('Unprotect',Buffer.from(envelope.data,'base64'),id);
        return normalized(JSON.parse(decrypted.toString('utf8')));
      }catch{throw Error('本机保存的 API 配置无法解密，请重新填写并保存');}
    },
    clear(id){const destination=file(id);fs.rmSync(destination,{force:true});fs.rmSync(destination+'.tmp',{force:true});}
  };
}
