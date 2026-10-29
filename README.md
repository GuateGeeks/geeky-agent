# Geeky Agent

A dependency-free Node 22 session endpoint and reusable browser WebRTC client for GuateGeeks' Spanish quotation assistant. The host owns its commercial engine, validation, revision checks and undo. This repository owns the OpenAI connection and four fixed function-tool envelopes.

## Local setup

1. Install Node 22. No runtime packages are required.
2. Copy `.env.example` to `.env` and set a server-side `OPENAI_API_KEY`. Never put the key in frontend configuration.
3. Set `ALLOWED_ORIGINS` to the exact origins serving your UI, separated by commas. Defaults allow `http://127.0.0.1:8087` and `http://localhost:8087`.
4. Run `npm start`. The endpoint listens on `127.0.0.1:8787/session`.
5. Serve the host frontend on one allowed origin and configure its public endpoint URL, e.g. `http://127.0.0.1:8787/session`.

`POST /session` accepts raw `application/sdp` and returns `application/sdp`. The server creates a multipart `sdp` + `session` request to OpenAI's `/v1/realtime/calls`; credentials never reach the browser. The default model is `gpt-realtime-2.1`; `OPENAI_REALTIME_MODEL` changes it explicitly. No session or transcript persistence exists here.

## Host integration

Serve or vendor both `src/client.mjs` and `src/protocol.mjs` together, preserving their relative paths and pinning a source commit. They are native browser ES modules.

```js
import { createRealtimeClient } from './client.mjs';

const agent = createRealtimeClient({
  endpoint: 'https://agent.example/session',
  executeTool: (name, args) => window.GGCotizadorAgent.executeTool(name, args),
  onEvent: event => renderAgentEvent(event)
});
await agent.sendText('Quiero explorar robótica para primaria');
await agent.setVoice(true); // explicit user activation
await agent.setVoice(false); // stops microphone tracks and playback, preserves session
await agent.disconnect(); // close panel / leave page
```

Methods: `connect({voice=false}={})`, `sendText(text)`, `setVoice(enabled)`, `disconnect()`. These return promises. First text send connects automatically. Text never requests microphone permission. `connect({voice:true})` keeps a usable text connection if microphone permission fails; `setVoice(true)` rejects and emits an actionable error on failure. A browser secure context (HTTPS or localhost), WebRTC, media permission and autoplay policy govern voice availability.

Events are plain objects:

- `{type:'status', status:'connecting'|'connected'|'disconnected'}`
- `{type:'message', id, role:'user'|'assistant', text, final:boolean}`: replace the text of the same id as it streams. The client emits the user's text once; the UI must not duplicate it. Render with textContent, never HTML.
- `{type:'voice', enabled:boolean}`
- `{type:'error', message}`: safe user-facing text, no raw upstream errors.
- `{type:'action', name, result}`: one completed host-tool result.

Connection and session-configuration acknowledgements have a 20-second timeout. Voice toggles serialize configuration updates; disabling voice invalidates pending microphone requests and stops late tracks. A silent send/receive audio transceiver is created even in text mode, allowing later microphone `replaceTrack` without SDP renegotiation. No microphone is acquired until explicit voice activation.

Text is limited to 4,000 characters and up to 20 queued turns. The client serializes responses and function execution. It processes all completed function calls in a response sequentially, deduplicates call ids, sends all results, then requests one continuation. Voice input uses server VAD with automatic response generation disabled; the client schedules responses to keep tools and text turns serialized. Disconnect aborts setup and suppresses stale transport/tool completions. A host callback already executing cannot be rolled back by transport cancellation; hosts must validate and apply mutations atomically.

## Host tools

The host's `executeTool(name,args)` returns a JSON-serializable result:

- `get_cotizador_context({})`: catalog, ids, revision, exact allowed action schemas, authoritative engine totals/pending/warnings and scene capabilities.
- `update_cotizador({action,args,expectedRevision})`: validated atomic mutation; `{ok,revision,message,context}` or `{ok:false,error,...}`.
- `control_campus({action,args})`: validated bounded focus, view, rotate, zoom, reset, pause, show or Geeky gesture.
- `undo_cotizador({expectedRevision})`: revision-safe undo.

The server envelope enumerates permitted actions while argument shapes come from current host context. The model is instructed to read context before changing the quote, use engine results, respect conflicts and never invent prices or services. Host validation, rather than model instruction alone, enforces these rules. No commercial calculations belong here.

## Deployment and access controls

Set `HOST=0.0.0.0` for a container; place the service behind HTTPS. Configure `ALLOWED_ORIGINS` for your actual production frontend. No wildcard origins, cookies or browser-held API keys are used.

CORS restricts browser origins; it is **not authentication**, and a nonbrowser caller can spoof Origin. Before public deployment, add application access controls or a suitable edge challenge, shared edge rate limiting, OpenAI project spending limits, and a TLS reverse proxy. The built-in limits are per-process safeguards: 64 KiB request/answer body, 20-second upstream timeout, 10 session attempts per IP/minute, 100 globally/minute, 20 concurrent upstream requests, bounded rate-limit storage, and request/header timeouts. Behind a proxy, socket-IP limiting may aggregate visitors; forwarded headers are deliberately not trusted. Tune constructor options for tests or your deployment adapter.

The endpoint logs no requests, transcripts, tool arguments, upstream errors or credentials. It returns generic redacted failures. Ordinary hosting/proxy logs should also avoid body capture. The server only handles SDP bootstrap; media/data then travel over the browser/OpenAI WebRTC connection. Closing a client stops its media and peer connection. This package neither deploys automatically nor sends proposals.

## Verification

Run `npm test` (`node --test test/*.test.mjs`). Tests exercise HTTP/CORS/limits/redaction and mocked WebRTC: no-microphone text, acknowledgements, voice off, permission denial, connection timeouts, toggle/disconnect races, transcript aggregation, sequential/deduplicated tools and stale completions. Mocks verify lifecycle logic; they do not establish live model availability, microphone quality or real WebRTC interoperability. Perform a credentialed browser text/voice test before production rollout.

Protocol references, consulted 2026-10-28: [OpenAI WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc) and [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).
