import { useState } from 'react';
import { Mail } from 'lucide-react';
import { api, describeError } from '../api';
import type { SetupStatus } from '../types';
import { Chip, ConfirmButton, ErrorLine } from './ui';

interface Props { status: SetupStatus['email']; onChanged: () => void; onNotice: (message: string) => void }

const PRESETS = [
  { label: 'Gmail', host: 'smtp.gmail.com', port: '465', secure: true, help: 'Use an app password: Google Account → Security → 2-Step Verification → App passwords.' },
  { label: 'Outlook', host: 'smtp.office365.com', port: '587', secure: false, help: 'Use your Microsoft account password or an app password.' },
  { label: 'Other', host: '', port: '587', secure: false, help: 'Use the details your email provider or hosting gives you.' }
];

export function SetupEmail({ status, onChanged, onNotice }: Props) {
  const [editing, setEditing] = useState(false);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [host, setHost] = useState(PRESETS[0].host);
  const [port, setPort] = useState(PRESETS[0].port);
  const [secure, setSecure] = useState(PRESETS[0].secure);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const pick = (next: (typeof PRESETS)[number]) => { setPreset(next); setHost(next.host); setPort(next.port); setSecure(next.secure); };
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(undefined); try { await work(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); } };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.put('/api/setup/email', { host, port: Number(port), secure, user: user || undefined, password: password || undefined, from: from || user, to: to || undefined });
      setPassword('');
      setEditing(false);
      onNotice('Email is set up.');
      onChanged();
    });
  };
  const test = () => run(async () => { const result = await api.post<{ results: Array<{ channel: string; ok: boolean; detail: string }> }>('/api/agent/channels/test'); const email = result.results.find((item) => item.channel === 'email'); onNotice(email?.ok ? 'Test email sent.' : email?.detail ?? 'Turn on Email digest below to send a test.'); });

  return (
    <div className="setup-body">
      <div className="setup-head"><div><h4><Mail size={15} aria-hidden /> Email digests</h4><p>Get your morning brief and reminders by email, from your own mail server to your own address.</p></div>{status.configured ? <Chip tone="good">{status.source === 'env' ? 'Set by deployment' : 'Ready'}</Chip> : <Chip>Not set up</Chip>}</div>
      {status.configured && !editing && (
        <>
          <p className="hint">Sending through <b>{status.host}</b>{status.user ? <> as {status.user}</> : null}{status.from ? <> · from {status.from}</> : null}.</p>
          <div className="row-gap"><button className="btn plain" onClick={test} disabled={busy}>Send a test</button><button className="btn plain" onClick={() => setEditing(true)}>Change</button>{status.source === 'ui' && <ConfirmButton label="Remove" onConfirm={() => run(async () => { await api.del('/api/setup/email'); onNotice('Email removed.'); onChanged(); })} />}</div>
        </>
      )}
      {(!status.configured || editing) && (
        <form className="setup-form" onSubmit={save}>
          <div className="seg-row" role="radiogroup" aria-label="Email provider">{PRESETS.map((item) => <button type="button" role="radio" aria-checked={preset.label === item.label} key={item.label} className={preset.label === item.label ? 'active' : ''} onClick={() => pick(item)}>{item.label}</button>)}</div>
          <p className="hint">{preset.help}</p>
          <label className="field"><span>Mail server</span><input value={host} onChange={(event) => setHost(event.target.value)} required placeholder="smtp.example.com" /></label>
          <div className="field-row">
            <label className="field"><span>Port</span><input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} required /></label>
            <label className="field"><span>Encryption</span><select value={secure ? 'ssl' : 'starttls'} onChange={(event) => setSecure(event.target.value === 'ssl')}><option value="ssl">SSL (port 465)</option><option value="starttls">STARTTLS (port 587)</option></select></label>
          </div>
          <label className="field"><span>Username</span><input autoComplete="off" value={user} onChange={(event) => setUser(event.target.value)} placeholder="you@example.com" /></label>
          <label className="field"><span>Password</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <label className="field"><span>Send from</span><input type="email" value={from} onChange={(event) => setFrom(event.target.value)} placeholder={user || 'orbit@example.com'} required={!user} /></label>
          <label className="field"><span>Send to (optional — defaults to your own address)</span><input type="email" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <div className="row-gap"><button className="btn primary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Check & save'}</button>{editing && <button className="btn plain" type="button" onClick={() => setEditing(false)}>Cancel</button>}</div>
          <p className="hint">Orbit signs in to confirm it works before saving, and stores the password encrypted.</p>
        </form>
      )}
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}
