import { useState } from 'react';
import { Brain } from 'lucide-react';
import { api, describeError } from '../api';
import type { SetupStatus } from '../types';
import { Chip, ConfirmButton, ErrorLine } from './ui';

type Provider = 'openai' | 'anthropic' | 'compatible';
const LABELS: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Anthropic', compatible: 'Local / compatible' };
const SETTING_ID: Record<Provider, string> = { openai: 'openai', anthropic: 'anthropic', compatible: 'openai-compatible' };
const KEY_HELP: Record<Provider, string> = { openai: 'Create a key at platform.openai.com/api-keys.', anthropic: 'Create a key at console.anthropic.com/settings/keys.', compatible: 'Any server that speaks the OpenAI API: Ollama, LM Studio, vLLM, OpenRouter…' };

interface Props { status: SetupStatus['ai']; onChanged: () => void; onNotice: (message: string) => void }

export function SetupAi({ status, onChanged, onNotice }: Props) {
  const [provider, setProvider] = useState<Provider>('openai');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434/v1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const current = status[provider];
  const active = status.active === SETTING_ID[provider];
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(undefined); try { await work(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); } };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const body = provider === 'compatible' ? { provider, baseUrl, model, apiKey: key || undefined } : { provider, apiKey: key || undefined, model: model || undefined };
      const result = await api.put<{ warning?: string }>('/api/setup/ai', body);
      setKey('');
      onNotice(result.warning ?? `${LABELS[provider]} is ready.`);
      onChanged();
    });
  };
  const use = () => run(async () => { await api.patch('/api/settings', { aiProvider: SETTING_ID[provider] }); onNotice(`Orbit now thinks with ${LABELS[provider]}. Use “Clear & re-sync” in Settings to apply it to existing messages.`); onChanged(); });
  const useRules = () => run(async () => { await api.patch('/api/settings', { aiProvider: 'rules' }); onNotice('Back to private rules. Nothing leaves your server.'); onChanged(); });

  return (
    <div className="setup-body">
      <div className="setup-head"><div><h4><Brain size={15} aria-hidden /> Intelligence</h4><p>Orbit works fully private with no AI. Add a provider only if you want smarter summaries and drafts. Text is sent to it only when you choose it.</p></div><Chip tone={status.active === 'rules' ? 'good' : 'info'}>{status.active === 'rules' ? 'Private rules' : `Using ${status.active}`}</Chip></div>
      <div className="seg-row" role="radiogroup" aria-label="Provider">{(Object.keys(LABELS) as Provider[]).map((item) => <button type="button" role="radio" aria-checked={provider === item} key={item} className={provider === item ? 'active' : ''} onClick={() => { setProvider(item); setError(undefined); }}>{LABELS[item]}{status[item].configured ? ' ✓' : ''}</button>)}</div>
      <p className="hint">{KEY_HELP[provider]}</p>
      <form className="setup-form" onSubmit={save}>
        {provider === 'compatible' && <label className="field"><span>Server address</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required placeholder="http://localhost:11434/v1" /></label>}
        <label className="field"><span>{provider === 'compatible' ? 'API key (if it needs one)' : current.configured ? 'API key (leave empty to keep the saved one)' : 'API key'}</span><input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} required={provider !== 'compatible' && !current.configured} /></label>
        <label className="field"><span>Model{provider === 'compatible' ? '' : ' (optional)'}</span><input value={model} onChange={(event) => setModel(event.target.value)} required={provider === 'compatible' && !current.model} placeholder={provider === 'openai' ? current.model ?? 'gpt-4.1-mini' : provider === 'anthropic' ? current.model ?? 'claude-sonnet-4-5' : current.model ?? 'llama3.1'} /></label>
        <div className="row-gap">
          <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Checking…' : current.configured ? 'Update' : 'Check & save'}</button>
          {current.configured && !active && <button className="btn plain" type="button" disabled={busy} onClick={use}>Use {LABELS[provider]}</button>}
          {status.active !== 'rules' && <button className="btn plain" type="button" disabled={busy} onClick={useRules}>Switch to private rules</button>}
          {current.configured && current.source === 'ui' && <ConfirmButton label="Remove" onConfirm={() => run(async () => { await api.del(`/api/setup/ai/${provider}`); onNotice(`${LABELS[provider]} removed.`); onChanged(); })} />}
        </div>
      </form>
      {current.configured && current.source === 'env' && <p className="hint">This one comes from your deployment’s settings. Saving here overrides it.</p>}
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}
