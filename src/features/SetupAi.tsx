import { useState } from 'react';
import { Brain } from 'lucide-react';
import { api, describeError } from '../api';
import type { SetupStatus } from '../types';
import { Chip, ConfirmButton, ErrorLine } from './ui';
import { SetupChatGpt } from './SetupChatGpt';

type Tab = 'chatgpt' | 'openai' | 'anthropic' | 'openrouter' | 'other';

interface Preset { label: string; baseUrl: string; keyHelp: string }

const OPENROUTER = 'https://openrouter.ai/api/v1';
const PRESETS: Preset[] = [
  { label: 'Ollama (this computer)', baseUrl: 'http://localhost:11434/v1', keyHelp: 'No key needed. Works only if Orbit runs on the same machine as Ollama.' },
  { label: 'LM Studio (this computer)', baseUrl: 'http://localhost:1234/v1', keyHelp: 'No key needed. Works only if Orbit runs on the same machine.' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyHelp: 'Create a key at console.groq.com/keys.' },
  { label: 'Together', baseUrl: 'https://api.together.xyz/v1', keyHelp: 'Create a key at api.together.ai.' },
  { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyHelp: 'Create a key at console.mistral.ai.' },
  { label: 'Any OpenAI-compatible server', baseUrl: '', keyHelp: 'Enter its address, ending in /v1 (vLLM, LiteLLM, your own gateway…).' }
];

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'chatgpt', label: 'ChatGPT plan' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'other', label: 'Other' }
];

const SETTING_ID: Record<Tab, string> = { chatgpt: 'chatgpt-subscription', openai: 'openai', anthropic: 'anthropic', openrouter: 'openai-compatible', other: 'openai-compatible' };
const isOpenRouter = (url?: string) => !!url && url.includes('openrouter.ai');
const MODEL_HINT: Record<string, string> = { openai: 'gpt-4.1-mini', anthropic: 'claude-sonnet-4-5', openrouter: 'anthropic/claude-sonnet-4.5', other: 'llama3.1' };

interface Props { status: SetupStatus['ai']; onChanged: () => void; onNotice: (message: string) => void }

export function SetupAi({ status, onChanged, onNotice }: Props) {
  const [tab, setTab] = useState<Tab>(status.active === 'chatgpt-subscription' ? 'chatgpt' : 'openai');
  const [preset, setPreset] = useState(PRESETS[2]);
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [checked, setChecked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();

  const compat = status.compatible;
  const orConfigured = compat.configured && isOpenRouter(compat.baseUrl);
  const otherConfigured = compat.configured && !isOpenRouter(compat.baseUrl);
  const configured = (id: Tab) => id === 'chatgpt' ? status.chatgpt.connected : id === 'openrouter' ? orConfigured : id === 'other' ? otherConfigured : status[id].configured;
  const provider = tab === 'openai' || tab === 'anthropic' ? tab : 'compatible';
  const address = tab === 'openrouter' ? OPENROUTER : baseUrl || preset.baseUrl;
  const current = tab === 'openai' || tab === 'anthropic' ? status[tab] : compat;
  const sameServer = provider === 'compatible' && compat.baseUrl === address;
  const active = status.active === SETTING_ID[tab] && (provider !== 'compatible' || sameServer);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(undefined); try { await work(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); } };
  const reset = (next: Tab) => { setTab(next); setError(undefined); setModels([]); setChecked(''); setKey(''); setModel(''); };

  const check = () => run(async () => {
    const result = await api.post<{ verdict: string; models: string[] }>('/api/setup/ai/models', { provider, apiKey: key || undefined, baseUrl: provider === 'compatible' ? address : undefined });
    setModels(result.models);
    setChecked(result.verdict === 'ok' ? `Key works${result.models.length ? ` · ${result.models.length} models available` : ''}.` : 'I could not reach the provider just now, but you can still save and try it.');
  });
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const body = provider === 'compatible' ? { provider, baseUrl: address, model: model || compat.model || '', apiKey: key || undefined } : { provider, apiKey: key || undefined, model: model || undefined };
      const result = await api.put<{ warning?: string }>('/api/setup/ai', body);
      setKey('');
      onNotice(result.warning ?? 'Saved. Press “Use it” to switch Orbit to it.');
      onChanged();
    });
  };
  const use = () => run(async () => { await api.patch('/api/settings', { aiProvider: SETTING_ID[tab] }); onNotice('Orbit now thinks with this provider. Use “Clear & re-sync” in Settings to apply it to existing messages.'); onChanged(); });
  const useRules = () => run(async () => { await api.patch('/api/settings', { aiProvider: 'rules' }); onNotice('Back to private rules. Nothing leaves your server.'); onChanged(); });
  const remove = () => run(async () => { await api.del(`/api/setup/ai/${provider}`); onNotice('Removed.'); onChanged(); });

  const needsKey = provider !== 'compatible' ? !current.configured : tab === 'openrouter' && !(sameServer && compat.configured);
  const note = tab === 'openai' ? 'Create a key at platform.openai.com/api-keys.' : tab === 'anthropic' ? 'Create a key at console.anthropic.com/settings/keys. Anthropic connects with an API key.' : tab === 'openrouter' ? 'One key, hundreds of models (Claude, GPT, Llama, Gemini…). Create it at openrouter.ai/keys.' : preset.keyHelp;
  const external = status.active !== 'rules';
  const placeholder = sameServer && compat.model ? compat.model : provider !== 'compatible' ? status[provider].model ?? MODEL_HINT[tab] : MODEL_HINT[tab];

  return (
    <div className="setup-body">
      <div className="setup-head"><div><h4><Brain size={15} aria-hidden /> Intelligence</h4><p>Orbit works fully private with no AI. Add a provider only if you want smarter summaries and drafts. Text is sent to it only while you have it switched on.</p></div><Chip tone={external ? 'info' : 'good'}>{external ? `Using ${status.active}` : 'Private rules'}</Chip></div>
      <div className="seg-row wrap" role="tablist" aria-label="Provider">{TABS.map((item) => <button type="button" role="tab" aria-selected={tab === item.id} key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => reset(item.id)}>{item.label}{configured(item.id) ? ' ✓' : ''}</button>)}</div>

      {tab === 'chatgpt' ? <SetupChatGpt status={status} onChanged={onChanged} onNotice={onNotice} /> : (
        <form className="setup-form" onSubmit={save}>
          <p className="hint">{note}</p>
          {tab === 'other' && (
            <>
              <label className="field"><span>Provider</span><select value={preset.label} onChange={(event) => { const next = PRESETS.find((item) => item.label === event.target.value) ?? PRESETS[0]; setPreset(next); setBaseUrl(next.baseUrl); setModels([]); }}>{PRESETS.map((item) => <option key={item.label}>{item.label}</option>)}</select></label>
              <label className="field"><span>Server address</span><input value={baseUrl || preset.baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required placeholder="https://…/v1" /></label>
            </>
          )}
          <label className="field"><span>{provider === 'compatible' && tab === 'other' ? 'API key (if it needs one)' : !needsKey ? 'API key (leave empty to keep the saved one)' : 'API key'}</span><input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} required={needsKey} /></label>
          <div className="row-gap"><button className="btn plain" type="button" disabled={busy || (needsKey && !key)} onClick={check}>Check {needsKey ? 'key' : 'connection'} &amp; load models</button>{checked && <span className="hint good" role="status">{checked}</span>}</div>
          <label className="field"><span>Model{provider === 'compatible' ? '' : ' (optional)'}</span><input list={`models-${tab}`} value={model} onChange={(event) => setModel(event.target.value)} required={provider === 'compatible' && !compat.model} placeholder={placeholder} autoComplete="off" /><datalist id={`models-${tab}`}>{models.map((item) => <option key={item} value={item} />)}</datalist></label>
          <div className="row-gap">
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Working…' : configured(tab) ? 'Update' : 'Check & save'}</button>
            {configured(tab) && !active && <button className="btn plain" type="button" disabled={busy} onClick={use}>Use it</button>}
            {external && <button className="btn plain" type="button" disabled={busy} onClick={useRules}>Switch to private rules</button>}
            {configured(tab) && (current as { source: string }).source === 'ui' && <ConfirmButton label="Remove" onConfirm={remove} />}
          </div>
          {configured(tab) && (current as { source: string }).source === 'env' && <p className="hint">This one comes from your deployment’s settings. Saving here overrides it.</p>}
          {(tab === 'openrouter' || tab === 'other') && configured(tab) && <p className="hint">Saved server: <code>{compat.baseUrl}</code> · model <code>{compat.model}</code></p>}
          <ErrorLine {...(error ?? {})} />
        </form>
      )}
    </div>
  );
}
