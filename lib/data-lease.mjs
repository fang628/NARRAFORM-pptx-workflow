import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Windows named pipes are released by the OS even after a forced process exit.
// Avoid PID files: stale PID files and concurrent stale-lock removal are unsafe.
export async function acquireDataLease(data){
  if(process.platform!=='win32')return {close:()=>Promise.resolve()};
  const canonical=fs.realpathSync(data).toLowerCase(),id=crypto.createHash('sha256').update(canonical).digest('hex');
  const server=net.createServer(socket=>{socket.on('error',()=>{});socket.end();});
  await new Promise((resolve,reject)=>{
    const fail=error=>reject(Object.assign(Error(['EADDRINUSE','EACCES'].includes(error.code)?'此数据目录已被另一个 NARRAFORM 服务占用，请先停止原服务，或设置不同的 PPT_AGENT_DATA。':'无法取得项目数据目录的独占访问：'+error.code),{code:error.code}));
    server.once('error',fail);server.listen('\\\\.\\pipe\\narraform-data-'+id,()=>{server.removeListener('error',fail);resolve();});
  });
  server.on('error',error=>console.error('项目数据独占通道异常：',error.code||error.name));
  return {close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
