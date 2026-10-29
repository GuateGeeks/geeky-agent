import { MAX_TEXT_LENGTH, TOOL_NAMES } from './protocol.mjs';

// Browser transport only. All commercial decisions and validation belong to executeTool.
export function createRealtimeClient({endpoint,executeTool,onEvent = ()=>{},connectionTimeoutMs = 20000} = {}) {
 if(typeof endpoint!=='string'||!endpoint.trim()) throw new TypeError('Configura el endpoint del asistente.');
 if(typeof executeTool!=='function') throw new TypeError('Falta el adaptador de herramientas.');
 let session=null, connecting=null, voiceVersion=0, sequence=0, activityState='idle';
 const emit = event => { try {onEvent(event);} catch {/* host listeners do not own transport lifecycle */} };
 const failure = message => {emit({type:'error',message});return new Error(message);};
 const alive = s => session===s && !s.abort.signal.aborted;
 const stop = stream => stream?.getTracks().forEach(track=>track.stop());
 const send = (s,event) => {
  if(!alive(s)||s.dc.readyState!=='open') throw new Error('El asistente está desconectado.');
  s.dc.send(JSON.stringify(event));
 };
 function activity(s) {
  const state=!alive(s)?'idle':s.acting?'acting':s.playback?'speaking':(s.active&&!s.interrupted)||s.continue||s.processing?'thinking':s.voice?'listening':'idle';
  if(state!==activityState){activityState=state;emit({type:'activity',state});}
 }
 function retirePlayback(s,id) {
  if(!id)return;
  s.silentResponses.add(id);
  if(s.silentResponses.size>1000)s.silentResponses.delete(s.silentResponses.values().next().value);
 }
 function clearPlayback(s) {
  for(const id of [s.responseId,s.playback])retirePlayback(s,id);
  s.playback=null;s.interrupted=true;activity(s);
 }
 function cancelResponse(s) {
  if(!s.active)return;
  const id='cancel_'+(++sequence);
  s.cancelRequests.add(id);
  if(s.cancelRequests.size>100)s.cancelRequests.delete(s.cancelRequests.values().next().value);
  send(s,{type:'response.cancel',event_id:id});
 }
 function silence(s) {
  s.voice=false;clearPlayback(s);stop(s.mic);s.mic=null;
  if(s.audio){s.audio.muted=true;s.audio.pause();s.audio.srcObject=null;}
  // replaceTrack(null) starts immediately; callers await it when connected.
  return s.sender?.replaceTrack(null);
 }
 function cleanup(s) {
  s.abort.abort();clearTimeout(s.timer);
  s.rejectOpen?.(new Error('Conexión cancelada.'));
  s.updateWait?.reject(new Error('Conexión cancelada.'));
  silence(s)?.catch(()=>{});
  s.dc?.close();s.pc?.close();
  s.pendingCalls.clear();s.cancelRequests.clear();s.turns.length=0;s.messages.clear();
 }
 async function disconnect() {
  voiceVersion++;
  const s=session;session=null;connecting=null;
  if(s){cleanup(s);activity(s);}
  emit({type:'voice',enabled:false});emit({type:'status',status:'disconnected'});
 }
 function message(s,id,role,text,final,index=0,delta=false) {
  if(!id||typeof text!=='string') return;
  let item=s.messages.get(id);
  if(!item){if(s.messages.size>=500)s.messages.delete(s.messages.keys().next().value);item={parts:new Map(),final:false};s.messages.set(id,item);}
  if(item.final) return;
  item.parts.set(index,delta?(item.parts.get(index)||'')+text:text);
  const full=[...item.parts.entries()].sort((a,b)=>a[0]-b[0]).map(([,part])=>part).join('');
  item.final=final;
  emit({type:'message',id,role,text:full,final});
 }
 function pump(s) {
  if(!alive(s)||s.active||s.processing||s.configuring||(!s.continue&&!s.turns.length))return;
  for(const turn of s.turns.splice(0)) if(turn.text){
   send(s,{type:'conversation.item.create',item:{id:turn.id,type:'message',role:'user',content:[{type:'input_text',text:turn.text}]}});
  }
  s.continue=false;s.active=true;s.interrupted=false;s.responseRequestId='response_'+(++sequence);activity(s);
  send(s,{type:'response.create',event_id:s.responseRequestId,response:{output_modalities:[s.voice?'audio':'text']}});
 }
 function updateSession(s,voice) {
  s.configuring++;
  const operation=(s.configChain||Promise.resolve()).catch(()=>{}).then(()=>{
   if(!alive(s))throw new Error('Conexión cancelada.');
   return new Promise((resolve,reject)=>{
    const id='cfg_'+(++sequence);
    const timer=setTimeout(()=>{s.updateWait=null;reject(new Error('El asistente no confirmó su configuración.'));},connectionTimeoutMs);
    s.updateWait={id,resolve:()=>{clearTimeout(timer);s.updateWait=null;resolve();},reject:error=>{clearTimeout(timer);s.updateWait=null;reject(error);}};
    try{send(s,{type:'session.update',event_id:id,session:{type:'realtime',output_modalities:[voice?'audio':'text'],audio:{input:{turn_detection:voice?{type:'server_vad',create_response:false,interrupt_response:false}:null}}}});}
    catch(error){s.updateWait.reject(error);}
   });
  });
  s.configChain=operation;
  return operation.finally(()=>{s.configuring--;});
 }
 async function finishResponse(s,event) {
  const response=event.response||{},id=response.id;
  if(id&&s.done.has(id))return;
  if(id){s.done.add(id);if(s.done.size>1000)s.done.delete(s.done.values().next().value);}
  if(s.interrupted||(response.status&&response.status!=='completed'))retirePlayback(s,id);
  s.active=false;s.responseId=null;s.responseRequestId=null;s.processing=true;
  const calls=[...(response.output||[]).filter(item=>item.type==='function_call')];
  for(const call of s.pendingCalls.values()) if(call.response_id===id&&!calls.some(item=>item.call_id===call.call_id))calls.push(call);
  for(const call of calls)s.pendingCalls.delete(call.call_id);
  let outputs=0;
  try {
   for(const item of response.output||[]) if(item.type==='message'&&item.role==='assistant')
    for(const [index,part] of (item.content||[]).entries()) if(typeof (part.text??part.transcript)==='string') message(s,item.id,'assistant',part.text??part.transcript,true,index);
   if(response.status==='failed') emit({type:'error',message:'El asistente no pudo completar su respuesta. Intenta de nuevo.'});
   if(response.status && response.status!=='completed')return;
   for(const call of calls){
    if(!alive(s))return;
    if(!call.call_id||s.calls.has(call.call_id))continue;
    s.calls.add(call.call_id);
    let result;
    try{
     if(!TOOL_NAMES.includes(call.name)||typeof call.arguments!=='string'||call.arguments.length>16384)throw new Error();
     const args=JSON.parse(call.arguments);
     if(!args||typeof args!=='object'||Array.isArray(args))throw new Error();
     s.acting=true;activity(s);
     try{result=await executeTool(call.name,args);}finally{s.acting=false;}
     if(result===undefined)result={ok:false,error:'La herramienta no devolvió un resultado.'};
     // Check serializability before emitting or sending.
     JSON.stringify(result);
    }catch{result={ok:false,error:'No se pudo ejecutar esta acción. Consulta el contexto e inténtalo de nuevo.'};}
    if(!alive(s))return;
    send(s,{type:'conversation.item.create',item:{type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)}});
    emit({type:'action',name:call.name,result});outputs++;
   }
  }finally{
   s.processing=false;
   if(alive(s)){s.continue ||= outputs>0;pump(s);activity(s);}
  }
 }
 function receive(s,event) {
  if(!alive(s)||typeof event.data!=='string'||event.data.length>262144)return;
  let e;try{e=JSON.parse(event.data);}catch{return;}
  if(e.type==='session.updated'){s.updateWait?.resolve();return;}
  if(e.type==='error'){
   // Completion can win a voice-off/interrupt cancellation. Ignore only our matching no-op.
   const ownCancel=s.cancelRequests.delete(e.error?.event_id);
   if(ownCancel && e.error?.code==='response_cancel_not_active')return;
   if(s.updateWait && e.error?.event_id===s.updateWait.id)s.updateWait.reject(new Error('El asistente rechazó la configuración.'));
   emit({type:'error',message:'El asistente encontró un error. Intenta de nuevo.'});
   // A rejected response.create has no response.done. Release only its unacknowledged request.
   if(s.responseRequestId && e.error?.event_id===s.responseRequestId){s.active=false;s.responseRequestId=null;pump(s);activity(s);}return;
  }
  if(e.type==='response.created'){
   if(!s.active||s.done.has(e.response?.id)||s.silentResponses.has(e.response?.id))return;
   s.responseId=e.response?.id;s.responseRequestId=null;activity(s);return;
  }
  if(e.type==='output_audio_buffer.started'){
   if(s.voice&&!s.interrupted&&!s.silentResponses.has(e.response_id)){s.playback=e.response_id||true;activity(s);}return;
  }
  if(['output_audio_buffer.stopped','output_audio_buffer.cleared'].includes(e.type)){
   retirePlayback(s,e.response_id||s.playback);
   if(!e.response_id||s.playback===e.response_id){s.playback=null;activity(s);}return;
  }
  if(e.type==='response.function_call_arguments.done'){
   if(e.call_id&&s.pendingCalls.size<100)s.pendingCalls.set(e.call_id,e);return;
  }
  if(e.type==='response.done'){finishResponse(s,e).catch(()=>{if(alive(s))emit({type:'error',message:'No se pudo completar la acción.'});});return;}
  if(e.type==='input_audio_buffer.speech_started'){
   if(!s.voice)return;
   clearPlayback(s);cancelResponse(s);
   send(s,{type:'output_audio_buffer.clear'});return;
  }
  if(e.type==='input_audio_buffer.committed'){if(s.voice){s.turns.push({});pump(s);}return;}
  if(e.type==='conversation.item.input_audio_transcription.completed'){message(s,e.item_id,'user',e.transcript,true);return;}
  if(e.type==='conversation.item.input_audio_transcription.failed'){emit({type:'error',message:'No se pudo transcribir el audio. Puedes escribir tu mensaje.'});return;}
  const delta=['response.output_text.delta','response.output_audio_transcript.delta'].includes(e.type);
  const done=['response.output_text.done','response.output_audio_transcript.done'].includes(e.type);
  if(delta||done)message(s,e.item_id,'assistant',delta?e.delta:(e.text??e.transcript),done,e.content_index||0,delta);
 }
 async function connect({voice=false}={}) {
  const requestedVoiceVersion=voiceVersion;
  if(connecting){await connecting;if(voice&&requestedVoiceVersion===voiceVersion)await setVoice(true);return;}
  if(session?.ready){if(voice)await setVoice(true);return;}
  const s={abort:new AbortController(),ready:false,voice:false,active:false,processing:false,acting:false,playback:null,interrupted:false,silentResponses:new Set(),configuring:0,continue:false,turns:[],pendingCalls:new Map(),cancelRequests:new Set(),calls:new Set(),done:new Set(),messages:new Map()};
  session=s;emit({type:'status',status:'connecting'});
  const operation=(async()=>{
   try{
    s.pc=new RTCPeerConnection();
    s.sender=s.pc.addTransceiver('audio',{direction:'sendrecv'}).sender;
    s.audio=new Audio();s.audio.autoplay=false;s.audio.muted=true;
    s.pc.ontrack=event=>{if(!alive(s))return;s.remote=event.streams?.[0]||new MediaStream([event.track]);if(s.voice){s.audio.srcObject=s.remote;s.audio.play().catch(()=>{if(alive(s)&&s.voice)emit({type:'error',message:'Activa la reproducción de audio en tu navegador.'});});}};
    s.pc.onconnectionstatechange=()=>{if(alive(s)&&['failed','closed'].includes(s.pc.connectionState)){failure('Se perdió la conexión con el asistente.');disconnect();}};
    s.dc=s.pc.createDataChannel('oai-events');
    const opened=new Promise((resolve,reject)=>{s.rejectOpen=reject;s.dc.onopen=resolve;s.dc.onerror=()=>reject(new Error('No se pudo abrir el canal del asistente.'));s.dc.onclose=()=>{if(alive(s)){failure('Se cerró la conexión con el asistente.');disconnect();}};});
    // Avoid an unhandled rejection when disconnect wins the handshake.
    opened.catch(()=>{});
    s.dc.onmessage=event=>receive(s,event);
    const offer=await s.pc.createOffer();if(!alive(s))throw new Error();
    await s.pc.setLocalDescription(offer);if(!alive(s))throw new Error();
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/sdp'},body:s.pc.localDescription.sdp,signal:s.abort.signal,credentials:'omit'});
    if(!alive(s))throw new Error();
    if(!response.ok)throw new Error('backend');
    const sdp=await response.text();if(!alive(s))throw new Error();
    if(!sdp.startsWith('v=0'))throw new Error('sdp');
    await s.pc.setRemoteDescription({type:'answer',sdp});await opened;
    if(!alive(s))throw new Error();
    await updateSession(s,false);
    if(!alive(s))throw new Error();
    s.ready=true;emit({type:'status',status:'connected'});emit({type:'voice',enabled:false});
   }catch{
    if(alive(s)){session=null;cleanup(s);emit({type:'status',status:'disconnected'});throw failure('No se pudo conectar con Geeky. Revisa el servicio del asistente e intenta de nuevo.');}
    throw new Error('Conexión cancelada.');
   }
  })();
  let rejectTimeout;
  const cancelled=new Promise((_,reject)=>{rejectTimeout=reject;s.abort.signal.addEventListener('abort',()=>reject(new Error('Conexión cancelada.')),{once:true});});
  s.timer=setTimeout(()=>{rejectTimeout(new Error('Tiempo de conexión agotado.'));if(alive(s)){session=null;cleanup(s);emit({type:'status',status:'disconnected'});emit({type:'error',message:'La conexión tardó demasiado.'});}},connectionTimeoutMs);
  const pending=Promise.race([operation,cancelled]);
  connecting=pending;
  try{await pending;}finally{clearTimeout(s.timer);if(connecting===pending)connecting=null;}
  if(voice&&requestedVoiceVersion===voiceVersion){try{await setVoice(true);}catch{/* text remains ready; setVoice emitted its actionable error */}}
 }
 async function sendText(text) {
  if(typeof text!=='string'||!text.trim()||text.length>MAX_TEXT_LENGTH)throw failure('Escribe entre 1 y '+MAX_TEXT_LENGTH+' caracteres.');
  await connect();
  const s=session;if(!s?.ready)throw failure('El asistente está desconectado.');
  if(s.turns.length>=20)throw failure('Espera a que Geeky termine de responder.');
  const id='gg_user_'+(++sequence);
  s.turns.push({id,text:text.trim()});message(s,id,'user',text.trim(),true);pump(s);
 }
 async function setVoice(enabled) {
  const version=++voiceVersion;
  if(!enabled){
   const s=session;if(!s){emit({type:'voice',enabled:false});return;}
   const detached=silence(s);
   if(s.ready){cancelResponse(s);send(s,{type:'output_audio_buffer.clear'});send(s,{type:'input_audio_buffer.clear'});}
   emit({type:'voice',enabled:false});
   await detached;
   if(alive(s)&&s.ready){await updateSession(s,false);pump(s);}
   return;
  }
  await connect();const s=session;
  if(version!==voiceVersion||!s?.ready)throw new Error('Activación de voz cancelada.');
  if(s.voice)return;
  let stream;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
  catch{if(alive(s)&&version===voiceVersion){emit({type:'voice',enabled:false});throw failure('No se pudo activar el micrófono. Puedes seguir escribiendo.');}throw new Error('Activación de voz cancelada.');}
  if(!alive(s)||version!==voiceVersion){stop(stream);throw new Error('Activación de voz cancelada.');}
  try{
   await s.sender.replaceTrack(stream.getAudioTracks()[0]);
   if(!alive(s)||version!==voiceVersion){stop(stream);await s.sender.replaceTrack(null);throw new Error();}
   s.mic=stream;
   cancelResponse(s);
   await updateSession(s,true);
   if(!alive(s)||version!==voiceVersion){stop(stream);throw new Error();}
   s.voice=true;s.audio.muted=false;s.audio.srcObject=s.remote||null;
   if(s.remote)await s.audio.play();
   emit({type:'voice',enabled:true});pump(s);activity(s);
  }catch{
   stop(stream);if(alive(s)&&version===voiceVersion){await silence(s);emit({type:'voice',enabled:false});throw failure('No se pudo activar la voz. Puedes seguir escribiendo.');}
   throw new Error('Activación de voz cancelada.');
  }
 }
 return {connect,sendText,setVoice,disconnect};
}
