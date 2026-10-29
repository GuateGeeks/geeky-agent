import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentServer } from '../src/server.mjs';
const origin='https://quote.example';
async function setup(options={}) {
 const server=createAgentServer({apiKey:'fake-key-for-unit-tests',allowedOrigins:[origin],...options});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {server,url:'http://127.0.0.1:'+server.address().port+'/session',close:()=>new Promise(resolve=>server.close(resolve))};
}
test('server restricts origins and methods before contacting upstream',async()=>{
 let calls=0; const h=await setup({fetchImpl:async()=>{calls++;return new Response('v=0');}});
 try {
  assert.equal((await fetch(h.url,{method:'POST',body:'v=0',headers:{Origin:'https://evil.example','Content-Type':'application/sdp'}})).status,403);
  assert.equal((await fetch(h.url,{headers:{Origin:origin}})).status,405);
  assert.equal(calls,0);
 }finally{await h.close();}
});
test('SDP exchange uses fixed tools and server-only model/key',async()=>{
 let config; const h=await setup({fetchImpl:async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/realtime/calls');assert.equal(init.headers.Authorization,'Bearer fake-key-for-unit-tests');config=JSON.parse(init.body.get('session'));return new Response('v=0\r\no=answer');}});
 try {
 const response=await fetch(h.url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/sdp'},body:'v=0\r\no=offer'});
 assert.equal(response.status,200);assert.match(await response.text(),/answer/);
 assert.equal(config.model,'gpt-realtime-2.1');
 assert.deepEqual(config.tools.map(t=>t.name),['get_cotizador_context','update_cotizador','control_campus','undo_cotizador']);
 assert.equal(response.headers.get('access-control-allow-origin'),origin);
 }finally{await h.close();}
});
test('body, content type and rate limits reject bounded requests',async()=>{
 const h=await setup({maxBodyBytes:16,rateLimit:2,fetchImpl:async()=>new Response('v=0')});
 try {
  const post=(body,type='application/sdp')=>fetch(h.url,{method:'POST',headers:{Origin:origin,'Content-Type':type},body});
  assert.equal((await post('v=0','application/json')).status,415);
  assert.equal((await post('v=0'+'x'.repeat(30))).status,413);
  assert.equal((await post('v=0')).status,429);
 }finally{await h.close();}
});
test('upstream errors are redacted and missing credentials are explicit',async()=>{
 const h=await setup({fetchImpl:async()=>new Response('fake-key-for-unit-tests secret upstream',{status:401})});
 try{const r=await fetch(h.url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/sdp'},body:'v=0'});assert.equal(r.status,502);assert(!((await r.text()).includes('fake-key')));}finally{await h.close();}
 const missing=await setup({apiKey:''});try{assert.equal((await fetch(missing.url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/sdp'},body:'v=0'})).status,503);}finally{await missing.close();}
});
test('upstream timeout returns promptly',async()=>{
 const h=await setup({upstreamTimeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('secret'))))});
 try{const r=await fetch(h.url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/sdp'},body:'v=0'});assert.equal(r.status,504);}finally{await h.close();}
});

test('key provider is lazy, bypassed for invalid requests and used only server-side',async()=>{
 let secretCalls=0,upstreamCalls=0;
 const h=await setup({apiKey:'',apiKeyProvider:async()=>{secretCalls++;return 'unit-test-only-value';},fetchImpl:async(_url,init)=>{upstreamCalls++;assert.equal(init.headers.Authorization,'Bearer unit-test-only-value');return new Response('v=0');}});
 try{
  assert.equal(secretCalls,0);
  assert.equal((await fetch(h.url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/sdp'},body:'invalid'})).status,400);assert.equal(secretCalls,0);
  const response=await fetch(h.url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/sdp'},body:'v=0'});
  assert.equal(response.status,200);assert.equal(await response.text(),'v=0');assert.equal(secretCalls,1);assert.equal(upstreamCalls,1);
 }finally{await h.close();}
});
