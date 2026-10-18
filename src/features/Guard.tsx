import { useState } from 'react';
import { Pause, Play, ShieldAlert } from 'lucide-react';
import { api, describeError } from '../api';
import { useLoad, usePoll } from '../hooks';
import type { GuardAgent, GuardOverview, GuardRequestInfo, GuardSettingsInfo } from '../types';
import { Chip, ConfirmButton, Empty, ErrorLine, PageHead, Toggle, ago } from './ui';
import { GuardActivity } from './GuardActivity';
import { GuardConnect } from './GuardConnect';
import { GuardRules } from './GuardRules';

const STRICTNESS: Array<{ id: GuardSettingsInfo['strictness']; label: string; hint: string }> = [
  { id: 'relaxed', label: 'Relaxed', hint: 'Only dangerous things stop. Unknown tools run.' },
  { id: 'balanced', label: 'Balanced', hint: 'Safe things run, dangerous things ask your phone, unknown things use the agent’s own prompt.' },
  { id: 'strict', label: 'Strict', hint: 'Anything not known to be safe asks your phone.' }
];

const number = (value: number) => value.toLocaleString('en-US');

function Pending({ request, onDone }: { request: GuardRequestInfo; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const answer = async (decision: 'approved' | 'denied', remember = false) => {
    setBusy(true);
    setError(undefined);
    try { await api.post(`/api/guard/requests/${request.id}/resolve`, { decision, remember }); onDone(); } catch (failure) { setError(describeError(failure)); onDone(); } finally { setBusy(false); }
  };
  return (
    <article className="guard-pending" aria-label={`${request.agentName} is waiting`}>
      <div className="guard-pending-head"><ShieldAlert size={16} aria-hidden /><strong>{request.agentName} is waiting for you</strong><time dateTime={request.createdAt}>{ago(request.createdAt)}</time></div>
      <code className="guard-summary">{request.summary}</code>
      {request.project && <small>Project: {request.project}</small>}
      {request.reasons.length > 0 && <ul>{request.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      <div className="row-gap">
        <button className="btn primary" disabled={busy} onClick={() => answer('approved')}>Approve</button>
        {request.hasCwd && <button className="btn plain" disabled={busy} onClick={() => answer('approved', true)}>Always allow this here</button>}
        <button className="btn danger" disabled={busy} onClick={() => answer('denied')}>Deny</button>
      </div>
      <ErrorLine {...(error ?? {})} />
    </article>
  );
}

function AgentRow({ agent, onChanged, onNotice }: { agent: GuardAgent; onChanged: () => void; onNotice: (message: string) => void }) {
  const [budget, setBudget] = useState(agent.dailyTokenBudget ? String(agent.dailyTokenBudget) : '');
  const [error, setError] = useState<{ message: string; action?: string }>();
  const patch = async (body: object, done?: string) => { setError(undefined); try { await api.patch(`/api/guard/agents/${agent.id}`, body); if (done) onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  const used = agent.usage.weighted;
  const cap = agent.dailyTokenBudget ?? 0;
  const percent = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="guard-agent">
      <div className="guard-agent-main">
        <div className="commit-meta"><strong>{agent.name}</strong>{agent.paused ? <Chip tone="warn">Paused</Chip> : <Chip tone={agent.lastSeenAt && Date.now() - new Date(agent.lastSeenAt).getTime() < 3_600_000 ? 'good' : 'neutral'}>{agent.lastSeenAt ? `Seen ${ago(agent.lastSeenAt)}` : 'Not connected yet'}</Chip>}<small>token {agent.tokenHint}</small></div>
        <p className="guard-usage">Today: <b>{number(used)}</b> weighted tokens{agent.usage.costUsd !== null && <> · about <b>${agent.usage.costUsd.toFixed(2)}</b></>}{!used && <span> (usage appears once the hook reports it)</span>}</p>
        {cap > 0 && <div className="guard-meter" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Share of the daily budget used"><i style={{ width: `${percent}%` }} className={percent >= 100 ? 'full' : percent >= 80 ? 'high' : ''} /></div>}
        <form className="inline-edit" onSubmit={(event) => { event.preventDefault(); void patch({ dailyTokenBudget: budget ? Number(budget) : null }, budget ? 'Budget saved.' : 'Budget removed.'); }}>
          <input aria-label={`Daily token budget for ${agent.name}`} inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value.replace(/[^\d]/g, ''))} placeholder="Daily token budget (optional), e.g. 2000000" />
          <button className="btn plain" type="submit">Set budget</button>
        </form>
        <ErrorLine {...(error ?? {})} />
      </div>
      <div className="commit-actions">
        <button className="btn plain" onClick={() => patch({ paused: !agent.paused }, agent.paused ? 'Resumed.' : 'Paused. Every call from it is refused.')}>{agent.paused ? <><Play size={13} aria-hidden /> Resume</> : <><Pause size={13} aria-hidden /> Pause</>}</button>
        <ConfirmButton label="Remove" confirmLabel="Remove" onConfirm={async () => { await api.del(`/api/guard/agents/${agent.id}`); onNotice('Agent removed. Its token no longer works.'); onChanged(); }} />
      </div>
    </div>
  );
}

function Settings({ settings, onChanged, onNotice }: { settings: GuardSettingsInfo; onChanged: () => void; onNotice: (message: string) => void }) {
  const [wait, setWait] = useState(String(settings.waitSeconds));
  const [rates, setRates] = useState(settings.usdPerMillion ? { input: String(settings.usdPerMillion.input), output: String(settings.usdPerMillion.output), cacheRead: String(settings.usdPerMillion.cacheRead), cacheWrite: String(settings.usdPerMillion.cacheWrite) } : { input: '', output: '', cacheRead: '', cacheWrite: '' });
  const [error, setError] = useState<{ message: string; action?: string }>();
  const save = async (body: object, done: string) => { setError(undefined); try { await api.put('/api/guard/settings', body); onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  const rateBody = (rates.input && rates.output) ? { usdPerMillion: { input: Number(rates.input), output: Number(rates.output), cacheRead: Number(rates.cacheRead || 0), cacheWrite: Number(rates.cacheWrite || 0) } } : { usdPerMillion: null };
  return (
    <div className="panel pad">
      <div className="panel-head flush"><div><h3>Behaviour</h3><p>How long Orbit waits for you, what happens if you don’t answer, and the daily summary.</p></div></div>
      <form className="setup-form" onSubmit={(event) => { event.preventDefault(); void save({ waitSeconds: Number(wait) }, 'Saved.'); }}>
        <label className="field"><span>Wait for your answer (seconds, 5–540)</span><input inputMode="numeric" value={wait} onChange={(event) => setWait(event.target.value.replace(/[^\d]/g, ''))} /></label>
        <div className="seg-row" role="radiogroup" aria-label="If nobody answers">{(['defer', 'deny'] as const).map((value) => <button type="button" role="radio" aria-checked={settings.onTimeout === value} key={value} className={settings.onTimeout === value ? 'active' : ''} onClick={() => void save({ onTimeout: value }, 'Saved.')}>{value === 'defer' ? 'Hand back to the agent’s own prompt' : 'Refuse'}</button>)}</div>
        <button className="btn primary" type="submit">Save wait time</button>
      </form>
      <div className="channel-row"><div><strong>Evening summary</strong><small>After 6 pm, if your agents did anything: what ran, what needed you, what was blocked.</small></div><Toggle checked={settings.dailyDigest} label="Evening summary" onChange={(value) => void save({ dailyDigest: value }, value ? 'You’ll get a summary each evening.' : 'No more summaries.')} /></div>
      <details className="setup-advanced"><summary>Show usage in dollars (optional)</summary>
        <form className="setup-form" onSubmit={(event) => { event.preventDefault(); void save(rateBody, rateBody.usdPerMillion ? 'Prices saved.' : 'Dollar amounts hidden.'); }}>
          <p className="hint">Enter your model’s price per million tokens (check your provider’s pricing page). Leave blank to see tokens only.</p>
          <div className="field-row"><label className="field"><span>Input $</span><input inputMode="decimal" value={rates.input} onChange={(event) => setRates({ ...rates, input: event.target.value })} /></label><label className="field"><span>Output $</span><input inputMode="decimal" value={rates.output} onChange={(event) => setRates({ ...rates, output: event.target.value })} /></label></div>
          <div className="field-row"><label className="field"><span>Cache read $</span><input inputMode="decimal" value={rates.cacheRead} onChange={(event) => setRates({ ...rates, cacheRead: event.target.value })} /></label><label className="field"><span>Cache write $</span><input inputMode="decimal" value={rates.cacheWrite} onChange={(event) => setRates({ ...rates, cacheWrite: event.target.value })} /></label></div>
          <button className="btn plain" type="submit">Save prices</button>
        </form>
      </details>
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}

export function Guard({ onChanged, onNotice }: { onChanged: () => void; onNotice: (message: string) => void }) {
  const overview = useLoad(() => api.get<GuardOverview>('/api/guard'));
  const [tick, setTick] = useState(0);
  const data = overview.data;
  const refresh = () => { void overview.reload(); setTick((value) => value + 1); onChanged(); };
  // Keep the list of waiting requests fresh: an agent is blocked until you answer.
  usePoll(() => { void overview.reload(); setTick((value) => value + 1); }, 3_000);
  const setStrictness = async (value: GuardSettingsInfo['strictness']) => { try { await api.put('/api/guard/settings', { strictness: value }); onNotice(`Now ${value}.`); refresh(); } catch (failure) { onNotice(describeError(failure).message); } };

  return (
    <section aria-labelledby="guard-heading">
      <PageHead eyebrow="AGENTS" title="Stop babysitting your agents.">
        <span id="guard-heading">Orbit sits between your coding agent and your machine. Safe calls pass silently, dangerous ones wait for a tap on your phone with a plain reason, and everything is recorded. It’s a safety net for overeager agents and honest mistakes, not a sandbox against a malicious one.</span>
      </PageHead>
      {overview.error && <p className="error-line">{overview.error}</p>}
      {data && (
        <div className="stack">
          <div className="guard-stats" aria-label="Today">
            <div><b>{number(data.today.total)}</b><span>calls today</span></div>
            <div><b>{number(data.today.allowed)}</b><span>passed silently</span></div>
            <div><b>{number(data.today.asked)}</b><span>needed you</span></div>
            <div><b>{number(data.today.denied)}</b><span>refused</span></div>
            <div><b>{data.today.waitedSeconds ? `${Math.max(1, Math.round(data.today.waitedSeconds / 60))} min` : '—'}</b><span>agents waited</span></div>
          </div>

          {data.pending.length > 0 && <div className="stack" role="region" aria-label="Waiting for you" aria-live="polite">{data.pending.map((request) => <Pending key={request.id} request={request} onDone={refresh} />)}</div>}

          <GuardConnect install={data.install} hasAgents={data.agents.length > 0} onCreated={refresh} onNotice={onNotice} />

          {data.agents.length > 0 && (
            <div className="panel pad">
              <div className="panel-head flush"><div><h3>Your agents</h3><p>Each has its own token, so you can pause or remove one without touching the others.</p></div></div>
              <div className="guard-strictness" role="radiogroup" aria-label="How strict Orbit is">
                {STRICTNESS.map((item) => <button type="button" role="radio" aria-checked={data.settings.strictness === item.id} key={item.id} className={data.settings.strictness === item.id ? 'on' : ''} onClick={() => void setStrictness(item.id)}><b>{item.label}</b><span>{item.hint}</span></button>)}
              </div>
              {data.agents.map((agent) => <AgentRow key={agent.id} agent={agent} onChanged={refresh} onNotice={onNotice} />)}
            </div>
          )}
          {!data.agents.length && <Empty title="No agent connected yet.">Create a token above and your next Claude Code session is covered.</Empty>}

          <GuardActivity refreshKey={tick} />
          <GuardRules onNotice={onNotice} />
          <Settings settings={data.settings} onChanged={refresh} onNotice={onNotice} />
        </div>
      )}
    </section>
  );
}
