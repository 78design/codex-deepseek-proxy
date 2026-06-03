// v6.0 — reasoning-store based translator (inspired by MetaFARS/codex-relay)
const http=require('http'),https=require('https');
const KEY=process.env.OPENAI_API_KEY;
if(!KEY){console.error('[FATAL] KEY required');process.exit(1);}

// ---- simple in-memory reasoning store (call_id → reasoning_content) ----
// When DeepSeek responds, we extract reasoning + tool call_ids and store them.
// On the next request, we look up reasoning by call_id instead of trying to
// reconstruct it from input items (which are not reliably present).
var reasonStore={_map:new Map(),_keys:[],_max:5000,
  get:function(k){var v=this._map.get(k);if(v!==undefined){this._keys=this._keys.filter(function(x){return x!==k;});this._keys.push(k);}return v;},
  set:function(k,v){if(this._keys.length>=this._max){var old=this._keys.shift();if(old)this._map.delete(old);}this._keys.push(k);this._map.set(k,v);}
};

function uid(p){return p+Math.random().toString(36).slice(2,8)+Math.random().toString(36).slice(2,8);}
function esend(res,ev,d){try{res.write('event: '+ev+'\ndata: '+JSON.stringify(d)+'\n\n');}catch(e){}}
function etext(c){if(!c)return'';if(typeof c==='string')return c;if(Array.isArray(c))return c.filter(function(x){return /text|input_text|output_text/.test(x.type);}).map(function(x){return x.text||'';}).join('');return c.text||JSON.stringify(c);}

// ---- translate: Responses API input → Chat Completions messages ----
// - reasoning items are dropped; reasoning_content is recovered from reasonStore
// - consecutive function_calls are merged into one assistant message
// - system/developer messages interleaved between tool calls are moved to front
// - duplicate function_calls (from previous_response_id replay) are deduplicated
function translate(input,prevMsgs){
  if(!Array.isArray(input))return[{role:'user',content:String(input)}];

  // Collect existing call_ids from previous messages (for dedup)
  var existingIds={};
  function indexIds(msgs){
    for(var i=0;i<msgs.length;i++){
      var m=msgs[i];
      if(m.tool_calls)for(var j=0;j<m.tool_calls.length;j++){var id=m.tool_calls[j].id;if(id)existingIds[id]=true;}
      if(m.tool_call_id)existingIds[m.tool_call_id]=true;
    }
  }
  indexIds(prevMsgs||[]);

  var msgs=[],ptcs=[],pendingSystem=null;

  function flushToolCalls(){
    if(!ptcs.length)return;
    var mr=ptcs.map(function(t){return {id:t.id,type:'function',function:t.function};});

    // Look up reasoning_content from reasonStore for each call_id
    var reasoning='';
    for(var i=0;i<mr.length;i++){
      var r=reasonStore.get(mr[i].id);
      if(r){reasoning=r;break;} // use first found reasoning
    }

    var m={role:'assistant',content:null,tool_calls:mr};
    if(reasoning)m.reasoning_content=reasoning;

    // Merge with preceding text-only assistant message if present
    var prev=msgs[msgs.length-1];
    if(prev&&prev.role==='assistant'&&!prev.tool_calls){
      if(prev.content)m.content=prev.content;
      if(prev.reasoning_content)m.reasoning_content=(m.reasoning_content||'')+prev.reasoning_content;
      msgs.pop();
    }
    msgs.push(m);ptcs=[];
  }

  function flushPendingSystem(){
    if(!pendingSystem)return;
    if(msgs.length>0&&msgs[0].role==='system')msgs[0]=pendingSystem;
    else msgs.unshift(pendingSystem);
    pendingSystem=null;
  }

  for(var i=0;i<input.length;i++){
    var it=input[i];if(!it||!it.type)continue;
    switch(it.type){
      case'reasoning':
        // reasoning is handled by reasonStore — drop input items
        break;
      case'message':
        var r=(it.role==='developer'?'system':it.role)||'user';
        if(r==='system'){
          var sc=etext(it.content);
          if(sc) pendingSystem={role:'system',content:sc};
        }else if(r==='assistant'){
          flushToolCalls();
          var t='',tcs=[];
          if(Array.isArray(it.content)){
            for(var j=0;j<it.content.length;j++){
              var c=it.content[j];
              if(/text|output_text/.test(c.type))t+=c.text||'';
              else if(/tool_use|tool_call/.test(c.type))tcs.push({id:c.id||uid('c_'),function:{name:c.name||'',arguments:typeof c.arguments==='string'?c.arguments:JSON.stringify(c.arguments||{})}});
            }
          }else if(typeof it.content==='string')t=it.content;
          // Look up reasoning for assistant text messages
          var am=tcs.length?{role:'assistant',content:t||null,tool_calls:tcs}:{role:'assistant',content:t||''};
          if(!tcs.length){
            var r_key=reasonStore.get('_txt_'+Buffer.from(t).toString('base64').slice(0,40));
            if(r_key)am.reasoning_content=r_key;
          }else{
            for(var k=0;k<tcs.length;k++){
              var rr=reasonStore.get(tcs[k].id);
              if(rr){am.reasoning_content=rr;break;}
            }
          }
          msgs.push(am);
        }else{
          flushToolCalls();flushPendingSystem();
          msgs.push({role:r,content:etext(it.content)});
        }
        break;
      case'function_call':
        var cid=it.call_id||it.id||uid('c_');
        // Dedup: skip if this call_id already exists in previous messages
        if(existingIds[cid])break;
        ptcs.push({id:cid,function:{name:it.name||'',arguments:typeof it.arguments==='string'?it.arguments:JSON.stringify(it.arguments||{})}});
        break;
      case'function_call_output':case'tool_result':
        flushToolCalls();flushPendingSystem();
        msgs.push({role:'tool',tool_call_id:it.call_id||'',content:typeof it.output==='string'?it.output:JSON.stringify(it.output||it.result||'')});
        break;
      case'custom_output':case'tool_search_output':case'web_search_call_output':
        flushToolCalls();flushPendingSystem();
        msgs.push({role:'tool',tool_call_id:it.call_id||it.id||uid('tc_'),content:JSON.stringify(it.output||it.result||it.content||'')});
        break;
      case'custom':case'tool_search':case'web_search_call':
        ptcs.push({id:it.call_id||it.id||uid('c_'),function:{name:it.name||it.type||'unknown',arguments:typeof it.arguments==='string'?it.arguments:JSON.stringify(it.arguments||it.input||{})}});
        break;
      case'item_reference':case'item_reference_output':break;
      default:flushToolCalls();
        if(it.role){
          if(it.role==='developer'||it.role==='system'){var sc2=etext(it.content);if(sc2) pendingSystem={role:'system',content:sc2};}
          else msgs.push({role:it.role,content:etext(it.content)||JSON.stringify(it)});
        }else if(it.output||it.content){
          msgs.push({role:'tool',tool_call_id:it.call_id||it.id||uid('tc_'),content:JSON.stringify(it.output||it.content||it)});
        }
    }
  }
  flushToolCalls();flushPendingSystem();

  // Remove trailing empty assistant message
  var last=msgs[msgs.length-1];
  if(last&&last.role==='assistant'&&!last.tool_calls&&!last.content&&!last.reasoning_content)msgs.pop();
  return msgs;
}

// ---- tool expansion ----
function sanitizeSchema(p){
  if(!p||typeof p!=='object')return {type:'object',properties:{},additionalProperties:true};
  var s=JSON.parse(JSON.stringify(p));
  if(!s.type||s.type==='null')s.type='object';
  if(s.type==='object'&&!s.properties)s.properties={};
  if(s.type==='object'&&s.additionalProperties===undefined)s.additionalProperties=true;
  if(s.properties)for(var k in s.properties){
    var v=s.properties[k];if(v&&!v.type&&!v.properties&&!v.anyOf&&!v.oneOf&&!v.allOf&&!v.$ref&&v.const===undefined&&v.enum===undefined)delete s.properties[k];
  }
  return s;
}

function expandTools(tools){
  var out=[];
  var deny=process.env.CODEX_TOOL_DENYLIST;
  var denied={};if(deny)deny.split(',').forEach(function(n){denied[n.trim()]=true;});
  for(var i=0;i<(tools||[]).length;i++){
    var t=tools[i];
    if(t.type==='function'||t.type==='tool'){
      var name=t.function?t.function.name:t.name;if(name&&denied[name])continue;
      var f=t.function||{name:t.name||'',description:t.description||'',parameters:t.parameters||{}};
      f.parameters=sanitizeSchema(f.parameters);
      out.push({type:'function',function:f});
    }else if(t.type==='namespace'){
      var subs=t.functions||t.tools||[];
      for(var j=0;j<subs.length;j++){
        var fn=subs[j];var nsName=(t.name||'')+'.'+(fn.name||'');
        if(denied[nsName]||denied[fn.name||''])continue;
        out.push({type:'function',function:{name:fn.name||'',description:fn.description||t.description||'',parameters:sanitizeSchema(fn.parameters||fn.input_schema||{})}});
      }
    }else if(t.name){
      if(denied[t.name])continue;
      out.push({type:'function',function:{name:t.name||'',description:t.description||'',parameters:sanitizeSchema(t.parameters||t.input_schema||{})}});
    }
  }
  return out;
}

// ---- store reasoning for future lookups ----
function storeReasoning(reasoningText,toolCallsOrIds,textContent){
  if(!reasoningText)return;
  if(toolCallsOrIds)for(var i=0;i<toolCallsOrIds.length;i++){
    var id=typeof toolCallsOrIds[i]==='string'?toolCallsOrIds[i]:toolCallsOrIds[i].id;
    if(id)reasonStore.set(id,reasoningText);
  }
  // Also store by text fingerprint for assistant messages without tool calls
  if(textContent){
    var fp=Buffer.from(textContent).toString('base64').slice(0,40);
    reasonStore.set('_txt_'+fp,reasoningText);
  }
}

// ---- error → friendly message ----
function handleError(res,errMsg,isStream,model){
  var isCtx=errMsg.indexOf('context length')>=0||errMsg.indexOf('maximum context')>=0;
  var isToolChain=errMsg.indexOf('tool_calls')>=0;
  var tip='';
  if(isCtx)tip='上下文超出限制，请用 /clear 清空对话历史后重试。';
  else if(isToolChain)tip='DeepSeek 工具调用链断裂，请用 /clear 清空对话历史后重试。';
  else tip='代理错误: '+errMsg.slice(0,150);
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
  // GET /v1/models — proxy to DeepSeek
  if(req.method==='GET'&&req.url==='/v1/models'){
    var mReq=https.get({hostname:'api.deepseek.com',path:'/v1/models',headers:{'Authorization':'Bearer '+KEY},timeout:10000},function(mRes){
      var body='';mRes.on('data',function(c){body+=c;});mRes.on('end',function(){
        try{var list=JSON.parse(body);var data=list.data||list.models||[];res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:data,models:data}));}catch(e){res.writeHead(502);res.end('{}');}
      });
    });
    mReq.on('error',function(){res.writeHead(502);res.end('{}');});
    mReq.setTimeout(10000,function(){mReq.destroy();res.writeHead(504);res.end('{}');});
    return;
  }
  if(req.method!=='POST'||req.url!=='/v1/responses'){res.writeHead(404);res.end('{}');return;}
  var b='',sz=0;
  req.on('error',function(e){console.error('[SRV_ERR]',e.message);try{res.writeHead(500);res.end('{}');}catch(e){}});
  req.on('data',function(c){sz+=c.length;if(sz>MAX_BODY){res.writeHead(413);res.end('{}');req.destroy();return;}b+=c;});
  req.on('end',function(){
    if(sz>MAX_BODY)return;
    var rb;try{rb=JSON.parse(b);}catch(e){res.writeHead(400);res.end(JSON.stringify({error:{message:'Invalid JSON'}}));return;}
    var isStream=rb.stream!==false;
    var model=rb.model||'deepseek-v4-flash';

    // Get previous messages from reasonStore (keyed by previous_response_id)
    var prevMsgs=[];
    if(rb.previous_response_id){
      var cached=reasonStore.get('_hist_'+rb.previous_response_id);
      if(cached)prevMsgs=cached;
    }

    var msgs=translate(rb.input,prevMsgs);
    var mt=rb.max_output_tokens||8192;if(mt>8192)mt=8192;
    var cb={model:model,max_tokens:mt,stream:isStream,messages:msgs};
    if(rb.reasoning&&rb.reasoning.effort){var e=rb.reasoning.effort;cb.reasoning_effort=e==='low'||e==='minimal'?'low':e==='medium'?'medium':'high';cb.thinking={type:'enabled'};}
    var tools=expandTools(rb.tools);if(tools.length)cb.tools=tools;
    var body=JSON.stringify(cb);
    console.log('[REQ] '+model+' msgs='+msgs.length+' tools='+tools.length+' stream='+isStream);

    var dsReq=https.request({
      hostname:'api.deepseek.com',path:'/v1/chat/completions',method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+KEY,'Content-Length':Buffer.byteLength(body)},
      timeout:300000
    },function(dsRes){
      if(dsRes.statusCode!==200){
        var eb='';dsRes.on('data',function(c){eb+=c;if(eb.length>4000){dsRes.destroy();}});dsRes.on('end',function(){
          console.error('[ERR] HTTP '+dsRes.statusCode+': '+eb.slice(0,200));
          handleError(res,eb,isStream,model);
        });dsRes.on('error',function(e){console.error('[DS_ERR]',e.message);handleError(res,e.message,isStream,model);});return;
      }
      if(isStream){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
        var rid=uid('r_'),buf='',rt='',ct='',started=false,sentC=false,oid=uid('i_'),tcm={},streamDone=false;
        dsRes.on('data',function(chunk){
          buf+=chunk.toString();var lines=buf.split('\n');buf=lines.pop()||'';
          for(var i=0;i<lines.length;i++){
            var line=lines[i].trim();if(!line||line==='data: [DONE]'){streamDone=true;continue;}
            if(line.indexOf('data: ')!==0)continue;
            var p;try{p=JSON.parse(line.substring(6));}catch(e){continue;}
            var d=(p.choices||[{}])[0].delta;if(!d)continue;
            if(!started){started=true;esend(res,'response.created',{type:'response.created',response:{id:rid,object:'response',status:'in_progress',model:model,output:[]}});}
            if(d.reasoning_content)rt+=d.reasoning_content;
            if(d.content){if(!sentC){sentC=true;esend(res,'response.output_item.added',{type:'response.output_item.added',output_index:0,item:{id:oid,type:'message',role:'assistant',status:'in_progress',content:[]}});esend(res,'response.content_part.added',{type:'response.content_part.added',item_id:oid,output_index:0,content_index:0,part:{type:'output_text',text:''}});}ct+=d.content;esend(res,'response.output_text.delta',{type:'response.output_text.delta',item_id:oid,output_index:0,content_index:0,delta:d.content});}
            if(d.tool_calls){for(var j=0;j<d.tool_calls.length;j++){var tc=d.tool_calls[j],idx=tc.index!=null?tc.index:0;if(!tcm[idx]){tcm[idx]={id:tc.id||uid('c_'),name:tc.function?tc.function.name:'',args:'',sseId:uid('f_')};esend(res,'response.output_item.added',{type:'response.output_item.added',output_index:idx+1,item:{id:tcm[idx].sseId,type:'function_call',status:'in_progress',name:tcm[idx].name,call_id:tcm[idx].id,arguments:''}});}if(tc.function&&tc.function.arguments){tcm[idx].args+=tc.function.arguments;esend(res,'response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',item_id:tcm[idx].sseId,output_index:idx+1,delta:tc.function.arguments});}if(tc.function&&tc.function.name&&!tcm[idx].name)tcm[idx].name=tc.function.name;}}
          }
        });
        dsRes.on('end',function(){
          if(!streamDone){
            // Stream disconnected before [DONE] — don't save partial state
            esend(res,'response.failed',{type:'response.failed',response:{id:rid,status:'failed',error:{code:'stream_incomplete',message:'stream disconnected before completion'}}});
            try{res.end();}catch(e){}
            console.error('[STREAM] disconnected before [DONE]');
            return;
          }
          if(sentC){esend(res,'response.content_part.done',{type:'response.content_part.done',item_id:oid,output_index:0,content_index:0,part:{type:'output_text',text:ct}});esend(res,'response.output_item.done',{type:'response.output_item.done',output_index:0,item:{id:oid,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:ct}]}});}
          var idxs=Object.keys(tcm).sort(function(a,b){return a-b;});
          for(var i=0;i<idxs.length;i++){var tc=tcm[idxs[i]],idx=idxs[i];esend(res,'response.function_call_arguments.done',{type:'response.function_call_arguments.done',item_id:tc.sseId,output_index:+idx+1,arguments:tc.args});esend(res,'response.output_item.done',{type:'response.output_item.done',output_index:+idx+1,item:{id:tc.sseId,type:'function_call',status:'completed',name:tc.name,call_id:tc.id,arguments:tc.args}});}
          var out=[];if(rt)out.push({id:uid('rs_'),type:'reasoning',summary:[{type:'summary_text',text:rt}]});if(sentC)out.push({id:oid,type:'message',role:'assistant',content:[{type:'output_text',text:ct}]});for(var i=0;i<idxs.length;i++)out.push({id:tcm[idxs[i]].sseId,type:'function_call',name:tcm[idxs[i]].name,call_id:tcm[idxs[i]].id,arguments:tcm[idxs[i]].args});
          esend(res,'response.completed',{type:'response.completed',response:{id:rid,object:'response',status:'completed',model:model,output:out}});
          try{res.end();}catch(e){}
          // Store reasoning for future lookups (streaming path)
          if(rt){
            var ids=idxs.map(function(k){return tcm[k].id;});
            storeReasoning(rt,ids,ct||'');
          }
          // Save session history for previous_response_id lookups
          var histMsgs=msgs.concat([{role:'assistant',content:sentC?ct:null,reasoning_content:rt||undefined,tool_calls:idxs.length?idxs.map(function(k){return {id:tcm[k].id,type:'function',function:{name:tcm[k].name,arguments:tcm[k].args}};}):undefined}]);
          reasonStore.set('_hist_'+rid,histMsgs);
          console.log('[OK] stream: r='+rt.length+' t='+ct.length+' tcs='+idxs.length);
        });
        dsRes.on('error',function(e){console.error('[DS_ERR]',e.message);try{res.end();}catch(e){}});
        res.on('close',function(){try{dsRes.destroy();}catch(e){}});
      }else{
        var d='';dsRes.on('data',function(c){d+=c;if(d.length>2097152){dsRes.destroy();}});dsRes.on('end',function(){
          try{var cr=JSON.parse(d),choice=(cr.choices||[])[0]||{message:{}},msg=choice.message||{},out=[];if(msg.reasoning_content)out.push({id:uid('rs_'),type:'reasoning',summary:[{type:'summary_text',text:msg.reasoning_content}]});if(msg.content)out.push({id:uid('m_'),type:'message',role:'assistant',content:[{type:'output_text',text:msg.content}]});if(msg.tool_calls)for(var i=0;i<msg.tool_calls.length;i++){var tc=msg.tool_calls[i],fn=tc.function||{};out.push({id:uid('fc_'),type:'function_call',name:fn.name||'',call_id:tc.id||'',arguments:fn.arguments||''});}var u=cr.usage||{};
          // Store reasoning for future lookups
          if(msg.reasoning_content){
            var tcIds=(msg.tool_calls||[]).map(function(x){return x.id;});
            storeReasoning(msg.reasoning_content,tcIds,msg.content||'');
          }
          var nid=uid('r_');
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({id:nid,object:'response',status:'completed',model:model,output:out,usage:{input_tokens:u.prompt_tokens||0,output_tokens:u.completion_tokens||0,total_tokens:u.total_tokens||0}}));
          // Save session history
          var nhist=msgs.concat([{role:'assistant',content:msg.content||null,reasoning_content:msg.reasoning_content||undefined,tool_calls:msg.tool_calls||undefined}]);
          reasonStore.set('_hist_'+nid,nhist);
          console.log('[OK] non-stream: '+(u.total_tokens||0)+' tokens');
          }catch(e){res.writeHead(502);res.end(JSON.stringify({error:{message:e.message}}));}
        });
        dsRes.on('error',function(e){console.error('[DS_ERR]',e.message);try{res.writeHead(502);res.end(JSON.stringify({error:{message:e.message}}));}catch(e){}});
      }
    });
    dsReq.on('error',function(e){console.error('[REQ_ERR]',e.message);handleError(res,e.message,isStream,model);});
    dsReq.on('timeout',function(){dsReq.destroy();console.error('[TIMEOUT]');handleError(res,'timeout',isStream,model);});
    dsReq.write(body);dsReq.end();
  });
}).listen(15721,'127.0.0.1',function(){console.log('[codex_proxy] v6.0 on http://127.0.0.1:15721/v1/responses');console.log('[codex_proxy] using reasoning store — no more token estimation');});

process.on('uncaughtException',function(e){console.error('[UNCAUGHT]',e.message);});
process.on('unhandledRejection',function(r){console.error('[REJECTION]',r);});
