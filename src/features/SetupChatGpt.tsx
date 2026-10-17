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
      <Notice tone="info" title="Uses your ChatGPT plan instead of an API key (OpenAI preview)">OpenAI decides which plans and models are eligible, and may change this. Sign-in has to open in <i>your</i> browser, so there is one step on your own computer. Orbit never sees your password.</Notice>
      <ol className="setup-steps">
        <li>{hostId ? <>On your computer, in a clone of Orbit (<code>npm install</code> once), run:</> : <>Get the command for this installation.</>}</li>
        {hostId && <li className="command-line"><code>{command}</code><button className="btn plain" type="button" onClick={copy}><Copy size={13} aria-hidden /> Copy</button></li>}
        <li>Approve the OpenAI sign-in in the browser tab it opens. It saves <code>orbit-chatgpt-credentials.json</code>.</li>
        <li>Choose that file below. Orbit checks it with OpenAI, stores it encrypted, then you can delete the file.</li>
      </ol>
      <div className="row-gap">
        {!hostId && <button className="btn primary" disabled={busy} onClick={prepare}>{busy ? 'Preparing…' : 'Get my command'}</button>}
        {hostId && <label className="btn primary file-pick">{busy ? 'Checking…' : 'Choose credentials file'}<input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => importFile(event.target.files?.[0])} hidden /></label>}
      </div>
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}
