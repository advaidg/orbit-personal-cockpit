import { useState, type ReactNode } from 'react';
import { Bell, CalendarDays, Mail, MailX, Send } from 'lucide-react';
import { api, describeError } from '../api';
import type { AgentState } from '../types';
import { Chip, ErrorLine, Notice, PageHead, Toggle } from './ui';
import { Diagnostics } from './Diagnostics';
import { Skills } from './Skills';

function GmailAccess({ agent, onChanged, onNotice }: { agent: AgentState; onChanged: () => void; onNotice: (message: string) => void }) {
  const choice = agent.settings.gmailAccess;
  const writesOff = !agent.limits.externalWritesEnabled;
  const [error, setError] = useState<{ message: string; action?: string }>();
  const choose = async (value: 'read' | 'drafts') => {
    try { await api.patch('/api/agent/settings', { gmailAccess: value }); onNotice(value === 'drafts' ? 'Draft replies enabled. Orbit may prepare drafts for your approval.' : 'Gmail is read-only.'); onChanged(); } catch (failure) { setError(describeError(failure)); }
  };
  const needsConsent = choice === 'drafts' && !agent.gmail.canDraft;
  const calendar = agent.calendar.connected ? (agent.calendar.canWrite ? ',calendar_write' : ',calendar') : '';
  return (
    <div className="panel pad">
      <div className="panel-head flush"><div><h3><Mail size={16} aria-hidden /> Gmail access</h3><p>Choose what Orbit may do in your mailbox. You can change this at any time.</p></div>{agent.gmail.connected ? <Chip tone="good">{agent.gmail.accountEmail ?? 'Connected'}</Chip> : <a className="btn primary" href="/auth/google?access=read">Connect Gmail</a>}</div>
      <div className="radio-stack" role="radiogroup" aria-label="Gmail access level">
        <label className={`radio-card${choice === 'read' ? ' on' : ''}`}><input type="radio" name="gmail-access" checked={choice === 'read'} onChange={() => choose('read')} /><span><b>Read-only</b><small>Orbit reads recent mail to find actions, promises and deadlines. It cannot change your mailbox.</small></span></label>
        <label className={`radio-card${choice === 'drafts' ? ' on' : ''}${writesOff ? ' locked' : ''}`}><input type="radio" name="gmail-access" disabled={writesOff} checked={choice === 'drafts'} onChange={() => choose('drafts')} /><span><b>Read plus create drafts</b><small>{writesOff ? 'Disabled on this installation (EXTERNAL_WRITES_ENABLED=false).' : 'Orbit can place reply drafts in your Drafts folder after you approve each one. You edit and send them yourself.'}</small></span></label>
        <label className="radio-card locked"><input type="radio" name="gmail-access" disabled checked={false} readOnly /><span><b><MailX size={14} aria-hidden /> Sending disabled</b><small>Orbit has no way to send email. Google’s draft permission technically also allows sending, but this version contains no code that sends, and nothing in Orbit can be configured to.</small></span></label>
      </div>
      {needsConsent && <Notice tone="warn" title="One more step: approve draft access with Google" action={<a className="btn primary" href={`/auth/google?access=drafts${calendar}`}>Authorize with Google</a>}>Google has to grant the draft permission before Orbit can create drafts.</Notice>}
      {choice === 'drafts' && agent.gmail.canDraft && <p className="hint good">Draft permission is granted. Orbit will only create drafts, and only after you approve.</p>}
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}

function CalendarAccess({ agent }: { agent: AgentState }) {
  const { connected, canWrite } = agent.calendar;
  return (
    <div className="panel pad">
      <div className="panel-head flush"><div><h3><CalendarDays size={16} aria-hidden /> Google Calendar</h3><p>Orbit reads your next two weeks to find conflicts and suggest preparation. Adding events is a separate permission, and each event needs your approval. Orbit never deletes events and never invites other people.</p></div>{connected ? <Chip tone="good">{canWrite ? 'Read + create events' : 'Read-only'}</Chip> : <Chip>Not connected</Chip>}</div>
      <div className="row-gap">
        {!connected && <a className="btn primary" href="/auth/google?access=calendar">Connect read-only</a>}
        {!canWrite && agent.limits.externalWritesEnabled && <a className="btn plain" href={`/auth/google?access=${agent.gmail.canDraft ? 'drafts,' : ''}calendar_write`}>{connected ? 'Allow creating events' : 'Connect with event creation'}</a>}
        {!agent.limits.externalWritesEnabled && <span className="hint">Event creation is disabled on this installation.</span>}
      </div>
    </div>
  );
}

function Channels({ agent, onChanged, onNotice }: { agent: AgentState; onChanged: () => void; onNotice: (message: string) => void }) {
  const channels = agent.settings.channels;
  const [chatId, setChatId] = useState(channels.telegram.chatId ?? '');
  const [error, setError] = useState<{ message: string; action?: string }>();
  const [results, setResults] = useState<Array<{ channel: string; ok: boolean; detail: string }>>([]);
  const patch = async (body: object, done?: string) => { setError(undefined); try { await api.patch('/api/agent/settings', body); if (done) onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  const browser = async (value: boolean) => {
    if (value && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    if (value && 'Notification' in window && Notification.permission === 'denied') { setError({ message: 'Your browser is blocking notifications for this site.', action: 'Allow notifications in the browser’s site settings, then try again.' }); return; }
    await patch({ channels: { browser: value } });
  };
  const test = async () => { setError(undefined); try { setResults((await api.post<{ results: typeof results }>('/api/agent/channels/test')).results); } catch (failure) { setError(describeError(failure)); } };
  const Row = ({ icon, title, help, control }: { icon: ReactNode; title: string; help: string; control: ReactNode }) => <div className="channel-row"><span className="channel-icon">{icon}</span><div><strong>{title}</strong><small>{help}</small></div>{control}</div>;
  return (
    <div className="panel pad">
      <div className="panel-head flush"><div><h3><Bell size={16} aria-hidden /> Where Orbit reaches you</h3><p>Reminders, digests and alerts go to the same owner identity, memory and run history, whichever channel you choose.</p></div><button className="btn plain" onClick={test}>Send a test</button></div>
      <Row icon={<Bell size={16} />} title="In-app and browser notifications" help="Notifications appear in the bell. Browser alerts show while Orbit is open." control={<Toggle checked={channels.browser} label="Browser notifications" onChange={browser} />} />
      <Row icon={<Mail size={16} />} title="Email digest" help={agent.channels.emailConfigured ? 'Sent through your SMTP provider to your own address.' : 'Not configured. Set SMTP_URL on this installation first.'} control={<Toggle checked={channels.email} disabled={!agent.channels.emailConfigured} label="Email digest" onChange={(value) => patch({ channels: { email: value } })} />} />
      <Row icon={<Send size={16} />} title="Telegram" help={agent.channels.telegramConfigured ? 'Messages go to your own chat through your bot.' : 'Not configured. Set TELEGRAM_BOT_TOKEN on this installation, then add your chat ID.'} control={<Toggle checked={channels.telegram.enabled} disabled={!agent.channels.telegramConfigured || !channels.telegram.chatId} label="Telegram" onChange={(value) => patch({ channels: { telegram: { enabled: value } } })} />} />
      {agent.channels.telegramConfigured && <form className="inline-edit" onSubmit={(event) => { event.preventDefault(); void patch({ channels: { telegram: { chatId: chatId.trim(), enabled: !!chatId.trim() } } }, 'Telegram chat saved.'); }}><input aria-label="Telegram chat ID" inputMode="numeric" value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="Your numeric chat ID" /><button className="btn plain" type="submit">Save chat ID</button></form>}
      <ErrorLine {...(error ?? {})} />
      {results.length > 0 && <ul className="test-results" role="status">{results.map((result) => <li key={result.channel} className={result.ok ? 'ok' : 'bad'}><b>{result.channel}</b> {result.detail}</li>)}</ul>}
    </div>
  );
}

export function Connections({ agent, onChanged, onNotice, activity, onOpenSettings }: { agent: AgentState | null; onChanged: () => void; onNotice: (message: string) => void; activity: ReactNode; onOpenSettings: () => void }) {
  if (!agent) return <p className="hint">Loading…</p>;
  return (
    <section aria-labelledby="connections-heading">
      <PageHead eyebrow="CONNECTIONS" title="Sources, permissions and health." actions={<button className="btn plain" onClick={onOpenSettings}>Sync &amp; intelligence settings</button>}>
        <span id="connections-heading">Decide exactly what Orbit may read and do, and see at a glance whether everything is working.</span>
      </PageHead>
      <div className="stack">
        <GmailAccess agent={agent} onChanged={onChanged} onNotice={onNotice} />
        <CalendarAccess agent={agent} />
        <Channels agent={agent} onChanged={onChanged} onNotice={onNotice} />
        <Diagnostics onChanged={onChanged} />
        <Skills onNotice={onNotice} onChanged={onChanged} />
        {activity}
      </div>
    </section>
  );
}
