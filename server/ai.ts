import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AiProvider, Brief, Signal, Task, UserSettings } from './types.js';
import { chatGPTCredentials, chatGPTModels } from './chatgpt.js';

type JsonSchema = Record<string, unknown>;
type TriageItem = { sourceId:string; title:string; sender:string; summary:string; category:Signal['category']; priority:Signal['priority']; task:string|null };

function selectedProvider(preferred?: AiProvider): AiProvider {
  if (process.env.AI_ENABLED === 'false') return 'rules';
  if (preferred) return preferred;
  if (process.env.AI_PROVIDER) return process.env.AI_PROVIDER as AiProvider;
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'rules';
}

export function aiProviders(chatgptConfigured=false) {
  return [
    { id:'rules' as const, label:'Private rules', configured:true, external:false },
    { id:'chatgpt-subscription' as const, label:'ChatGPT plan (preview)', configured:chatgptConfigured, external:true },
    { id:'openai' as const, label:'OpenAI API', configured:!!process.env.OPENAI_API_KEY, external:true },
    { id:'anthropic' as const, label:'Anthropic API', configured:!!process.env.ANTHROPIC_API_KEY, external:true },
    { id:'openai-compatible' as const, label:'Local / compatible', configured:!!process.env.AI_BASE_URL&&!!process.env.AI_COMPATIBLE_MODEL, external:!!process.env.AI_BASE_URL&&!/^https?:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)(:|\/)/.test(process.env.AI_BASE_URL) }
  ];
}

async function generateChatGPTJson(prompt:string,schema:JsonSchema,userId:string,model?:string){
  const credentials=await chatGPTCredentials(userId);
  const selected=model||(await chatGPTModels(userId))[0]?.slug;
  if(!selected)throw new Error('No ChatGPT model is available for this account');
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${credentials.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({model:selected,instructions:'Return only valid JSON matching the supplied schema. Do not use markdown fences or invent facts.',input:[{role:'user',content:`${prompt}\n\nJSON schema:\n${JSON.stringify(schema)}`}],store:false,stream:true})});
  if(!response.ok){const raw=await response.text();let diagnostic:unknown='non-JSON error';try{const parsed=JSON.parse(raw) as {error?:{type?:unknown;code?:unknown;param?:unknown}};diagnostic={type:parsed.error?.type,code:parsed.error?.code,param:parsed.error?.param};}catch{ /* Never log response text because it may contain owner data. */ }console.error('ChatGPT inference rejected',{status:response.status,requestId:response.headers.get('x-request-id')||undefined,diagnostic});throw new Error(`ChatGPT inference failed (${response.status})`);}
  if(!response.body)throw new Error('ChatGPT returned no response stream');
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let output='';let completed=false;
  const consume=(block:string)=>{for(const line of block.split('\n')){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;const event=JSON.parse(data) as {type?:string;delta?:string;response?:{error?:{message?:string}}};if(event.type==='response.output_text.delta'&&typeof event.delta==='string')output+=event.delta;if(event.type==='response.failed')throw new Error(event.response?.error?.message||'ChatGPT response failed');if(event.type==='response.completed')completed=true;}};
  while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done}).replace(/\r\n/g,'\n');const blocks=buffer.split('\n\n');buffer=blocks.pop()||'';for(const block of blocks)consume(block);if(done)break;}
  if(buffer.trim())consume(buffer);
  if(!completed)throw new Error('ChatGPT stream ended before completion');
  return parseJson(output);
}

function parseJson(text: string) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

async function generateJson(prompt: string, schemaName: string, schema: JsonSchema, provider: AiProvider, userId?:string, model?:string) {
  if(provider==='chatgpt-subscription'){
    if(!userId)throw new Error('ChatGPT plan usage needs an authenticated Orbit owner');
    return generateChatGPTJson(prompt,schema,userId,model);
  }
  if (provider === 'openai') {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.responses.create({ model:process.env.OPENAI_MODEL||'gpt-4.1-mini', input:prompt, text:{format:{type:'json_schema',name:schemaName,strict:true,schema}} });
    return parseJson(response.output_text);
  }
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey:process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({ model:process.env.ANTHROPIC_MODEL||'claude-sonnet-4-5', max_tokens:1800, system:'Return only valid JSON matching the supplied schema. Do not use markdown fences.', messages:[{role:'user',content:`${prompt}\n\nJSON schema:\n${JSON.stringify(schema)}`}] });
    const block = response.content.find(item=>item.type==='text');
    if (!block || block.type!=='text') throw new Error('Anthropic returned no text');
    return parseJson(block.text);
  }
  if (provider === 'openai-compatible') {
    if (!process.env.AI_BASE_URL || !process.env.AI_COMPATIBLE_MODEL) throw new Error('AI_BASE_URL and AI_COMPATIBLE_MODEL are required');
    const client = new OpenAI({apiKey:process.env.AI_COMPATIBLE_API_KEY||'local',baseURL:process.env.AI_BASE_URL});
    const response = await client.chat.completions.create({model:process.env.AI_COMPATIBLE_MODEL,messages:[{role:'system',content:'Return only valid JSON. Do not use markdown fences.'},{role:'user',content:`${prompt}\n\nJSON schema:\n${JSON.stringify(schema)}`}],response_format:{type:'json_object'}});
    return parseJson(response.choices[0]?.message.content||'{}');
  }
  throw new Error(`AI provider ${provider} is not configured`);
}

function rulesTriage(messages:Array<{id:string;from:string;subject:string;date:string;text:string}>):TriageItem[]{
  return messages.map(m=>{const combined=`${m.subject} ${m.text}`;const noise=/no.?reply|newsletter|digest|unsubscribe/i.test(`${m.from} ${combined}`);const category:Signal['category']=noise?'noise':/invoice|receipt|payment|bill|renewal/i.test(combined)?'money':/flight|hotel|trip|reservation|boarding/i.test(combined)?'travel':/meeting|calendar|rescheduled/i.test(combined)?'calendar':'action';return{sourceId:m.id,title:m.subject,sender:m.from,summary:m.text.slice(0,170)||'Open this message for details.',category,priority:/urgent|today|asap|action required|deadline/i.test(combined)?'now':category==='noise'?'later':'soon',task:noise?null:m.subject};});
}

const triageSchema:JsonSchema={type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',items:{type:'object',additionalProperties:false,required:['sourceId','title','sender','summary','category','priority','task'],properties:{sourceId:{type:'string'},title:{type:'string'},sender:{type:'string'},summary:{type:'string'},category:{type:'string',enum:['action','waiting','calendar','money','travel','people','noise']},priority:{type:'string',enum:['now','soon','later']},task:{anyOf:[{type:'string'},{type:'null'}]}}}}}};
const briefSchema:JsonSchema={type:'object',additionalProperties:false,required:['headline','narrative','wins','watchouts'],properties:{headline:{type:'string'},narrative:{type:'string'},wins:{type:'array',items:{type:'string'},maxItems:3},watchouts:{type:'array',items:{type:'string'},maxItems:3}}};

export async function understandMessages(messages:Array<{id:string;from:string;subject:string;date:string;text:string}>, settings?:UserSettings, userId?:string):Promise<TriageItem[]>{
  if(!messages.length)return[];
  const provider=selectedProvider(settings?.aiProvider);
  if(provider==='rules')return rulesTriage(messages);
  if(messages.length>20){const items:TriageItem[]=[];for(let index=0;index<messages.length;index+=20)items.push(...await understandMessages(messages.slice(index,index+20),settings,userId));return items;}
  const chars=Math.min(8000,Math.max(200,settings?.aiInputChars||Number(process.env.AI_INPUT_CHARS_PER_ITEM||1800)));
  const result=await generateJson(`You are the intelligence layer for a private personal operations dashboard. Classify these recent emails. Be selective: newsletters and FYI messages must not become tasks. Summaries must be factual and under 22 words. Never invent a deadline.\n\n${JSON.stringify(messages.map(m=>({...m,text:m.text.slice(0,chars)})))}`,'email_triage',triageSchema,provider,userId,settings?.chatgptModel);
  return result.items as TriageItem[];
}

export async function buildBrief(signals:Signal[], settings?:UserSettings, userId?:string):Promise<Brief>{
  const active=signals.filter(s=>s.category!=='noise').slice(0,30);
  const provider=selectedProvider(settings?.aiProvider);
  if(provider==='rules')return{headline:active.length?`${active.filter(s=>s.priority==='now').length||'A few'} things need your attention.`:'You are all caught up.',narrative:active.slice(0,3).map(s=>s.summary).join(' ')||'No meaningful changes since your last check-in.',wins:[],watchouts:active.filter(s=>s.priority==='now').slice(0,2).map(s=>s.title),generatedAt:new Date().toISOString()};
  const result=await generateJson(`Write a calm executive brief from these normalized signals. Lead with decisions and deadlines, not inbox counts. Never invent facts.\n${JSON.stringify(active)}`,'daily_brief',briefSchema,provider,userId,settings?.chatgptModel);
  return{...result,generatedAt:new Date().toISOString()} as Brief;
}

export async function answerQuestion(question:string, signals:Signal[], tasks:Task[], settings:UserSettings, userId?:string){
  const provider=selectedProvider(settings.aiProvider);
  const normalized=question.trim().toLowerCase();
  if(provider==='rules'){
    const terms=normalized.split(/\W+/).filter(term=>term.length>2);
    const matches=signals.filter(signal=>terms.some(term=>`${signal.title} ${signal.summary} ${signal.sender}`.toLowerCase().includes(term))).slice(0,5);
    if(matches.length)return `I found ${matches.length} relevant signal${matches.length===1?'':'s'}: ${matches.map(item=>item.title).join('; ')}.`;
    const open=tasks.filter(task=>task.status==='open').slice(0,5);
    return open.length?`I could not find a direct signal match. Your current focus queue starts with: ${open.map(task=>task.title).join('; ')}.`:'I could not find that in your stored signals or open tasks.';
  }
  const schema:JsonSchema={type:'object',additionalProperties:false,required:['answer'],properties:{answer:{type:'string'}}};
  const result=await generateJson(`Answer the owner's question using only the normalized signals and tasks below. Say when the data does not contain the answer. Be concise and never invent facts.\nQuestion: ${question.slice(0,600)}\nSignals: ${JSON.stringify(signals.slice(0,50))}\nTasks: ${JSON.stringify(tasks.slice(0,30))}`,'orbit_answer',schema,provider,userId,settings.chatgptModel);
  return String(result.answer||'No answer was returned.');
}

export function aiStatus(){const provider=selectedProvider();const selected=aiProviders().find(item=>item.id===provider);return{provider,external:selected?.external||false,configured:selected?.configured||false};}
