import {request,parseJSON} from './provider.mjs';
import {reportTask} from './task-progress.mjs';

export async function runModelTools({config,system,content,tools,execute,signal,requestModel=request,maxTurns=6,maxCalls=12,onRecord=()=>{}}){
  let mode='native',calls=0;const history=[],messages=[{role:'system',content:system+'\n仅返回工具调用或简洁执行摘要，不输出内部推理。若不使用原生tool_calls，可返回JSON {calls:[{name:"工具名",arguments:{...}}],summary:"执行摘要"}；完成后返回 {done:true,summary:"执行摘要"}。'}, {role:'user',content}];
  const names=new Set(tools.map(t=>t.function.name));
  for(let turn=0;turn<maxTurns;turn++){
    if(signal?.aborted)throw Error('任务已取消');
    let result;
    try{result=await requestModel(config,'chat/completions',{stream:false,messages,...(mode==='native'?{tools,tool_choice:'auto'}:{})},signal,{validate:value=>{
      const message=value?.choices?.[0]?.message;
      if(!message||!Array.isArray(message.tool_calls)&&typeof message.content!=='string')throw Error('主模型工具接口缺少有效 message');
      if(!message.tool_calls?.length){
        const parsed=parseJSON(message.content);
        if(!parsed||typeof parsed!=='object'||!Array.isArray(parsed.calls)&&parsed.done!==true&&typeof parsed.summary!=='string')throw Object.assign(Error('主模型未返回工具指令或完成状态'),{repairInstruction:'当前轮须返回 JSON {calls:[{name,arguments}]} 或 {done:true,summary:"完成摘要"}；已有工具结果保留，不重复执行之前成功的调用。'});
      }
      return value;
    }});}
    catch(error){if(mode==='native'&&error.toolsUnsupported&&turn===0){mode='json';messages[0].content+='\n接口不支持原生工具声明，本次使用JSON工具指令。工具定义：'+JSON.stringify(tools);reportTask(signal,{kind:'tool',status:'running',message:'主模型接口不支持原生工具声明，使用同模型JSON工具指令'});turn--;continue;}throw error;}
    const message=result.choices?.[0]?.message;if(!message)throw Error('主模型工具接口缺少message');
    const native=Array.isArray(message.tool_calls)&&message.tool_calls.length>0;
    let parsed,commands;
    if(native)commands=message.tool_calls;
    else{
      try{parsed=parseJSON(message.content);}catch{parsed={summary:'主模型本轮未返回可执行工具指令'};}
      commands=Array.isArray(parsed.calls)?parsed.calls.map((c,i)=>({id:'json-'+turn+'-'+i,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments??{})}})):[];
    }
    if(!commands.length)return {mode,calls,history,summary:String(parsed?.summary||'本轮工具执行结束').slice(0,600)};
    if(commands.length+calls>maxCalls)throw Error('本页工具调用达到上限，已保留此前操作');
    if(native){messages.push({role:'assistant',content:message.content??null,tool_calls:commands,...(typeof message.reasoning_content==='string'?{reasoning_content:message.reasoning_content}:{})});}
    else messages.push({role:'assistant',content:JSON.stringify(parsed)});
    const images=[];
    for(const command of commands){
      if(signal?.aborted)throw Error('任务已取消');
      const name=command.function?.name;calls++;let output;
      reportTask(signal,{kind:'tool',status:'running',message:'主模型调用工具 · '+String(name).slice(0,80)});
      try{
        if(!names.has(name))throw Error('未授权的工具：'+name);
        const args=JSON.parse(command.function.arguments||'{}');if(!args||Array.isArray(args)||typeof args!=='object')throw Error('工具参数须为对象');
        const result=await execute(name,args);output={ok:true,...result.output};if(result.image)images.push({type:'image_url',image_url:{url:result.image}});
      }catch(error){if(signal?.aborted)throw error;output={ok:false,error:String(error.message).slice(0,1600),...(error.toolSessionStop?{terminal:true,httpStatus:error.httpStatus,code:error.code}:{})};}
      const entry={name,status:output.ok?'done':'failed',result:output,at:new Date().toISOString()};history.push(entry);
      await onRecord(structuredClone(history));
      reportTask(signal,{kind:'tool',status:output.ok?'done':'failed',message:`工具 ${String(name).slice(0,80)} · ${output.ok?'已完成':output.error}`});
      if(output.terminal)return {mode,calls,history,stopped:true,summary:output.error};
      if(native)messages.push({role:'tool',tool_call_id:command.id,content:JSON.stringify(output)});
      else messages.push({role:'user',content:'工具结果：'+JSON.stringify({name,...output})});
    }
    if(images.length)messages.push({role:'user',content:[{type:'text',text:'工具生成的最新页面/素材图，继续核对。局部场景图只是布局参考，最终仍以实际PowerPoint渲染验收。'},...images]});
  }
  return {mode,calls,history,summary:'本页工具会话达到轮数上限，进入实际渲染复查'};
}
