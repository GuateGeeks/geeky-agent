# Geeky Realtime Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.
**Goal:** Add Geeky voice/text quotation and campus control, version agent in its own repository.
**Architecture:** Browser WebRTC client + private-key Node endpoint, validated Cotizador adapter, persistent companion UI.
**Tech Stack:** Node 22, plain JavaScript, WebRTC, existing Three.js/esbuild.
**Spec:** docs/superpowers/specs/2026-10-28-geeky-realtime-design.md
## Global Constraints
- Cotizador starts at 47bc933; preserve commercial motor and five-step manual flow.
- Agent repository owns server and transport; Cotizador pins a version.
- Text works without microphone; voice off releases tracks and playback.
- Secrets server-only; do not deploy main.
## Review Focus
Permission denial; voice-toggle/disconnect races; duplicate tool calls; interleaved manual edits; incomplete quotes and unavailable scene.
## Task 1: Agent runtime (geeky-agent)
Files src/client.mjs, src/server.mjs, src/protocol.mjs, test/*.test.mjs, package.json, README.md, .env.example.
Interfaces exactly as Spec Shared contract.
- [ ] Add failing server and browser lifecycle tests; run node --test.
- [ ] Implement documented WebRTC protocol, server endpoint and session/tool instructions.
- [ ] Run tests, document setup and restrictions, commit feature.
## Task 2: Cotizador semantic adapter and campus bridge
Files asesor/agent-adapter.js, asesor/asesor.js, asesor/lab/campus-scene.js, asesor/test/agent-adapter.test.js.
Produces window.GGCotizadorAgent.getContext/executeTool. Use validated transaction API to maintain business rules. Expose exact argument schemas in context.
- [ ] Add failing tests for invalid state, atomicity, revision conflicts and undo.
- [ ] Implement action adapter and bounded scene commands; add host state/derived hooks.
- [ ] Test, regenerate scene bundle and commit scoped files.
## Task 3: Companion UI and packaging
Files asesor/agent-ui.mjs, asesor/agent.css, asesor/agent-config.js, asesor/index.html, tools/sync-geeky-agent.mjs, .github/workflows/pages.yml, docs.
Consumes client and adapter contracts. Endpoint public deployment config, optional default same-origin /session.
- [ ] Add browser smoke harness exercising panel lifecycle and text with fake client, assistant text safely rendered.
- [ ] Implement UI outside #app, startup greeting, transcript, mic/voice toggle, send/close/reconnect, undo and clear actions.
- [ ] Pin client files from agent repo with commit provenance and bundle hashes; update Pages copy/cache.
- [ ] Run full tests/build, browser desktop/mobile screenshots and review.
## Task 4: Delivery
- [ ] Independent review and fix material issues.
- [ ] Version agent repository and open both PRs, attach artifacts. Report tests and any live-service limitation.
