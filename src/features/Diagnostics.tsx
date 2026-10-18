import { useState } from 'react';
import { Activity, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { api, describeError } from '../api';
import { useLoad } from '../hooks';
import type { Check, Diagnostics as DiagnosticsData } from '../types';
import { Chip, ErrorLine, ago } from './ui';

function Row({ label, ok, detail, action, meta }: { label: string; ok: boolean | null; detail: string; action?: string; meta?: string }) {
  const Icon = ok === null ? Activity : ok ? CheckCircle2 : XCircle;
  return <li className={`diag-row ${ok === null ? 'idle' : ok ? 'ok' : 'bad'}`}><Icon size={17} aria-hidden /><div><strong>{label}{meta && <small> · {meta}</small>}</strong><p>{detail}</p>{action && !ok && <p className="next">Next: {action}</p>}</div></li>;
}

/** Gmail, calendar, ChatGPT and database health on one screen. */
export function Diagnostics({ onChanged }: { onChanged: () => void }) {
  const data = useLoad(() => api.get<DiagnosticsData>('/api/diagnostics'));
  const [checks, setChecks] = useState<Record<string, Check> | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const d = data.data;
  const runChecks = async () => {
    setChecking(true); setError(undefined);
    try { setChecks((await api.post<{ results: Record<string, Check> }>('/api/diagnostics/check')).results); await data.reload(); onChanged(); } catch (failure) { setError(describeError(failure)); } finally { setChecking(false); }
  };
  if (!d) return <div className="panel diag"><p className="hint pad">{data.error || 'Loading diagnostics…'}</p></div>;
  const live = (id: string) => checks?.[id];
  return (
    <div className="panel diag" aria-labelledby="diag-heading">
      <div className="panel-head"><div><h3 id="diag-heading">Diagnostics</h3><p>Gmail, Calendar, ChatGPT, database and background work in one place. Checked {ago(d.generatedAt)}.</p></div><button className="btn plain" onClick={runChecks} disabled={checking}><RefreshCw size={14} className={checking ? 'spin' : ''} aria-hidden /> {checking ? 'Checking…' : 'Run live checks'}</button></div>
      <ErrorLine {...(error ?? {})} />
      <ul className="diag-list">
        <Row label="Database" ok={live('database')?.ok ?? d.database.ok} detail={live('database')?.detail ?? d.database.detail} action={d.database.action} meta={d.database.storage === 'postgres' ? 'PostgreSQL' : 'Memory only'} />
        {d.connections.map((connection) => {
          const probe = live(connection.id);
          const failing = connection.status === 'error' || probe?.ok === false;
          return <Row key={connection.id} label={connection.label} ok={probe ? probe.ok : failing ? false : connection.status === 'connected'} detail={probe && !probe.ok ? probe.detail : connection.lastSyncError ?? probe?.detail ?? `Connected${connection.lastSyncedAt ? ` · last synced ${ago(connection.lastSyncedAt)}` : ' · not synced yet'}`} action={probe?.action ?? 'Open Connections and reconnect the account, then sync again.'} meta={connection.provider === 'gmail' ? connection.canDraft ? 'read + drafts' : 'read-only' : connection.canWrite ? 'read + create events' : 'read-only'} />;
        })}
        {!d.connections.length && <Row label="Google" ok={null} detail="No Google account is connected yet." />}
        <Row label="ChatGPT plan" ok={live('chatgpt') ? live('chatgpt')!.ok : d.chatgpt.connected ? true : null} detail={live('chatgpt')?.detail ?? (d.chatgpt.connected ? `Connected as ${d.chatgpt.email ?? 'ChatGPT user'}${d.chatgpt.selected ? ' · in use' : ' · not selected'}` : 'Not connected. Optional.')} action={live('chatgpt')?.action} />
        <Row label="Intelligence engine" ok={d.ai.providers.find((provider) => provider.id === d.ai.provider)?.configured ?? false} detail={`${d.ai.providers.find((provider) => provider.id === d.ai.provider)?.label ?? d.ai.provider}${d.ai.providers.find((provider) => provider.id === d.ai.provider)?.external ? ' · content leaves this installation' : ' · stays on this installation'}`} />
        <Row label="Background queue" ok={d.queue.failed24h === 0} detail={`${d.queue.queued} queued · ${d.queue.running} running · ${d.queue.succeeded24h} succeeded and ${d.queue.failed24h} failed in 24h`} action="See Runs → Background jobs for the sanitized reason." />
        <Row label="Scheduler" ok={d.scheduler.lastTickAt ? Date.now() - new Date(d.scheduler.lastTickAt).getTime() < 180_000 : null} detail={d.scheduler.lastTickAt ? `Last tick ${ago(d.scheduler.lastTickAt)}` : 'No tick has run since this process started.'} action="Check that the web service is running." />
        {d.telegram.configured && <Row label="Telegram" ok={d.telegram.lastError && (!d.telegram.lastOkAt || d.telegram.lastError.at > d.telegram.lastOkAt) ? false : d.telegram.lastOkAt ? true : null} detail={d.telegram.lastError && (!d.telegram.lastOkAt || d.telegram.lastError.at > d.telegram.lastOkAt) ? d.telegram.lastError.message : d.telegram.lastOkAt ? `Listening${d.telegram.linked ? ' · chat linked' : ' · chat not linked yet'}` : 'Starting up.'} action="Open Set up Orbit → Telegram to check the bot token, or make sure only one copy of Orbit uses this bot." />}
        {d.sharing.enabled && <Row label="Orbit-to-Orbit" ok={d.sharing.deliveriesFailed24h === 0} detail={`${d.sharing.trustedPeers} trusted ${d.sharing.trustedPeers === 1 ? 'peer' : 'peers'} · ${d.sharing.deliveriesQueued} waiting to deliver · ${d.sharing.deliveriesFailed24h} failed in 24h`} action="Check the other Orbit is online and that you both trust each other." />}
        <Row label="Agent" ok={d.agent.enabled && !d.agent.paused} detail={!d.agent.enabled ? 'Disabled on this installation (AGENT_ENABLED=false).' : d.agent.paused ? 'Paused by you. Schedules and write actions are stopped.' : d.agent.automationsKilled ? 'Running; the automations kill switch is on.' : 'Running.'} />
      </ul>
      {d.queue.recentFailures.length > 0 && <div className="diag-failures"><h4>Recent failures</h4><ul>{d.queue.recentFailures.map((failure) => <li key={failure.id}><Chip tone="bad">{failure.kind}</Chip> {failure.error?.message ?? 'Failed'} <span>{failure.error?.action}</span></li>)}</ul></div>}
    </div>
  );
}
