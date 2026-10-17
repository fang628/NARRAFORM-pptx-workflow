import {applyLibraryPolicy,agentManagedLibraryPaths} from './workflow-library-policy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const source=path.resolve(process.argv[2]||''),project=fileURLToPath(new URL('../',import.meta.url)),target=path.join(project,'workflow-library');
if(!process.argv[2]||!fs.existsSync(path.join(source,'stages/13-design/references/style-tokens.json')))throw Error('请传入有效 pptx-workflow 目录');
const entries=[];
function copy(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const full=path.join(dir,item.name),relative=path.relative(source,full).replaceAll('\\','/');
  if(relative==='stages/13-design/references/reference-sheets')continue;
  if(item.isDirectory()){if(['shared','stages'].includes(relative)||relative.startsWith('shared/')||relative.startsWith('stages/'))copy(full);continue;}
  const keep=/\.md$/.test(relative)||relative.startsWith('stages/13-design/references/')||relative.startsWith('stages/13-design/assets/')||relative.startsWith('shared/references/')||relative.startsWith('shared/schemas/');
  if(!keep||relative.includes('__pycache__'))continue;
  const dest=path.join(target,relative);fs.mkdirSync(path.dirname(dest),{recursive:true});if(!agentManagedLibraryPaths.includes(relative)||!fs.existsSync(dest))fs.copyFileSync(full,dest);const bytes=fs.readFileSync(dest);entries.push({file:relative,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}}
copy(source);applyLibraryPolicy(target);
for(const file of agentManagedLibraryPaths)if(fs.existsSync(path.join(target,file))&&!entries.some(e=>e.file===file))entries.push({file});
for(let i=entries.length-1;i>=0;i--){const file=path.join(target,entries[i].file);if(!fs.existsSync(file)){entries.splice(i,1);continue;}const bytes=fs.readFileSync(file);entries[i]={file:entries[i].file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};}
entries.sort((a,b)=>a.file.localeCompare(b.file));const version=crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0,16);
fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({source:'pptx-workflow',agentPolicyVersion:'agent-visual-v3',version,copiedAt:new Date().toISOString(),files:entries},null,2));console.log(JSON.stringify({files:entries.length,version}));
