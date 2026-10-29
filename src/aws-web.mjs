import { createAgentServer } from './server.mjs';
import { createSecretKeyProvider } from './secrets.mjs';

// Native Lambda Web Functions run an HTTP server, rather than an event handler.
export function startWebFunction({env=process.env,apiKeyProvider}={}) {
 const endpoint=env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:8787';
 const match=/^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(endpoint);
 if(!match || Number(match[2])>65535)throw new Error('Dirección HTTP del runtime inválida.');
 const host=match[1].replace(/^\[|\]$/g,''),port=Number(match[2]);
 const provider=apiKeyProvider || createSecretKeyProvider({
  secretId:env.OPENAI_API_KEY_SECRET_ID || '',
  region:env.OPENAI_API_KEY_SECRET_REGION || env.AWS_REGION
 });
 const server=createAgentServer({
  apiKey:'',apiKeyProvider:provider,
  model:env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini',
  ...(env.ALLOWED_ORIGINS ? {allowedOrigins:env.ALLOWED_ORIGINS.split(',')} : {})
 });
 server.listen(port,host);
 return server;
}
