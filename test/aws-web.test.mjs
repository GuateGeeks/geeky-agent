import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { startWebFunction } from '../src/aws-web.mjs';
import { createSecretKeyProvider } from '../src/secrets.mjs';

const pause = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fakeSecret='unit-test-only-value';
test('secret loader lazily reads and caches raw or JSON secret values with one shared request',async()=>{
 for(const value of [fakeSecret,JSON.stringify({OPENAI_API_KEY:fakeSecret})]){
  let count=0;
  const provider=createSecretKeyProvider({secretId:'test-secret',region:'us-east-1',client:{send:async command=>{count++;assert.equal(command.input.SecretId,'test-secret');await pause(5);return {SecretString:value};}},cacheTtlMs:20});
  assert.equal(count,0);
  assert.deepEqual(await Promise.all([provider(),provider()]),[fakeSecret,fakeSecret]);assert.equal(count,1);
  assert.equal(await provider(),fakeSecret);assert.equal(count,1);
  await pause(25);assert.equal(await provider(),fakeSecret);assert.equal(count,2);
 }
});
test('secret errors, absent fields and binary values are redacted and not cached as credentials',async()=>{
 for(const result of [{SecretString:''},{SecretString:'{}'},{SecretString:'{"OTHER":"value"}'},{SecretBinary:new Uint8Array([1])}]){
  const provider=createSecretKeyProvider({secretId:'test-secret',client:{send:async()=>result},failureTtlMs:0});
  await assert.rejects(provider(),error=>error.message==='Credencial del asistente no disponible.');
 }
 const provider=createSecretKeyProvider({secretId:'test-secret',client:{send:async()=>{throw new Error('sensitive diagnostic');}}});
 await assert.rejects(provider(),error=>!error.message.includes('sensitive'));
});
test('secret retrieval has a hard timeout and late completion cannot fill its cache',async()=>{
 let resolveLate,aborted=false,count=0;
 const provider=createSecretKeyProvider({secretId:'test-secret',timeoutMs:10,failureTtlMs:0,client:{send:(_command,{abortSignal})=>{count++;abortSignal.addEventListener('abort',()=>{aborted=true;});return new Promise(resolve=>{resolveLate=resolve;});}}});
 const start=Date.now();await assert.rejects(provider());assert(Date.now()-start<500);assert.equal(aborted,true);
 resolveLate({SecretString:fakeSecret});await pause(2);
 const retry=provider();await assert.rejects(retry);assert.equal(count,2);
});
test('missing secret id fails locally without calling AWS',async()=>{
 let calls=0;const provider=createSecretKeyProvider({secretId:'',client:{send:async()=>{calls++;}}});
 await assert.rejects(provider());assert.equal(calls,0);
});
test('native Web Function listens at the supplied address without fetching its secret at startup',async()=>{
 let calls=0;
 const server=startWebFunction({env:{AWS_LAMBDA_HTTP_ENDPOINT:'127.0.0.1:0',ALLOWED_ORIGINS:'https://quote.example'},apiKeyProvider:async()=>{calls++;throw new Error('secret diagnostic');}});
 await new Promise(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  const r=await fetch(url+'/health');assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});assert.equal(calls,0);
  const response=await fetch(url+'/session',{method:'POST',headers:{Origin:'https://quote.example','Content-Type':'application/sdp'},body:'v=0'});
  assert.equal(response.status,503);assert(!((await response.text()).includes('secret diagnostic')));assert.equal(calls,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('index.js starts native HTTP under the runtime endpoint without a Lambda event handler',async()=>{
 const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,['index.js'],{cwd:new URL('..',import.meta.url),env:{AWS_LAMBDA_HTTP_ENDPOINT:'127.0.0.1:'+port,OPENAI_API_KEY_SECRET_ID:'not-a-real-secret',AWS_REGION:'us-east-1',ALLOWED_ORIGINS:'https://quote.example'},stdio:'ignore'});const exited=new Promise(resolve=>child.once('exit',resolve));
 try{
  const deadline=Date.now()+3000;let ready=false;
  while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:'+port+'/health');ready=response.ok;if(ready)break;}catch{}await pause(20);}
  assert.equal(ready,true,'entrypoint listens before secret retrieval and within startup budget');
 }finally{child.kill();await exited;}
});
