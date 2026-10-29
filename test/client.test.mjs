import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeClient } from '../src/client.mjs';

class Channel {
  readyState = 'connecting'; sent = [];
  send(value) { const event = JSON.parse(value); this.sent.push(event); if(event.type === 'session.update') queueMicrotask(() => this.event({type:'session.updated'})); }
  close() { this.readyState = 'closed'; }
  open() { this.readyState = 'open'; this.onopen?.(); }
  event(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
class Peer {
  static instances = [];
  connectionState = 'new'; localDescription = null;
  constructor() { Peer.instances.push(this); this.channel = new Channel(); this.sender = { track:null, replaceTrack:async track => { this.sender.track = track; } }; }
  addTransceiver() { return {sender:this.sender}; }
  createDataChannel() { return this.channel; }
  async createOffer() { return {type:'offer',sdp:'v=0\r\no=offer'}; }
  async setLocalDescription(offer) { this.localDescription = offer; }
  async setRemoteDescription(answer) { this.answer = answer; this.channel.open(); }
  close() { this.closed = true; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ mic, upstream } = {}) {
  Peer.instances.length = 0;
  let micCalls = 0;
  const events = [], audio = { muted:true, srcObject:null, play:async()=>{}, pause(){ this.paused = true; } };
  globalThis.RTCPeerConnection = Peer;
  Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{mediaDevices:{getUserMedia:async()=>{micCalls++; if(mic) return mic(); throw new Error('permission denied');}}}});
  globalThis.Audio = function(){ return audio; };
  globalThis.fetch = upstream || (async()=>new Response('v=0\r\no=answer',{headers:{'Content-Type':'application/sdp'}}));
  const client = createRealtimeClient({endpoint:'https://agent.example/session',executeTool:async(name,args)=>({ok:true,name,args}),onEvent:event=>events.push(event)});
  return {client,events,audio,get pc(){return Peer.instances.at(-1);},get micCalls(){return micCalls;}};
}
test('text connects and sends without requesting microphone; responses serialize', async()=>{
  const h=harness(); await h.client.connect(); await h.client.sendText('hola'); await h.client.sendText('otra');
  assert.equal(h.micCalls,0);
  assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,1);
  h.pc.channel.event({type:'response.done',response:{id:'r1',output:[]}}); await tick();
  assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,2);
  await h.client.disconnect(); assert.equal(h.pc.closed,true);
});
test('microphone denial leaves connected text usable',async()=>{
  const h=harness(); await h.client.connect(); await assert.rejects(h.client.setVoice(true));
  await h.client.sendText('texto');
  assert(h.events.some(e=>e.type==='status'&&e.status==='connected'));
  assert(h.events.some(e=>e.type==='voice'&&!e.enabled));
  await h.client.disconnect();
});
test('voice off releases mic, detaches sender and stops playback',async()=>{
  const track={stop(){this.stopped=true;}}, stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const h=harness({mic:async()=>stream}); await h.client.connect(); await h.client.setVoice(true);
  assert.equal(h.pc.sender.track,track);
  await h.client.setVoice(false);
  assert.equal(track.stopped,true); assert.equal(h.pc.sender.track,null); assert.equal(h.audio.paused,true); assert.equal(h.audio.muted,true);
  await h.client.disconnect();
});
test('late microphone permission after disconnect stops all tracks',async()=>{
  let grant; const track={stop(){this.stopped=true;}}, stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const h=harness({mic:()=>new Promise(resolve=>{grant=resolve;})}); await h.client.connect();
  const pending=h.client.setVoice(true); await tick(); await h.client.disconnect(); grant(stream);
  await assert.rejects(pending); assert.equal(track.stopped,true); assert.equal(h.pc.sender.track,null);
});
test('disconnect aborts an unfinished SDP exchange and never reconnects late',async()=>{
  let answer;
  const h=harness({upstream:()=>new Promise(resolve=>{answer=resolve;})});
  const pending=h.client.connect(); await tick(); await h.client.disconnect(); answer(new Response('v=0'));
  await assert.rejects(pending); assert.equal(h.pc.closed,true);
  assert(!h.events.some(e=>e.type==='status'&&e.status==='connected'));
});
test('assistant deltas aggregate under stable item ids',async()=>{
  const h=harness(); await h.client.connect();
  h.pc.channel.event({type:'response.output_text.delta',item_id:'m1',content_index:0,delta:'Hola '});
  h.pc.channel.event({type:'response.output_text.delta',item_id:'m1',content_index:0,delta:'mundo'});
  h.pc.channel.event({type:'response.output_text.done',item_id:'m1',content_index:0,text:'Hola mundo'});
  assert.deepEqual(h.events.filter(e=>e.type==='message').at(-1),{type:'message',id:'m1',role:'assistant',text:'Hola mundo',final:true});
  await h.client.disconnect();
});
test('multiple function calls are sequential, deduplicated and followed by one response',async()=>{
  const h=harness(); let release; const executed=[];
  await h.client.disconnect();
  const client=createRealtimeClient({endpoint:'/session',onEvent:e=>h.events.push(e),executeTool:async(name,args)=>{
    executed.push(args.n); if(args.n===1) await new Promise(resolve=>{release=resolve;}); return {ok:true};
  }});
  await client.connect(); const pc=Peer.instances.at(-1); await client.sendText('actúa');
  const call=n=>({type:'function_call',call_id:'c'+n,name:'get_cotizador_context',arguments:JSON.stringify({n})});
  pc.channel.event({type:'response.function_call_arguments.done',response_id:'r1',...call(1)});
  pc.channel.event({type:'response.done',response:{id:'r1',output:[call(1),call(2)]}});
  await tick(); assert.deepEqual(executed,[1]); assert.equal(pc.channel.sent.filter(e=>e.type==='response.create').length,1);
  release(); await tick(); await tick(); assert.deepEqual(executed,[1,2]);
  assert.equal(pc.channel.sent.filter(e=>e.type==='conversation.item.create'&&e.item.type==='function_call_output').length,2);
  assert.equal(pc.channel.sent.filter(e=>e.type==='response.create').length,2);
  pc.channel.event({type:'response.done',response:{id:'r1',output:[call(1),call(2)]}}); await tick();
  assert.deepEqual(executed,[1,2]); await client.disconnect();
});

test('voice off invalidates a pending permission request without disconnecting text',async()=>{
 let grant;const track={stop(){this.stopped=true;}},stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 const h=harness({mic:()=>new Promise(resolve=>{grant=resolve;})});await h.client.connect();
 const pending=h.client.setVoice(true);await tick();await h.client.setVoice(false);grant(stream);await assert.rejects(pending);
 assert.equal(track.stopped,true);assert.equal(h.pc.sender.track,null);await h.client.sendText('sigo aquí');await h.client.disconnect();
});
test('back-to-back toggles serialize session acknowledgements',async()=>{
 const track=()=>({stop(){this.stopped=true;}});const h=harness({mic:async()=>{const t=track();return {getTracks:()=>[t],getAudioTracks:()=>[t]};}});await h.client.connect();
 const pc=h.pc,normal=pc.channel.send.bind(pc.channel),updates=[];
 pc.channel.send=value=>{const event=JSON.parse(value);if(event.type==='session.update'){pc.channel.sent.push(event);updates.push(event);}else normal(value);};
 const first=h.client.setVoice(true);first.catch(()=>{});await tick();const off=h.client.setVoice(false);await tick();const last=h.client.setVoice(true);await tick();
 assert.equal(updates.length,1,'only one configuration can await acknowledgement');
 pc.channel.event({type:'session.updated'});await tick();
 pc.channel.event({type:'session.updated'});await tick();
 pc.channel.event({type:'session.updated'});await tick();
 await assert.rejects(first);await off;await last;
 assert.equal(h.events.filter(e=>e.type==='voice').at(-1).enabled,true);await h.client.disconnect();
});
test('cancelled response does not execute partial function calls',async()=>{
 const h=harness();await h.client.connect();await h.client.sendText('hola');
 h.pc.channel.event({type:'response.done',response:{id:'cancelled',status:'cancelled',output:[{type:'function_call',call_id:'c',name:'get_cotizador_context',arguments:'{}'}]}});
 await tick();assert(!h.events.some(e=>e.type==='action'));await h.client.disconnect();
});
test('connection timeout rejects an SDP fetch that never settles',async()=>{
 const h=harness({upstream:()=>new Promise(()=>{})});const client=createRealtimeClient({endpoint:'/session',executeTool:async()=>({}),onEvent:e=>h.events.push(e),connectionTimeoutMs:15});
 await assert.rejects(client.connect());assert.equal(Peer.instances.at(-1).closed,true);await client.disconnect();
});
test('disconnect during offer creation rejects promptly without a late error event',async()=>{
 const h=harness();let offer;const original=Peer.prototype.createOffer;Peer.prototype.createOffer=()=>new Promise(resolve=>{offer=resolve;});
 const pending=h.client.connect();pending.catch(()=>{});await tick();await h.client.disconnect();const count=h.events.length;
 offer({type:'offer',sdp:'v=0'});await assert.rejects(pending);await tick();
 Peer.prototype.createOffer=original;assert.equal(h.events.length,count,'intentional close does not display a later connection failure');
});
test('late tool completion after disconnect cannot write output or execute following calls',async()=>{
 const h=harness();let release;const calls=[];const client=createRealtimeClient({endpoint:'/session',onEvent:e=>h.events.push(e),executeTool:async(_name,args)=>{calls.push(args.n);await new Promise(resolve=>{release=resolve;});return {ok:true};}});
 await client.connect();const pc=Peer.instances.at(-1);await client.sendText('cambia');
 pc.channel.event({type:'response.done',response:{id:'r',output:[1,2].map(n=>({type:'function_call',call_id:'c'+n,name:'get_cotizador_context',arguments:JSON.stringify({n})}))}});
 await tick();await client.disconnect();const count=pc.channel.sent.length;release();await tick();
 assert.deepEqual(calls,[1]);assert.equal(pc.channel.sent.length,count);assert(!h.events.some(e=>e.type==='action'));
});
test('unknown function and invalid JSON return safe failures to the model',async()=>{
 const h=harness();await h.client.connect();await h.client.sendText('hola');
 h.pc.channel.event({type:'response.done',response:{id:'r',output:[{type:'function_call',call_id:'x',name:'unknown',arguments:'{}'},{type:'function_call',call_id:'y',name:'get_cotizador_context',arguments:'not json'}]}});
 await tick();const outputs=h.pc.channel.sent.filter(e=>e.item?.type==='function_call_output');assert.equal(outputs.length,2);assert(outputs.every(e=>JSON.parse(e.item.output).ok===false));await h.client.disconnect();
});
test('configuration acknowledgements gate text sending',async()=>{
 const h=harness();const original=Channel.prototype.send;let waiting=false;
 Channel.prototype.send=function(value){const event=JSON.parse(value);if(event.type==='session.update'){this.sent.push(event);waiting=true;}else original.call(this,value);};
 const pending=h.client.connect();await tick();assert.equal(waiting,true);
 const text=h.client.sendText('hola');await tick();assert.equal(h.pc.channel.sent.some(e=>e.type==='response.create'),false);
 h.pc.channel.event({type:'session.updated'});await pending;await text;assert.equal(h.pc.channel.sent.some(e=>e.type==='response.create'),true);
 Channel.prototype.send=original;await h.client.disconnect();
});
test('voice off during initial voice connection cancels the microphone intent',async()=>{
 let answer;const h=harness({upstream:()=>new Promise(resolve=>{answer=resolve;})});const pending=h.client.connect({voice:true});await tick();await h.client.setVoice(false);answer(new Response('v=0'));
 await pending;assert.equal(h.micCalls,0);await h.client.disconnect();
});
test('reconnect starts a fresh conversation and emits user audio transcripts',async()=>{
 const h=harness();await h.client.connect();const old=h.pc;await h.client.disconnect();await h.client.connect();assert.notEqual(h.pc,old);
 h.pc.channel.event({type:'conversation.item.input_audio_transcription.completed',item_id:'spoken',transcript:'dos grupos'});
 assert.deepEqual(h.events.filter(e=>e.type==='message').at(-1),{type:'message',id:'spoken',role:'user',text:'dos grupos',final:true});await h.client.disconnect();
});
test('late audio playback rejection after disconnect emits no stale error',async()=>{
 const track={stop(){}},stream={getTracks:()=>[track],getAudioTracks:()=>[track]};const h=harness({mic:async()=>stream});await h.client.connect();await h.client.setVoice(true);
 let rejectPlay;h.audio.play=()=>new Promise((_resolve,reject)=>{rejectPlay=reject;});h.pc.ontrack({streams:[stream],track});
 await h.client.disconnect();const count=h.events.length;rejectPlay(new Error('autoplay denied'));await tick();assert.equal(h.events.length,count);
});
test('rejected response.create releases queued turns only for its matching event id',async()=>{
 const h=harness();await h.client.connect();await h.client.sendText('primero');await h.client.sendText('segundo');
 const first=h.pc.channel.sent.find(e=>e.type==='response.create');assert.equal(typeof first.event_id,'string');
 h.pc.channel.event({type:'error',error:{code:'invalid_request_error',event_id:'unrelated'}});await tick();
 assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,1);
 h.pc.channel.event({type:'error',error:{code:'rate_limit_exceeded',event_id:first.event_id}});await tick();
 await h.client.sendText('reintento');
 assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,2);
 assert.equal(h.pc.channel.sent.filter(e=>e.item?.type==='message').length,2,'next queued user item is sent after rejection');
 await h.client.disconnect();
});
test('response.create error allows a later manual retry without reopening transport',async()=>{
 const h=harness();await h.client.connect();await h.client.sendText('primero');
 const first=h.pc.channel.sent.find(e=>e.type==='response.create');
 h.pc.channel.event({type:'error',error:{code:'rate_limit_exceeded',event_id:first.event_id}});
 await h.client.sendText('reintentar');assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,2);
 assert.equal(h.pc.channel.sent.filter(e=>e.item?.type==='message').length,2);await h.client.disconnect();
});
test('late error for an acknowledged request cannot clear a running response',async()=>{
 const h=harness();await h.client.connect();await h.client.sendText('primero');
 const first=h.pc.channel.sent.find(e=>e.type==='response.create');h.pc.channel.event({type:'response.created',response:{id:'r1'}});
 h.pc.channel.event({type:'error',error:{event_id:first.event_id}});await h.client.sendText('segundo');
 assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,1);
 h.pc.channel.event({type:'response.done',response:{id:'r1',output:[]}});await tick();
 assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,2);await h.client.disconnect();
});
test('voice-off cancellation completing at the server is harmless and cannot release a newer response',async()=>{
 const track={stop(){}},stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 const h=harness({mic:async()=>stream});await h.client.connect();await h.client.setVoice(true);
 await h.client.sendText('hola');h.pc.channel.event({type:'response.created',response:{id:'old'}});
 await h.client.setVoice(false);
 const cancel=h.pc.channel.sent.find(e=>e.type==='response.cancel');
 assert.equal(typeof cancel.event_id,'string');
 h.pc.channel.event({type:'response.done',response:{id:'old',status:'completed',output:[]}});await tick();
 await h.client.sendText('otra');h.pc.channel.event({type:'response.created',response:{id:'new'}});
 h.pc.channel.event({type:'error',error:{code:'response_cancel_not_active',event_id:cancel.event_id}});
 assert.equal(h.events.filter(e=>e.type==='error').length,0);
 await h.client.sendText('espera');
 assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,2);
 h.pc.channel.event({type:'response.done',response:{id:'new',status:'completed',output:[]}});await tick();
 assert.equal(h.pc.channel.sent.filter(e=>e.type==='response.create').length,3);
 await h.client.disconnect();
});
test('unrelated cancellation errors remain visible',async()=>{
 const h=harness();await h.client.connect();
 h.pc.channel.event({type:'error',error:{code:'response_cancel_not_active',event_id:'unknown'}});
 assert.equal(h.events.filter(e=>e.type==='error').length,1);
 await h.client.disconnect();
});
const activities = h => h.events.filter(e=>e.type==='activity').map(e=>e.state);
const microphone = () => {const track={stop(){}};return {getTracks:()=>[track],getAudioTracks:()=>[track]};};
test('activity changes from text thinking to idle without duplicate deltas',async()=>{
 const h=harness();await h.client.connect();await h.client.sendText('hola');
 assert.deepEqual(activities(h),['thinking']);
 h.pc.channel.event({type:'response.created',response:{id:'r'}});
 h.pc.channel.event({type:'response.output_text.delta',item_id:'m',delta:'hola'});
 assert.deepEqual(activities(h),['thinking']);
 h.pc.channel.event({type:'response.done',response:{id:'r',status:'completed',output:[]}});await tick();
 assert.deepEqual(activities(h),['thinking','idle']);await h.client.disconnect();
});
test('voice activity follows playback buffers even after response completion',async()=>{
 const h=harness({mic:async()=>microphone()});await h.client.connect();await h.client.setVoice(true);
 assert.deepEqual(activities(h),['listening']);await h.client.sendText('hola');
 h.pc.channel.event({type:'response.created',response:{id:'r'}});
 h.pc.channel.event({type:'response.output_audio_transcript.delta',item_id:'m',delta:'hola'});
 assert.equal(activities(h).at(-1),'thinking');
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'r'});
 assert.equal(activities(h).at(-1),'speaking');
 h.pc.channel.event({type:'response.done',response:{id:'r',status:'completed',output:[]}});await tick();
 assert.equal(activities(h).at(-1),'speaking');
 h.pc.channel.event({type:'output_audio_buffer.stopped',response_id:'r'});
 assert.equal(activities(h).at(-1),'listening');await h.client.disconnect();
});
test('activity remains acting during asynchronous tools then thinking through continuation',async()=>{
 const h=harness();let release;
 const client=createRealtimeClient({endpoint:'/session',onEvent:e=>h.events.push(e),executeTool:()=>new Promise(resolve=>{release=resolve;})});
 await client.connect();await client.sendText('actúa');const pc=Peer.instances.at(-1);
 pc.channel.event({type:'response.done',response:{id:'r',status:'completed',output:[{type:'function_call',call_id:'c',name:'get_cotizador_context',arguments:'{}'}]}});await tick();
 assert.equal(activities(h).at(-1),'acting');release({ok:true});await tick();
 assert.equal(activities(h).at(-1),'thinking');
 pc.channel.event({type:'response.done',response:{id:'next',status:'completed',output:[]}});await tick();
 assert.equal(activities(h).at(-1),'idle');await client.disconnect();
});
test('interruption clears speaking immediately and stale playback cannot revive it',async()=>{
 const h=harness({mic:async()=>microphone()});await h.client.connect();await h.client.setVoice(true);await h.client.sendText('hola');
 h.pc.channel.event({type:'response.created',response:{id:'old'}});
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'old'});
 h.pc.channel.event({type:'input_audio_buffer.speech_started'});
 assert.equal(activities(h).at(-1),'listening');
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'old'});
 h.pc.channel.event({type:'response.done',response:{id:'old',status:'cancelled',output:[]}});await tick();
 assert.equal(activities(h).at(-1),'listening');await h.client.disconnect();
});
test('voice off and disconnect clear playback and suppress stale transport events',async()=>{
 const h=harness({mic:async()=>microphone()});await h.client.connect();await h.client.setVoice(true);await h.client.sendText('hola');
 h.pc.channel.event({type:'response.created',response:{id:'old'}});
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'old'});
 await h.client.setVoice(false);assert.equal(activities(h).at(-1),'idle');
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'old'});
 assert.equal(activities(h).at(-1),'idle');await h.client.disconnect();const count=h.events.length;
 h.pc.channel.event({type:'response.created',response:{id:'late'}});
 assert.equal(h.events.length,count);
});
test('rejected response request releases thinking and failed responses leave no stuck activity',async()=>{
 const h=harness();await h.client.connect();await h.client.sendText('hola');
 const request=h.pc.channel.sent.find(e=>e.type==='response.create');
 h.pc.channel.event({type:'error',error:{event_id:request.event_id}});
 assert.equal(activities(h).at(-1),'idle');await h.client.sendText('otra');
 h.pc.channel.event({type:'response.done',response:{id:'r',status:'failed',output:[]}});await tick();
 assert.equal(activities(h).at(-1),'idle');await h.client.disconnect();
});
test('closing a channel during a tool leaves activity idle after its late completion',async()=>{
 const h=harness();let release;
 const client=createRealtimeClient({endpoint:'/session',onEvent:e=>h.events.push(e),executeTool:()=>new Promise(resolve=>{release=resolve;})});
 await client.connect();await client.sendText('actúa');const pc=Peer.instances.at(-1);
 pc.channel.event({type:'response.done',response:{id:'r',output:[{type:'function_call',call_id:'c',name:'get_cotizador_context',arguments:'{}'}]}});await tick();
 pc.channel.onclose();assert.equal(activities(h).at(-1),'idle');const count=h.events.length;
 release({ok:true});await tick();assert.equal(h.events.length,count);
});

test('completed response can start playback late, but stopped playback cannot restart from stale events',async()=>{
 const h=harness({mic:async()=>microphone()});await h.client.connect();await h.client.setVoice(true);await h.client.sendText('hola');
 h.pc.channel.event({type:'response.created',response:{id:'r'}});
 h.pc.channel.event({type:'response.done',response:{id:'r',status:'completed',output:[]}});await tick();
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'r'});assert.equal(activities(h).at(-1),'speaking');
 h.pc.channel.event({type:'output_audio_buffer.stopped',response_id:'r'});assert.equal(activities(h).at(-1),'listening');
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'r'});assert.equal(activities(h).at(-1),'listening');
 await h.client.disconnect();
});
test('cleared buffers return to thinking and old stop events cannot stop newer playback',async()=>{
 const h=harness({mic:async()=>microphone()});await h.client.connect();await h.client.setVoice(true);await h.client.sendText('uno');
 h.pc.channel.event({type:'response.created',response:{id:'old'}});
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'old'});
 h.pc.channel.event({type:'output_audio_buffer.cleared',response_id:'old'});assert.equal(activities(h).at(-1),'thinking');
 h.pc.channel.event({type:'response.done',response:{id:'old',status:'completed',output:[]}});await tick();
 await h.client.sendText('dos');h.pc.channel.event({type:'response.created',response:{id:'new'}});
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'new'});
 h.pc.channel.event({type:'output_audio_buffer.stopped',response_id:'old'});assert.equal(activities(h).at(-1),'speaking');
 await h.client.disconnect();assert.equal(activities(h).at(-1),'idle');
});
test('cancellation before response acknowledgement cannot revive playback during the next turn',async()=>{
 const h=harness({mic:async()=>microphone()});await h.client.connect();await h.client.setVoice(true);await h.client.sendText('uno');
 h.pc.channel.event({type:'input_audio_buffer.speech_started'});
 h.pc.channel.event({type:'response.done',response:{id:'old',status:'cancelled',output:[]}});await tick();
 h.pc.channel.event({type:'input_audio_buffer.committed'});
 h.pc.channel.event({type:'response.created',response:{id:'new'}});
 h.pc.channel.event({type:'output_audio_buffer.started',response_id:'old'});assert.equal(activities(h).at(-1),'thinking');
 await h.client.disconnect();
});
