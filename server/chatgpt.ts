import { createRemoteJWKSet, jwtVerify } from 'jose';
import { decrypt, encrypt } from './crypto.js';
import { ensureChatGPTHost, getChatGPTConnection, saveChatGPTConnection } from './store.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';

export type ChatGPTCredentials = {
  email: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scopes: string[];
  saved_at: string;
};

type OidcConfiguration = { jwks_uri:string; revocation_endpoint:string };
let configurationPromise:Promise<OidcConfiguration>|null=null;
const refreshes=new Map<string,Promise<ChatGPTCredentials>>();

async function configuration(){
  configurationPromise ||= fetch(`${issuer}/.well-known/openid-configuration`).then(async response=>{if(!response.ok)throw new Error('Could not load OpenAI authorization configuration');return response.json() as Promise<OidcConfiguration>});
  return configurationPromise;
}

async function verifyIdentity(credentials:ChatGPTCredentials){
  const metadata=await configuration();
  const {payload}=await jwtVerify(credentials.id_token,createRemoteJWKSet(new URL(metadata.jwks_uri)),{issuer,audience:credentials.client_id});
  if(typeof payload.sub!=='string'||payload.sub!==credentials.subject)throw new Error('ChatGPT credential identity does not match');
  const email=typeof payload.email==='string'?payload.email:credentials.email;
  return{subject:payload.sub,email};
}

function assertBundle(value:unknown):ChatGPTCredentials{
  if(!value||typeof value!=='object')throw new Error('Invalid ChatGPT credential file');
  const item=value as Partial<ChatGPTCredentials>;
  const strings=['email','issuer','subject','client_id','ext_agent_host_id','id_token','access_token','refresh_token','token_type','saved_at'] as const;
  if(strings.some(key=>typeof item[key]!=='string'||!item[key]))throw new Error('ChatGPT credential file is incomplete');
  if(!Array.isArray(item.scopes)||!item.scopes.includes('chatgpt.tokens.use.direct'))throw new Error('ChatGPT plan usage was not authorized');
  if(item.issuer!==issuer||!Number.isFinite(item.expires_in))throw new Error('ChatGPT credential file has invalid metadata');
  return item as ChatGPTCredentials;
}

export async function chatGPTSetup(userId:string){const connection=await ensureChatGPTHost(userId);return{hostId:connection.hostId,connected:!!connection.encryptedCredentials,email:connection.email};}

export async function importChatGPTCredentials(userId:string,value:unknown,verify:(credentials:ChatGPTCredentials)=>Promise<{subject:string;email:string}>=verifyIdentity){
  const credentials=assertBundle(value);const current=await ensureChatGPTHost(userId);
  if(credentials.ext_agent_host_id!==current.hostId)throw new Error('Credential host ID does not match this Orbit installation');
  const identity=await verify(credentials);
  await saveChatGPTConnection({...current,clientId:credentials.client_id,email:identity.email,subject:identity.subject,encryptedCredentials:encrypt(credentials)});
  return{connected:true,email:identity.email};
}

async function refresh(userId:string,credentials:ChatGPTCredentials){
  const body=new URLSearchParams({grant_type:'refresh_token',client_id:credentials.client_id,refresh_token:credentials.refresh_token,resource});
  const response=await fetch(`${issuer}/api/accounts/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!response.ok)throw new Error(`ChatGPT authorization refresh failed (${response.status})`);
  const token=await response.json() as Record<string,unknown>;
  const updated:ChatGPTCredentials={...credentials,access_token:String(token.access_token||''),refresh_token:String(token.refresh_token||''),id_token:String(token.id_token||credentials.id_token),token_type:String(token.token_type||'Bearer'),expires_in:Number(token.expires_in||3600),scopes:typeof token.scope==='string'?token.scope.split(' '):credentials.scopes,saved_at:new Date().toISOString()};
  if(!updated.access_token||!updated.refresh_token)throw new Error('ChatGPT refresh returned incomplete credentials');
  const connection=await getChatGPTConnection(userId);if(!connection)throw new Error('ChatGPT connection is missing');
  await saveChatGPTConnection({...connection,encryptedCredentials:encrypt(updated)});return updated;
}

export async function chatGPTCredentials(userId:string){
  const connection=await getChatGPTConnection(userId);if(!connection?.encryptedCredentials)throw new Error('Connect ChatGPT in Settings first');
  let credentials=decrypt<ChatGPTCredentials>(connection.encryptedCredentials);
  const expiresAt=new Date(credentials.saved_at).getTime()+credentials.expires_in*1000;
  if(expiresAt-Date.now()<5*60_000){let pending=refreshes.get(userId);if(!pending){pending=refresh(userId,credentials).finally(()=>refreshes.delete(userId));refreshes.set(userId,pending);}credentials=await pending;}
  return credentials;
}

export async function chatGPTModels(userId:string){
  const credentials=await chatGPTCredentials(userId);
  const response=await fetch(`${resource}/models`,{headers:{Authorization:`Bearer ${credentials.access_token}`}});
  if(!response.ok)throw new Error(`Could not load ChatGPT models (${response.status})`);
  const result=await response.json() as {models?:Array<{slug?:string;display_name?:string;visibility?:string}>};
  return(result.models||[]).filter(model=>model.visibility==='list'&&model.slug).map(model=>({slug:model.slug!,name:model.display_name||model.slug!}));
}

export async function disconnectChatGPT(userId:string){
  const connection=await getChatGPTConnection(userId);if(!connection)return;
  if(connection.encryptedCredentials){const credentials=decrypt<ChatGPTCredentials>(connection.encryptedCredentials);try{const metadata=await configuration();await fetch(metadata.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:credentials.refresh_token,token_type_hint:'refresh_token',client_id:credentials.client_id})});}catch{/* Local removal still wins; the owner can also disconnect in ChatGPT settings. */}}
  await saveChatGPTConnection({userId,hostId:connection.hostId});
}
