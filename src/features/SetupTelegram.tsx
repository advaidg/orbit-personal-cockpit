import { useState } from 'react';
import { ExternalLink, Send } from 'lucide-react';
import { api, describeError } from '../api';
import { usePoll } from '../hooks';
import type { SetupStatus } from '../types';
import { Chip, ConfirmButton, ErrorLine } from './ui';

interface Props {
  status: SetupStatus['telegram'];
  onChanged: () => void;
  onNotice: (message: string) => void;
}

interface LinkInfo { code: string; url?: string; bot?: string; expiresAt: string }

export function SetupTelegram({ status, onChanged, onNotice }: Props) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const waiting = status.configured && !status.linked && !!link;
  // While the owner is in Telegram pressing Start, notice the moment it works.
  usePoll(onChanged, 2_000, waiting);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await work(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); }
  };
  const connect = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api.put<{ bot: string }>('/api/setup/telegram', { token });
      setToken('');
      onNotice(`Connected to @${result.bot}.`);
      onChanged();
    });
  };
  const makeLink = () => run(async () => { setLink(await api.post<LinkInfo>('/api/channels/telegram/link')); });
  const test = () => run(async () => { const result = await api.post<{ results: Array<{ channel: string; ok: boolean; detail: string }> }>('/api/agent/channels/test'); const tg = result.results.find((item) => item.channel === 'telegram'); onNotice(tg?.ok ? 'Check Telegram — a test message is on its way.' : tg?.detail ?? 'Telegram is not delivering yet.'); });
  const disconnect = () => run(async () => { await api.del('/api/setup/telegram'); setLink(null); onNotice('Telegram disconnected.'); onChanged(); });

  return (
    <div className="setup-body">
      <div className="setup-head"><div><h4><Send size={15} aria-hidden /> Telegram</h4><p>Chat with Orbit and approve its proposals from your phone. Orbit never sends anything on its own.</p></div>{status.linked ? <Chip tone="good">Connected</Chip> : status.configured ? <Chip tone="warn">Bot ready · link your chat</Chip> : <Chip>Not set up</Chip>}</div>

      {!status.configured && (
        <>
          <ol className="setup-steps">
            <li><b>Open @BotFather</b> in Telegram <a className="btn plain" href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">Open <ExternalLink size={13} aria-hidden /></a></li>
            <li>Send <code>/newbot</code>, pick a name, and choose a username that ends in <code>bot</code>.</li>
            <li>BotFather replies with a <b>token</b> — copy it and paste it here.</li>
          </ol>
          <form className="inline-edit" onSubmit={connect}>
            <input type="password" autoComplete="off" spellCheck={false} aria-label="Bot token" value={token} onChange={(event) => setToken(event.target.value)} placeholder="123456789:AA…" required />
            <button className="btn primary" type="submit" disabled={busy || !token.trim()}>Connect bot</button>
          </form>
          <p className="hint">The token is checked with Telegram, stored encrypted, and never shown again.</p>
        </>
      )}

      {status.configured && !status.linked && (
        <>
          <p className="hint">Bot ready{status.bot ? <> — <b>@{status.bot}</b></> : null}. Now tell it who you are, so nobody else can use it.</p>
          {!link && <button className="btn primary" disabled={busy} onClick={makeLink}>Link my Telegram chat</button>}
          {link && (
            <div className="notice info" role="status">
              <div>
                <strong>{link.url ? 'Tap the button, then press Start in Telegram.' : `Send this to @${status.bot ?? 'your bot'}: /link ${link.code}`}</strong>
                <span>Waiting for you… this page updates by itself. The code works once and expires in ten minutes.</span>
              </div>
              {link.url && <a className="btn primary" href={link.url} target="_blank" rel="noopener noreferrer">Open Telegram <ExternalLink size={13} aria-hidden /></a>}
            </div>
          )}
        </>
      )}

      {status.linked && <div className="row-gap"><button className="btn plain" disabled={busy} onClick={test}>Send a test</button><ConfirmButton label="Disconnect Telegram" confirmLabel="Disconnect" onConfirm={disconnect} /></div>}
      {status.configured && status.source === 'env' && !status.linked && <p className="hint">This bot token comes from your deployment’s settings. Paste a different one above to override it.</p>}
      {status.configured && !status.inbound && <p className="hint">Chatting is turned off by the installation (TELEGRAM_INBOUND_ENABLED=false); Orbit can still message you.</p>}
      {status.configured && !status.linked && <ConfirmButton tone="plain" label="Use a different bot" confirmLabel="Remove this bot" onConfirm={disconnect} />}
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}
