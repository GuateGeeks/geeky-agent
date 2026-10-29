import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { sessionConfig } from './protocol.mjs';

const DEFAULT_ORIGINS = ['http://127.0.0.1:8087','http://localhost:8087'];
export function createAgentServer({
 apiKey = process.env.OPENAI_API_KEY || '',
 model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
 allowedOrigins = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',')).split(','),
 maxBodyBytes = 65536, upstreamTimeoutMs = 20000, rateLimit = 10,
 rateWindowMs = 60000, globalRateLimit = 100, maxConcurrent = 20, fetchImpl = globalThis.fetch
} = {}) {
 const origins = new Set(allowedOrigins.map(value => value.trim()));
 for (const origin of origins) {
  const parsed = new URL(origin);
  if (!['http:','https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('ALLOWED_ORIGINS must contain exact HTTP origins');
 }
 const buckets = new Map();
 let globalBucket = {at:Date.now(),count:0}, concurrent = 0;
 function allowed(ip) {
  const now = Date.now();
  for (const [key,value] of buckets) if (now-value.at >= rateWindowMs) buckets.delete(key);
  if (now-globalBucket.at >= rateWindowMs) globalBucket={at:now,count:0};
  if (!buckets.has(ip)) {
   if (buckets.size >= 10000) return false;
   buckets.set(ip,{at:now,count:0});
  }
  return ++buckets.get(ip).count <= rateLimit && ++globalBucket.count <= globalRateLimit;
 }
 const server = http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Vary','Origin');
  const reply=(status,error)=>{ if(!res.destroyed && !res.writableEnded){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error}));} };
  if(req.url!=='/session') return reply(404,'Endpoint no disponible.');
  const origin=req.headers.origin;
  if(!origin || !origins.has(origin)) return reply(403,'Origen no permitido.');
  res.setHeader('Access-Control-Allow-Origin',origin);
  if(req.method==='OPTIONS'){
   if(req.headers['access-control-request-method']!=='POST') return reply(405,'Método no permitido.');
   const headers=(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(h=>h.trim()).filter(Boolean);
   if(headers.some(h=>h!=='content-type')) return reply(403,'Encabezados no permitidos.');
   res.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});res.end();return;
  }
  if(req.method!=='POST'){res.setHeader('Allow','POST, OPTIONS');return reply(405,'Método no permitido.');}
  if(!allowed(req.socket.remoteAddress)){res.setHeader('Retry-After',String(Math.ceil(rateWindowMs/1000)));return reply(429,'Demasiadas conexiones. Intenta más tarde.');}
  if((req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/sdp') return reply(415,'Se requiere application/sdp.');
  if(!apiKey) return reply(503,'El asistente no está configurado en el servidor.');
  if(concurrent>=maxConcurrent) return reply(503,'El asistente está ocupado. Intenta más tarde.');
  if(Number(req.headers['content-length'])>maxBodyBytes){res.setHeader('Connection','close');return reply(413,'Solicitud demasiado grande.');}
  let body='',size=0;
  try {
   for await(const chunk of req){
    size+=chunk.length;
    if(size>maxBodyBytes){res.setHeader('Connection','close');reply(413,'Solicitud demasiado grande.');return;}
    body+=chunk.toString('utf8');
   }
  } catch { return reply(400,'Solicitud incompleta.'); }
  if(!body.startsWith('v=0') || body.includes('\0')) return reply(400,'Oferta SDP inválida.');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),upstreamTimeoutMs);
  const closed=()=>{if(!res.writableEnded) controller.abort();};
  res.once('close',closed);concurrent++;
  try {
   const form=new FormData();form.set('sdp',body);form.set('session',JSON.stringify(sessionConfig(model)));
   const upstream=await fetchImpl('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:'Bearer '+apiKey},body:form,signal:controller.signal});
   if(!upstream.ok){await upstream.body?.cancel();return reply(502,'No se pudo conectar con el asistente.');}
   // A successful SDP answer is bounded too. Never relay upstream diagnostic bodies.
   const reader=upstream.body?.getReader();let answer='',bytes=0;
   if(!reader) return reply(502,'Respuesta del asistente inválida.');
   const decoder=new TextDecoder();
   while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBodyBytes){await reader.cancel();return reply(502,'Respuesta del asistente inválida.');}answer+=decoder.decode(value,{stream:true});}
   answer+=decoder.decode();
   if(!answer.startsWith('v=0')) return reply(502,'Respuesta del asistente inválida.');
   if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/sdp'});res.end(answer);}
  } catch { reply(controller.signal.aborted?504:502,controller.signal.aborted?'La conexión tardó demasiado.':'No se pudo conectar con el asistente.'); }
  finally {clearTimeout(timer);res.off('close',closed);concurrent--;}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
 return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=createAgentServer();
 server.listen(Number(process.env.PORT)||8787,process.env.HOST||'127.0.0.1',()=>process.stdout.write('Geeky session server listening.\n'));
}
