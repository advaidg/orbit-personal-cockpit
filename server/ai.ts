import OpenAI from 'openai';
import type { Brief, Signal } from './types.js';

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

export async function understandMessages(messages: Array<{ id: string; from: string; subject: string; date: string; text: string }>) {
  if (!messages.length) return [];
  if (!client) return messages.map((m) => ({
    sourceId: m.id, title: m.subject, sender: m.from, summary: m.text.slice(0, 170) || 'Open this message for details.',
    category: /no.?reply|newsletter|digest/i.test(m.from) ? 'noise' : /invoice|receipt|payment|bill/i.test(m.subject) ? 'money' : /flight|hotel|trip|reservation/i.test(m.subject) ? 'travel' : 'action',
    priority: /urgent|today|asap|action required/i.test(`${m.subject} ${m.text}`) ? 'now' : 'soon',
    task: /no.?reply|newsletter|digest/i.test(m.from) ? null : m.subject
  }));

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: `You are the intelligence layer for a personal operations dashboard. Classify these recent emails. Be selective: newsletters and FYI messages should not become tasks. Summaries must be factual and under 22 words.\n\n${JSON.stringify(messages.map(m => ({ ...m, text: m.text.slice(0, 1800) })))}`,
    text: { format: { type: 'json_schema', name: 'email_triage', strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['sourceId','title','sender','summary','category','priority','task'], properties: {
          sourceId: { type: 'string' }, title: { type: 'string' }, sender: { type: 'string' }, summary: { type: 'string' },
          category: { type: 'string', enum: ['action','waiting','calendar','money','travel','people','noise'] },
          priority: { type: 'string', enum: ['now','soon','later'] }, task: { anyOf: [{ type: 'string' }, { type: 'null' }] }
        }
      } } }
    } } }
  });
  return JSON.parse(response.output_text).items;
}

export async function buildBrief(signals: Signal[]): Promise<Brief> {
  const active = signals.filter(s => s.category !== 'noise').slice(0, 30);
  if (!client) return {
    headline: active.length ? `${active.filter(s => s.priority === 'now').length || 'A few'} things need your attention.` : 'You are all caught up.',
    narrative: active.slice(0, 3).map(s => s.summary).join(' ') || 'No meaningful changes since your last check-in.',
    wins: ['Your information is in one place'], watchouts: active.filter(s => s.priority === 'now').slice(0, 2).map(s => s.title), generatedAt: new Date().toISOString()
  };
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: `Write a calm executive brief from these signals. Lead with decisions and deadlines, not inbox counts. Never invent facts.\n${JSON.stringify(active)}`,
    text: { format: { type: 'json_schema', name: 'daily_brief', strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['headline','narrative','wins','watchouts'], properties: {
        headline: { type: 'string' }, narrative: { type: 'string' }, wins: { type: 'array', items: { type: 'string' }, maxItems: 3 }, watchouts: { type: 'array', items: { type: 'string' }, maxItems: 3 }
      }
    } } }
  });
  return { ...JSON.parse(response.output_text), generatedAt: new Date().toISOString() };
}
