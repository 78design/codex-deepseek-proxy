const http=require('http'),https=require('https');
const KEY=process.env.OPENAI_API_KEY;
if(!KEY){console.error('[FATAL] KEY required');process.exit(1);}

function uid(p){return p+Math.random().toString(36).slice(2,8)+Math.random().toString(36).slice(2,8);}
function esend(res,ev,d){try{res.write('event: '+ev+'\ndata: '+JSON.stringify(d)+'\n\n');}catch(e){}}
function etext(c){if(!c)return'';if(typeof c==='string')return c;if(Array.isArray(c))return c.filter(function(x){return /text|input_text|output_text/.test(x.type);}).map(function(x){return x.text||'';}).join('');return c.text||JSON.stringify(c);}

// ---- full translate: merge consecutive function_calls ----
function translate(input){
  if(!Array.isArray(input))return[{role:'user',content:String(input)}];
  var msgs=[],pr='',ptcs=[];
  function flush(){
    if(!ptcs.length)return;
    var mr=ptcs.map(function(t){return {id:t.id,type:'function',function:t.function};});
    var m={role:'assistant',content:null,tool_calls:mr};
    if(pr){m.reasoning_content=pr;pr='';}
    var prev=msgs[msgs.length-1];
    if(prev&&prev.role==='assistant'&&!prev.tool_calls){
      if(prev.content)m.content=prev.content;
      if(prev.reasoning_content)m.reasoning_content=(m.reasoning_content||'')+prev.reasoning_content;
      msgs.pop();
    }
    msgs.push(m);ptcs=[];
  }
  for(var i=0;i<input.length;i++){
    var it=input[i];if(!it||!it.type)continue;
    switch(it.type){
      case'reasoning':pr+=(it.summary||[]).map(function(s){return s.text||'';}).join('')||etext(it.content);break;
      case'message':
        var r=(it.role==='developer'?'system':it.role)||'user';
        if(r==='assistant'){
          flush();var t='',tcs=[];
          if(Array.isArray(it.content)){
            for(var j=0;j<it.content.length;j++){
              var c=it.content[j];
              if(/text|output_text/.test(c.type))t+=c.text||'';
              else if(/tool_use|tool_call/.test(c.type))tcs.push({id:c.id||uid('c_'),function:{name:c.name||'',arguments:typeof c.arguments==='string'?c.arguments:JSON.stringify(c.arguments||{})}});
              else if(c.type==='reasoning_summary')pr+=(c.text||'');
            }
          }else if(typeof it.content==='string')t=it.content;
          var am=tcs.length?{role:'assistant',content:t||null,tool_calls:tcs}:{role:'assistant',content:t||''};
          if(pr){am.reasoning_content=pr;pr='';}
          msgs.push(am);
        }else{flush();pr='';msgs.push({role:r,content:etext(it.content)});}
        break;
      case'function_call':
        ptcs.push({id:it.call_id||uid('c_'),function:{name:it.name||'',arguments:typeof it.arguments==='string'?it.arguments:JSON.stringify(it.arguments||{})}});break;
      case'function_call_output':case'tool_result':
        flush();pr='';msgs.push({role:'tool',tool_call_id:it.call_id||'',content:typeof it.output==='string'?it.output:JSON.stringify(it.output||it.result||'')});break;
      case'custom_output':case'tool_search_output':case'web_search_call_output':
        flush();pr='';msgs.push({role:'tool',tool_call_id:it.call_id||it.id||uid('tc_'),content:JSON.stringify(it.output||it.result||it.content||'')});break;
      case'custom':case'tool_search':case'web_search_call':
        flush();ptcs.push({id:it.call_id||it.id||uid('c_'),function:{name:it.name||it.type||'unknown',arguments:typeof it.arguments==='string'?it.arguments:JSON.stringify(it.arguments||it.input||{})}});flush();break;
      case'item_reference':case'item_reference_output':break;
      default:flush();
        if(it.role){pr='';msgs.push({role:it.role==='developer'?'system':it.role,content:etext(it.content)||JSON.stringify(it)});}
        else if(it.output||it.content){pr='';msgs.push({role:'tool',tool_call_id:it.call_id||it.id||uid('tc_'),content:JSON.stringify(it.output||it.content||it)});}
    }
  }
  flush();
  var last=msgs[msgs.length-1];
  if(last&&last.role==='assistant'&&!last.tool_calls&&!last.content&&!last.reasoning_content)msgs.pop();
  return msgs;
}

// ---- token estimation ----
function estok(msgs){
  var n=0;
  for(var i=0;i<msgs.length;i++){
    var m=msgs[i];n+=4;
    var c=typeof m.content==='string'?m.content:JSON.stringify(m.content||'');
    n+=Math.ceil(c.length/2.2);
    if(m.tool_calls)n+=Math.ceil(JSON.stringify(m.tool_calls).length/2.5);
    if(m.reasoning_content)n+=Math.ceil(m.reasoning_content.length/2);
  }
  return n;
}

// ---- auto-trim ----
function trim(msgs,lim){
  lim=lim||650000;
  var e=estok(msgs);
  if(e<=lim)return {msgs:msgs,cut:0};
  var si=-1;
  for(var i=0;i<msgs.length;i++){if(msgs[i].role==='system'){si=i;break;}}
  var kept=si>=0?[msgs[si]]:[];
  var tail=msgs.slice(si>=0?si+1:0);
  var run=estok(kept),cut=0;
  for(var i=tail.length-1;i>=0;i--){run+=estok([tail[i]]);if(run>lim){cut=i+1;break;}}
  var safe=si>=0?1:0;
  var cand=kept.concat(tail.slice(cut));
  while(safe<cand.length&&cand[safe].role==='tool')safe++;
  var result=cand.slice(safe);
  if(msgs.length!==result.length)console.log('[TRIM] '+(msgs.length-result.length)+' msgs removed, '+e+'→'+estok(result)+' tokens');
  return {msgs:result,cut:msgs.length-result.length};
}

// ---- tool expansion ----
function expandTools(tools){
  var out=[];
  for(var i=0;i<(tools||[]).length;i++){
    var t=tools[i];
    if(t.type==='function'||t.type==='tool'){
      var f=t.function||{name:t.name,description:t.description,parameters:t.parameters};
      out.push({type:'function',function:f});
    }else if(t.type==='namespace'){
      var subs=t.functions||t.tools||[];
      for(var j=0;j<subs.length;j++){
        var fn=subs[j];
        out.push({type:'function',function:{name:fn.name||'',description:fn.description||t.description||'',parameters:fn.parameters||fn.input_schema||{}}});
      }
    }
  }
  return out;
}

// ---- error → friendly message ----
function handleError(res,errMsg,isStream,model){
  var isCtx=errMsg.indexOf('context length')>=0||errMsg.indexOf('maximum context')>=0;
  var tip=isCtx?'⚠️ 上下文超出 DeepSeek 1M token 限制。请用 /clear 清空对话历史。重启 Codex 后即可恢复。':'⚠️ 代理错误: '+errMsg.slice(0,150);
  var rid=uid('r_'),mid=uid('m_');
  if(isStream){
    esend(res,'response.created',{type:'response.created',response:{id:rid,object:'response',status:'in_progress',model:model,output:[]}});
    esend(res,'response.output_item.added',{type:'response.output_item.added',output_index:0,item:{id:mid,type:'message',role:'assistant',status:'in_progress',content:[]}});
    esend(res,'response.content_part.added',{type:'response.content_part.added',item_id:mid,output_index:0,content_index:0,part:{type:'output_text',text:''}});
    esend(res,'response.output_text.delta',{type:'response.output_text.delta',item_id:mid,output_index:0,content_index:0,delta:tip});
    esend(res,'response.output_item.done',{type:'response.output_item.done',output_index:0,item:{id:mid,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:tip}]}});
    esend(res,'response.completed',{type:'response.completed',response:{id:rid,object:'response',status:'completed',model:model,output:[{id:mid,type:'message',role:'assistant',content:[{type:'output_text',text:tip}]}],usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});
    try{res.end();}catch(e){}
  }else{
    res.writeHead(isCtx?200:502,{'Content-Type':'application/json'});
    res.end(JSON.stringify({id:rid,object:'response',status:'completed',model:model,output:[{id:mid,type:'message',role:'assistant',content:[{type:'output_text',text:tip}]}],usage:{input_tokens:0,output_tokens:0,total_tokens:0}}));
  }
}

// ---- server ----
var MAX_BODY=52428800;
http.createServer(function(req,res){
  if(req.method!=='POST'||req.url!=='/v1/responses'){res.writeHead(404);res.end('{}');return;}
  var b='',sz=0;
  req.on('data',function(c){sz+=c.length;if(sz>MAX_BODY){res.writeHead(413);res.end('{}');req.destroy();return;}b+=c;});
  req.on('end',function(){
    if(sz>MAX_BODY)return;
    var rb;try{rb=JSON.parse(b);}catch(e){res.writeHead(400);res.end(JSON.stringify({error:{message:'Invalid JSON'}}));return;}
    var isStream=rb.stream!==false;
    var model=rb.model||'deepseek-v4-flash';
    var raw=translate(rb.input);
    var trimmed=trim(raw);
    var msgs=trimmed.msgs;
    var cb={model:model,max_tokens:rb.max_output_tokens||8192,stream:isStream,messages:msgs};
    if(rb.reasoning&&rb.reasoning.effort){cb.reasoning_effort=rb.reasoning.effort==='xhigh'?'max':'high';cb.thinking={type:'enabled'};}
    var tools=expandTools(rb.tools);if(tools.length)cb.tools=tools;
    var body=JSON.stringify(cb);
    console.log('[REQ] '+model+' msgs='+msgs.length+' tools='+tools.length+' stream='+isStream);

    var dsReq=https.request({
      hostname:'api.deepseek.com',path:'/v1/chat/completions',method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+KEY,'Content-Length':Buffer.byteLength(body)},
      timeout:300000
    },function(dsRes){
      if(dsRes.statusCode!==200){
        var eb='';dsRes.on('data',function(c){eb+=c;});dsRes.on('end',function(){
          console.error('[ERR] HTTP '+dsRes.statusCode+': '+eb.slice(0,200));
          handleError(res,eb,isStream,model);
        });return;
      }
      if(isStream){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
        var buf='',rt='',ct='',started=false,sentC=false,oid=uid('i_'),tcm={};
        dsRes.on('data',function(chunk){
          buf+=chunk.toString();var lines=buf.split('\n');buf=lines.pop()||'';
          for(var i=0;i<lines.length;i++){
            var line=lines[i].trim();if(!line||line==='data: [DONE]'||line.indexOf('data: ')!==0)continue;
            var p;try{p=JSON.parse(line.substring(6));}catch(e){continue;}
            var d=(p.choices||[{}])[0].delta;if(!d)continue;
            if(!started){started=true;esend(res,'response.created',{type:'response.created',response:{id:uid('r_'),object:'response',status:'in_progress',model:model,output:[]}});}
            if(d.reasoning_content)rt+=d.reasoning_content;
            if(d.content){if(!sentC){sentC=true;esend(res,'response.output_item.added',{type:'response.output_item.added',output_index:0,item:{id:oid,type:'message',role:'assistant',status:'in_progress',content:[]}});esend(res,'response.content_part.added',{type:'response.content_part.added',item_id:oid,output_index:0,content_index:0,part:{type:'output_text',text:''}});}ct+=d.content;esend(res,'response.output_text.delta',{type:'response.output_text.delta',item_id:oid,output_index:0,content_index:0,delta:d.content});}
            if(d.tool_calls){for(var j=0;j<d.tool_calls.length;j++){var tc=d.tool_calls[j],idx=tc.index!=null?tc.index:0;if(!tcm[idx]){tcm[idx]={id:tc.id||uid('c_'),name:tc.function?tc.function.name:'',args:'',sseId:uid('f_')};esend(res,'response.output_item.added',{type:'response.output_item.added',output_index:idx+1,item:{id:tcm[idx].sseId,type:'function_call',status:'in_progress',name:tcm[idx].name,call_id:tcm[idx].id,arguments:''}});}if(tc.function&&tc.function.arguments){tcm[idx].args+=tc.function.arguments;esend(res,'response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',item_id:tcm[idx].sseId,output_index:idx+1,delta:tc.function.arguments});}if(tc.function&&tc.function.name&&!tcm[idx].name)tcm[idx].name=tc.function.name;}}
          }
        });
        dsRes.on('end',function(){
          if(sentC){esend(res,'response.content_part.done',{type:'response.content_part.done',item_id:oid,output_index:0,content_index:0,part:{type:'output_text',text:ct}});esend(res,'response.output_item.done',{type:'response.output_item.done',output_index:0,item:{id:oid,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:ct}]}});}
          var idxs=Object.keys(tcm);
          for(var i=0;i<idxs.length;i++){var tc=tcm[idxs[i]],idx=idxs[i];esend(res,'response.function_call_arguments.done',{type:'response.function_call_arguments.done',item_id:tc.sseId,output_index:+idx+1,arguments:tc.args});esend(res,'response.output_item.done',{type:'response.output_item.done',output_index:+idx+1,item:{id:tc.sseId,type:'function_call',status:'completed',name:tc.name,call_id:tc.id,arguments:tc.args}});}
          var out=[];if(rt)out.push({id:uid('rs_'),type:'reasoning',summary:[{type:'summary_text',text:rt}]});if(sentC)out.push({id:oid,type:'message',role:'assistant',content:[{type:'output_text',text:ct}]});for(var i=0;i<idxs.length;i++)out.push({id:tcm[idxs[i]].sseId,type:'function_call',name:tcm[idxs[i]].name,call_id:tcm[idxs[i]].id,arguments:tcm[idxs[i]].args});
          esend(res,'response.completed',{type:'response.completed',response:{id:uid('r_'),object:'response',status:'completed',model:model,output:out}});
          try{res.end();}catch(e){}
          console.log('[OK] stream: r='+rt.length+' t='+ct.length+' tcs='+idxs.length);
        });
        dsRes.on('error',function(e){console.error('[DS_ERR]',e.message);try{res.end();}catch(e){}});
        res.on('close',function(){try{dsRes.destroy();}catch(e){}});
      }else{
        var d='';dsRes.on('data',function(c){d+=c;});dsRes.on('end',function(){
          try{var cr=JSON.parse(d),msg=cr.choices[0].message,out=[];if(msg.reasoning_content)out.push({id:uid('rs_'),type:'reasoning',summary:[{type:'summary_text',text:msg.reasoning_content}]});if(msg.content)out.push({id:uid('m_'),type:'message',role:'assistant',content:[{type:'output_text',text:msg.content}]});if(msg.tool_calls)for(var i=0;i<msg.tool_calls.length;i++){var tc=msg.tool_calls[i];out.push({id:uid('fc_'),type:'function_call',name:tc.function.name,call_id:tc.id,arguments:tc.function.arguments});}var u=cr.usage||{};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:uid('r_'),object:'response',status:'completed',model:model,output:out,usage:{input_tokens:u.prompt_tokens||0,output_tokens:u.completion_tokens||0,total_tokens:u.total_tokens||0}}));console.log('[OK] non-stream: '+(u.total_tokens||0)+' tokens');}
          catch(e){res.writeHead(502);res.end(JSON.stringify({error:{message:e.message}}));}
        });
        dsRes.on('error',function(e){console.error('[DS_ERR]',e.message);try{res.writeHead(502);res.end(JSON.stringify({error:{message:e.message}}));}catch(e){}});
      }
    });
    dsReq.on('error',function(e){console.error('[REQ_ERR]',e.message);handleError(res,e.message,isStream,model);});
    dsReq.on('timeout',function(){dsReq.destroy();console.error('[TIMEOUT]');handleError(res,'timeout',isStream,model);});
    dsReq.write(body);dsReq.end();
  });
}).listen(15722,'127.0.0.1',function(){console.log('[proxy] v5.0 on 127.0.0.1:15722');});

process.on('uncaughtException',function(e){console.error('[UNCAUGHT]',e.message);});
process.on('unhandledRejection',function(r){console.error('[REJECTION]',r);});
