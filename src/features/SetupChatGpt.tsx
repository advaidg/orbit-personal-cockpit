import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { api, describeError } from '../api';
import type { SetupStatus } from '../types';
import { ConfirmButton, ErrorLine, Notice } from './ui';

interface Props { status: SetupStatus['ai']; onChanged: () => void; onNotice: (message: string) => void }
interface Model { slug: string; name: string }

/** Connects an eligible ChatGPT plan through OpenAI's sign-in preview. The sign-in itself must happen on the owner's own computer. */
export function SetupChatGpt({ status, onChanged, onNotice }: Props) {
  const connected = status.chatgpt.connected;
  const active = status.active === 'chatgpt-subscription';
  const [hostId, setHostId] = useState('');
  const [signInUrl, setSignInUrl] = useState('');
  const [pasted, setPasted] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState(status.chatgpt.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const command = hostId ? `npm run chatgpt:connect -- --host-id ${hostId}` : '';
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(undefined); try { await work(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); } };

  useEffect(() => {
    if (!connected) return;
    api.get<{ models: Model[] }>('/api/chatgpt/models').then((result) => { setModels(result.models); setModel((current) => current || result.models[0]?.slug || ''); }).catch((failure) => setError(describeError(failure)));
  }, [connected]);

  const start = () => run(async () => {
    const result = await api.post<{ url: string }>('/api/setup/chatgpt/start');
    setSignInUrl(result.url);
    setPasted('');
    window.open(result.url, '_blank', 'noopener,noreferrer');
  });
  const finish = (value = pasted) => run(async () => {
    const result = await api.post<{ email?: string }>('/api/setup/chatgpt/finish', { url: value.trim() });
    setSignInUrl('');
    setPasted('');
    onNotice(`Connected ${result.email ?? 'ChatGPT'}. Pick a model below.`);
    onChanged();
  });
  const prepare = () => run(async () => { setHostId((await api.get<{ hostId: string }>('/api/chatgpt/setup')).hostId); });
  const copy = async () => { try { await navigator.clipboard.writeText(command); onNotice('Command copied.'); } catch { onNotice('Copy failed — select the command and copy it yourself.'); } };
  const importFile = (file?: File) => {
    if (!file) return;
    void run(async () => {
      const result = await api.post<{ email?: string }>('/api/chatgpt/import', JSON.parse(await file.text()));
      onNotice(`Connected ${result.email ?? 'ChatGPT'}. You can delete the downloaded file now.`);
      onChanged();
    });
  };
  const use = () => run(async () => { await api.patch('/api/settings', { aiProvider: 'chatgpt-subscription', chatgptModel: model }); onNotice('Orbit now thinks with your ChatGPT plan.'); onChanged(); });
  const disconnect = () => run(async () => { await api.del('/api/chatgpt'); setHostId(''); setModels([]); onNotice('ChatGPT disconnected and its tokens revoked.'); onChanged(); });

  if (connected) {
    return (
      <div className="setup-form">
        <p className="hint">Connected as <b>{status.chatgpt.email ?? 'your ChatGPT account'}</b>. Orbit sends only the text needed for the feature you use, and cannot see your ChatGPT chats or memory.</p>
        <label className="field"><span>Model</span><select value={model} onChange={(event) => setModel(event.target.value)}>{models.length ? models.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>) : <option value={model}>{model || 'Loading…'}</option>}</select></label>
        <div className="row-gap">
          <button className="btn primary" disabled={busy || !model} onClick={use}>{active ? 'Save model' : 'Use ChatGPT plan'}</button>
          <ConfirmButton label="Disconnect & revoke" confirmLabel="Disconnect" onConfirm={disconnect} />
        </div>
        <ErrorLine {...(error ?? {})} />
      </div>
    );
  }
  return (
    <div className="setup-form">
      <Notice tone="info" title="Uses your ChatGPT plan instead of an API key (OpenAI preview)">OpenAI decides which plans and models are eligible, and may change this. Orbit never sees your password.</Notice>
      <ol className="setup-steps">
        <li><b>Sign in with ChatGPT</b> — opens OpenAI in a new tab. Approve access.</li>
        <li>Your browser then shows <i>“This site can’t be reached”</i> at an address starting with <code>http://127.0.0.1</code>. <b>That is expected.</b> Copy the whole address from the address bar.</li>
        <li>Paste it below. Orbit finishes the sign-in on the server.</li>
      </ol>
      <div className="row-gap">
        <button className="btn primary" type="button" disabled={busy} onClick={start}>{signInUrl ? 'Start again' : 'Sign in with ChatGPT'}</button>
        {signInUrl && <a className="btn plain" href={signInUrl} target="_blank" rel="noopener noreferrer">Open OpenAI sign-in again</a>}
      </div>
      {signInUrl && (
        <form className="inline-edit" onSubmit={(event) => { event.preventDefault(); finish(); }}>
          <input aria-label="Address from your browser" autoComplete="off" spellCheck={false} value={pasted} onChange={(event) => setPasted(event.target.value)} onPaste={(event) => { const text = event.clipboardData.getData('text'); if (text.startsWith('http://127.0.0.1')) { setPasted(text); window.setTimeout(() => finish(text), 0); } }} placeholder="http://127.0.0.1:…/auth/callback?code=…" />
          <button className="btn primary" type="submit" disabled={busy || !pasted.trim()}>{busy ? 'Finishing…' : 'Finish'}</button>
        </form>
      )}
      <details className="setup-advanced">
        <summary>Can’t paste an address? Use the command-line helper instead</summary>
        <ol className="setup-steps">
          <li>{hostId ? <>On your computer, in a clone of Orbit (<code>npm install</code> once), run:</> : <>Get the command for this installation.</>}</li>
          {hostId && <li className="command-line"><code>{command}</code><button className="btn plain" type="button" onClick={copy}><Copy size={13} aria-hidden /> Copy</button></li>}
          <li>Approve the sign-in; it saves <code>orbit-chatgpt-credentials.json</code>. Choose that file below.</li>
        </ol>
        <div className="row-gap">
          {!hostId && <button className="btn plain" disabled={busy} onClick={prepare}>Get my command</button>}
          {hostId && <label className="btn plain file-pick">{busy ? 'Checking…' : 'Choose credentials file'}<input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => importFile(event.target.files?.[0])} hidden /></label>}
        </div>
      </details>
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}
