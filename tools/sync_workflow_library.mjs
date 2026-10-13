import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const source=path.resolve(process.argv[2]||''),project=fileURLToPath(new URL('../',import.meta.url)),target=path.join(project,'workflow-library');
if(!process.argv[2]||!fs.existsSync(path.join(source,'stages/13-design/references/style-tokens.json')))throw Error('请传入有效 pptx-workflow 目录');
const entries=[];
function copy(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const full=path.join(dir,item.name),relative=path.relative(source,full).replaceAll('\\','/');
  if(item.isDirectory()){if(['shared','stages'].includes(relative)||relative.startsWith('shared/')||relative.startsWith('stages/'))copy(full);continue;}
  const keep=/\.md$/.test(relative)||relative.startsWith('stages/13-design/references/')||relative.startsWith('stages/13-design/assets/')||relative.startsWith('shared/references/')||relative.startsWith('shared/schemas/');
  if(!keep||relative.includes('__pycache__'))continue;
  const dest=path.join(target,relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(full,dest);const bytes=fs.readFileSync(dest);entries.push({file:relative,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}}
copy(source);entries.sort((a,b)=>a.file.localeCompare(b.file));const version=crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0,16);
fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({source:'pptx-workflow',version,copiedAt:new Date().toISOString(),files:entries},null,2));console.log(JSON.stringify({files:entries.length,version}));
