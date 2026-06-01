const http=require('http'),https=require('https');
const KEY=process.env.OPENAI_API_KEY;
if(!KEY){console.error('[FATAL] KEY required');process.exit(1);}

function uid(p){return p+Math.random().toString(36).slice(2,8)+Math.random().toString(36).slice(2,8);}
function esend(res,ev,d){try{res.write('event: '+ev+'\ndata: '+JSON.stringify(d)+'\n\n');}catch(e){}}

http.createServer((req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
  let b='';req.on('data',c=>b+=c);req.on('end',()=>{
    let rb;try{rb=JSON.parse(b);}catch(e){res.writeHead(400);res.end(JSON.stringify({error:{message:'bad json'}}));return;}
    const isStream=rb.stream!==false;
    const model=rb.model||'deepseek-v4-flash';
    const input=rb.input;
    const msgs=typeof input==='string'?[{role:'user',content:input}]
      :(Array.isArray(input)?input.filter(i=>i&&i.type==='message').map(i=>({role:i.role==='developer'?'system':(i.role||'user'),content:typeof i.content==='string'?i.content:(Array.isArray(i.content)?i.content.filter(c=>c.text).map(c=>c.text).join(''):JSON.stringify(i.content||''))})):[{role:'user',content:String(input)}]);
    const cb={model:model,max_tokens:rb.max_output_tokens||8192,stream:isStream,messages:msgs};
    const body=JSON.stringify(cb);
    console.log('[REQ] model='+model+' msgs='+msgs.length+' stream='+isStream);

    const dsReq=https.request({
      hostname:'api.deepseek.com', path:'/v1/chat/completions', method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+KEY,'Content-Length':Buffer.byteLength(body)},
      timeout:300000
    },dsRes=>{
      if(dsRes.statusCode!==200){
        let eb='';dsRes.on('data',c=>eb+=c);dsRes.on('end',()=>{
          console.error('[ERR] HTTP '+dsRes.statusCode+': '+eb.slice(0,200));
          if(isStream){const rid=uid('r_');esend(res,'error',{type:'error',error:{message:'HTTP '+dsRes.statusCode}});esend(res,'response.completed',{type:'response.completed',response:{id:rid,status:'failed',model:model,output:[]}});try{res.end();}catch(e){}}
          else{res.writeHead(502);res.end(JSON.stringify({error:{message:'HTTP '+dsRes.statusCode}}));}
        });return;
      }
      if(isStream){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
        let buf='',rt='',ct='',started=false,sentC=false,oid=uid('i_'),tcm={};
        dsRes.on('data',chunk=>{
          buf+=chunk.toString();const lines=buf.split('\n');buf=lines.pop()||'';
          for(const raw of lines){
            const line=raw.trim();if(!line||line==='data: [DONE]'||!line.startsWith('data: '))continue;
            let p;try{p=JSON.parse(line.slice(6));}catch(e){continue;}
            const d=(p.choices||[{}])[0].delta;if(!d)continue;
            if(!started){started=true;esend(res,'response.created',{type:'response.created',response:{id:uid('r_'),object:'response',status:'in_progress',model:model,output:[]}});}
            if(d.reasoning_content)rt+=d.reasoning_content;
            if(d.content){if(!sentC){sentC=true;esend(res,'response.output_item.added',{type:'response.output_item.added',output_index:0,item:{id:oid,type:'message',role:'assistant',status:'in_progress',content:[]}});esend(res,'response.content_part.added',{type:'response.content_part.added',item_id:oid,output_index:0,content_index:0,part:{type:'output_text',text:''}});}ct+=d.content;esend(res,'response.output_text.delta',{type:'response.output_text.delta',item_id:oid,output_index:0,content_index:0,delta:d.content});}
            if(d.tool_calls){for(const tc of d.tool_calls){const idx=tc.index!=null?tc.index:0;if(!tcm[idx]){tcm[idx]={id:tc.id||uid('c_'),name:tc.function?tc.function.name:'',args:'',sseId:uid('f_')};esend(res,'response.output_item.added',{type:'response.output_item.added',output_index:idx+1,item:{id:tcm[idx].sseId,type:'function_call',status:'in_progress',name:tcm[idx].name,call_id:tcm[idx].id,arguments:''}});}if(tc.function&&tc.function.arguments){tcm[idx].args+=tc.function.arguments;esend(res,'response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',item_id:tcm[idx].sseId,output_index:idx+1,delta:tc.function.arguments});}if(tc.function&&tc.function.name&&!tcm[idx].name)tcm[idx].name=tc.function.name;}}
          }
        });
        dsRes.on('end',()=>{
          if(sentC){esend(res,'response.content_part.done',{type:'response.content_part.done',item_id:oid,output_index:0,content_index:0,part:{type:'output_text',text:ct}});esend(res,'response.output_item.done',{type:'response.output_item.done',output_index:0,item:{id:oid,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:ct}]}});}
          for(const idx of Object.keys(tcm)){const tc=tcm[idx];esend(res,'response.function_call_arguments.done',{type:'response.function_call_arguments.done',item_id:tc.sseId,output_index:+idx+1,arguments:tc.args});esend(res,'response.output_item.done',{type:'response.output_item.done',output_index:+idx+1,item:{id:tc.sseId,type:'function_call',status:'completed',name:tc.name,call_id:tc.id,arguments:tc.args}});}
          const out=[];if(rt)out.push({id:uid('rs_'),type:'reasoning',summary:[{type:'summary_text',text:rt}]});if(sentC)out.push({id:oid,type:'message',role:'assistant',content:[{type:'output_text',text:ct}]});for(const idx of Object.keys(tcm))out.push({id:tcm[idx].sseId,type:'function_call',name:tcm[idx].name,call_id:tcm[idx].id,arguments:tcm[idx].args});
          esend(res,'response.completed',{type:'response.completed',response:{id:uid('r_'),object:'response',status:'completed',model:model,output:out}});
          try{res.end();}catch(e){}
          console.log('[OK] stream: r='+rt.length+' t='+ct.length+' tcs='+Object.keys(tcm).length);
        });
        dsRes.on('error',e=>{console.error('[DS_ERR]',e.message);try{res.end();}catch(e){}});
        res.on('close',()=>{try{dsRes.destroy();}catch(e){}});
      }else{
        let d='';dsRes.on('data',c=>d+=c);dsRes.on('end',()=>{
          try{
            const cr=JSON.parse(d),msg=cr.choices[0].message,out=[];
            if(msg.reasoning_content)out.push({id:uid('rs_'),type:'reasoning',summary:[{type:'summary_text',text:msg.reasoning_content}]});
            if(msg.content)out.push({id:uid('m_'),type:'message',role:'assistant',content:[{type:'output_text',text:msg.content}]});
            if(msg.tool_calls)msg.tool_calls.forEach(tc=>out.push({id:uid('fc_'),type:'function_call',name:tc.function.name,call_id:tc.id,arguments:tc.function.arguments}));
            res.writeHead(200,{'Content-Type':'application/json'});
            res.end(JSON.stringify({id:uid('r_'),object:'response',status:'completed',model:model,output:out,usage:{input_tokens:(cr.usage||{}).prompt_tokens||0,output_tokens:(cr.usage||{}).completion_tokens||0,total_tokens:(cr.usage||{}).total_tokens||0}}));
            console.log('[OK] non-stream: '+((cr.usage||{}).total_tokens||0)+' tokens');
          }catch(e){res.writeHead(502);res.end(JSON.stringify({error:{message:e.message}}));}
        });
        dsRes.on('error',e=>{console.error('[DS_ERR]',e.message);try{res.writeHead(502);res.end(JSON.stringify({error:{message:e.message}}));}catch(e){}});
      }
    });
    dsReq.on('error',e=>{
      console.error('[REQ_ERR]',e.message);
      if(isStream){const rid=uid('r_');esend(res,'error',{type:'error',error:{message:e.message}});esend(res,'response.completed',{type:'response.completed',response:{id:rid,status:'failed',model:model,output:[]}});try{res.end();}catch(e){}}
      else{res.writeHead(502);res.end(JSON.stringify({error:{message:e.message}}));}
    });
    dsReq.on('timeout',()=>{dsReq.destroy();console.error('[TIMEOUT]');res.writeHead(504);res.end(JSON.stringify({error:{message:'timeout'}}));});
    dsReq.write(body);dsReq.end();
  });
}).listen(15722,'127.0.0.1',()=>console.log('[proxy] v4.0 on 127.0.0.1:15722'));

process.on('uncaughtException',e=>console.error('[UNCAUGHT]',e.message));
