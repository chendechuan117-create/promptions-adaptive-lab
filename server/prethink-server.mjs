import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {generatePrethink,validatePrethinkRequest} from './prethink.mjs';
import {Jobs} from './jobs.mjs';

const defaultDist=fileURLToPath(new URL('../dist-prethink/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const send=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function readBody(req){
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>40000)throw new Error('输入过长，请缩短内容。');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('请求格式不正确。');}
}

export function createPrethinkServer({generate=generatePrethink,dist=defaultDist}={}){
  const jobs=new Jobs();let limitedUntil=0;
  const hosts=new Set(['localhost','127.0.0.1']);
  if(process.env.PROMPTIONS_PUBLIC_HOST)hosts.add(process.env.PROMPTIONS_PUBLIC_HOST.trim().toLowerCase());
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try{
      if(!hosts.has(new URL('http://'+(req.headers.host||'')).hostname))return send(res,403,{error:'访问地址不在允许范围内。'});
      if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'仅接受本页面发起的请求。'});
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/api/health'&&req.method==='GET')return send(res,200,{provider:'deepseek',model:'deepseek-flash',dataMode:'no_live_sources',mode:'prethinking',retryAfterSeconds:Math.max(0,Math.ceil((limitedUntil-Date.now())/1000))});
      if(path==='/api/cancel'&&req.method==='POST'){
        const body=await readBody(req);jobs.cancel(body.clientId,body.requestId,body.version);return send(res,200,{ok:true});
      }
      if(path==='/api/prethink'&&req.method==='POST'){
        if(Date.now()<limitedUntil)return send(res,429,{error:'DeepSeek 暂时限流，请稍后重试；输入和联想已保留。'});
        const request=validatePrethinkRequest(await readBody(req));
        const controller=new AbortController();
        try{jobs.begin(request.clientId,request.version,request.requestId,()=>controller.abort());}catch(error){return send(res,409,{error:error.message});}
        const disconnected=()=>{if(!res.writableEnded)jobs.cancel(request.clientId,request.requestId,request.version);};
        res.on('close',disconnected);
        try{
          const result=await generate(request,{signal:controller.signal});
          if(!jobs.isCurrent(request.clientId,request.requestId,request.version))return send(res,409,{error:'这次请求已取消或替换。'});
          send(res,200,result);
        }catch(error){
          if(error.status===429)limitedUntil=Date.now()+30000;
          // No arbitrary provider internals or credentials are included in responses.
          const message=controller.signal.aborted?'已取消；输入和联想已保留。':error.deepseekTransport?error.message:'未能生成完整结果，请重试；输入和联想已保留。';
          send(res,controller.signal.aborted?409:error.status===429?429:502,{error:message});
        }finally{jobs.finish(request.clientId,request.requestId,request.version);res.off('close',disconnected);}
        return;
      }
      if(path.startsWith('/api/'))return send(res,404,{error:'接口不存在。'});
      if(req.method!=='GET')return send(res,405,{error:'请求方法不支持。'});
      const file=resolve(dist,'.'+decodeURIComponent(path==='/'?'/prethink.html':path));
      if(!file.startsWith(resolve(dist)+sep))return send(res,403,{error:'路径不允许。'});
      try{const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-store':'public, max-age=3600'});res.end(data);}catch{return send(res,404,{error:'文件不存在。'});}
    }catch(error){send(res,400,{error:error.message||'请求格式不正确。'});}
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||5193);
  createPrethinkServer().listen(port,'127.0.0.1',()=>console.log(`ThoughtScout ready on http://127.0.0.1:${port}`));
}
