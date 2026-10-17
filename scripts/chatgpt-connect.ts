import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import open from 'open';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = ['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct'];

function argument(name:string){const index=process.argv.indexOf(`--${name}`);return index>=0?process.argv[index+1]:undefined;}
function base64url(value:Buffer){return value.toString('base64url');}

if(process.argv.includes('--help')){
  console.log('Usage: npm run chatgpt:connect -- --host-id urn:uuid:... [--output orbit-chatgpt-credentials.json]');
  process.exit(0);
}

const hostId=argument('host-id');
if(!hostId?.startsWith('urn:uuid:'))throw new Error('Pass the exact host ID shown in Orbit Settings with --host-id');
const output=path.resolve(argument('output')||'orbit-chatgpt-credentials.json');
const state=base64url(crypto.randomBytes(24));
const nonce=base64url(crypto.randomBytes(24));
const verifier=base64url(crypto.randomBytes(48));
const challenge=base64url(crypto.createHash('sha256').update(verifier).digest());

const server=http.createServer();
server.listen(0,'127.0.0.1',async()=>{
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Could not start the local OAuth callback');
  const redirectUri=`http://127.0.0.1:${address.port}/auth/callback`;
  const authorize=new URL(`${issuer}/api/accounts/authorize`);
  authorize.search=new URLSearchParams({response_type:'code',client_id:'dynamic_agent_client',redirect_uri:redirectUri,scope:scopes.join(' '),resource,state,nonce,code_challenge:challenge,code_challenge_method:'S256',agent_name_hint:'Orbit',ext_agent_host_id:hostId}).toString();
  console.log(`Opening OpenAI sign-in in your browser. If it does not open, visit:\n${authorize}\n`);
  await open(authorize.toString());
});

server.on('request',async(req,res)=>{
  try{
    const address=server.address();
    if(!address||typeof address==='string')throw new Error('Local callback is unavailable');
    const requestUrl=new URL(req.url||'/',`http://127.0.0.1:${address.port}`);
    if(requestUrl.pathname!=='/auth/callback'){res.writeHead(404).end('Not found');return;}
    if(requestUrl.searchParams.get('state')!==state)throw new Error('OAuth state did not match');
    const oauthError=requestUrl.searchParams.get('error');
    if(oauthError)throw new Error(`OpenAI sign-in was not completed: ${oauthError}`);
    const code=requestUrl.searchParams.get('code');
    const clientId=requestUrl.searchParams.get('client_id');
    if(!code||!clientId||clientId==='dynamic_agent_client')throw new Error('OpenAI did not return an issued client ID');
    const redirectUri=`http://127.0.0.1:${address.port}/auth/callback`;
    const tokenResponse=await fetch(`${issuer}/api/accounts/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirectUri,client_id:clientId,code_verifier:verifier,resource})});
    if(!tokenResponse.ok)throw new Error(`Token exchange failed (${tokenResponse.status})`);
    const token=await tokenResponse.json() as Record<string,unknown>;
    const idToken=String(token.id_token||'');
    const metadataResponse=await fetch(`${issuer}/.well-known/openid-configuration`);
    if(!metadataResponse.ok)throw new Error('Could not load OpenAI authorization configuration');
    const metadata=await metadataResponse.json() as {jwks_uri:string};
    const {payload}=await jwtVerify(idToken,createRemoteJWKSet(new URL(metadata.jwks_uri)),{issuer,audience:clientId});
    if(payload.nonce!==nonce)throw new Error('OpenAI identity token does not match this sign-in');
    if(typeof payload.sub!=='string')throw new Error('OpenAI identity token has no subject');
    const granted=String(token.scope||'').split(' ').filter(Boolean);
    if(!granted.includes('chatgpt.tokens.use.direct'))throw new Error('ChatGPT plan usage was not authorized');
    const bundle={email:typeof payload.email==='string'?payload.email:'ChatGPT user',issuer,subject:payload.sub,client_id:clientId,ext_agent_host_id:hostId,id_token:idToken,access_token:String(token.access_token||''),refresh_token:String(token.refresh_token||''),token_type:String(token.token_type||'Bearer'),expires_in:Number(token.expires_in||3600),scopes:granted,saved_at:new Date().toISOString()};
    if(!bundle.access_token||!bundle.refresh_token)throw new Error('OpenAI returned incomplete credentials');
    await fs.writeFile(output,`${JSON.stringify(bundle,null,2)}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><title>Orbit connected</title><style>body{font:16px system-ui;background:#11160f;color:#e7eee0;display:grid;place-items:center;height:100vh;margin:0}main{max-width:520px;padding:32px}h1{color:#c8f06b}</style><main><h1>ChatGPT authorization complete</h1><p>Return to your terminal, then import the generated credential file in Orbit Settings.</p></main>');
    console.log(`Credential file created at ${output}\nImport it in Orbit Settings. Do not commit or share this file.`);
  }catch(error){
    res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'}).end(error instanceof Error?error.message:'Authorization failed');
    console.error(error instanceof Error?error.message:error);
    process.exitCode=1;
  }finally{server.close();}
});
