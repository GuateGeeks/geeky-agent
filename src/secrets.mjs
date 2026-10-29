import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const unavailable = () => new Error('Credencial del asistente no disponible.');
function readKey(result) {
 if(typeof result?.SecretString!=='string')throw unavailable();
 const value=result.SecretString.trim();
 let key=value;
 if(value.startsWith('{')) {
  try {key=JSON.parse(value).OPENAI_API_KEY;}catch{throw unavailable();}
 }
 if(typeof key!=='string'||!key.trim()||key.length>4096||/\s/.test(key.trim()))throw unavailable();
 return key.trim();
}
// Credentials use the execution role through the SDK default provider chain.
// No remote request occurs at construction or module import.
export function createSecretKeyProvider({
 secretId=process.env.OPENAI_API_KEY_SECRET_ID || '',
 region=process.env.OPENAI_API_KEY_SECRET_REGION || process.env.AWS_REGION,
 client,cacheTtlMs=300000,timeoutMs=3000,failureTtlMs=1000
}={}) {
 const sdk=client || new SecretsManagerClient({region,maxAttempts:2,requestHandler:{connectionTimeout:1000,requestTimeout:2500}});
 const ttl=Math.max(1,Math.min(Number(cacheTtlMs)||300000,900000));
 const deadline=Math.max(1,Math.min(Number(timeoutMs)||3000,5000));
 const failureTtl=Math.max(0,Math.min(Number(failureTtlMs)||0,30000));
 let cached='',expires=0,pending=null,retryAt=0;
 return async function getApiKey() {
  if(!secretId)throw unavailable();
  if(cached && Date.now()<expires)return cached;
  if(pending)return pending;
  if(Date.now()<retryAt)throw unavailable();
  pending=Promise.resolve().then(async()=>{
   const controller=new AbortController();let timer;
   try {
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},deadline);});
    const request=Promise.resolve().then(()=>sdk.send(new GetSecretValueCommand({SecretId:secretId,VersionStage:'AWSCURRENT'}),{abortSignal:controller.signal}));
    const result=await Promise.race([request,timeout]);
    const key=readKey(result);cached=key;expires=Date.now()+ttl;retryAt=0;
    return key;
   } catch {
    cached='';expires=0;retryAt=Date.now()+failureTtl;
    throw unavailable();
   } finally {clearTimeout(timer);pending=null;}
  });
  return pending;
 };
}
