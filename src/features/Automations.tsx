import { useState } from 'react';
import { Play, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { api, describeError } from '../api';
import { useLoad } from '../hooks';
import type { Automation, AutomationAction, AutomationInput, Recipe, Run } from '../types';
import { Chip, ConfirmButton, Empty, ErrorLine, Notice, PageHead, Toggle, ago } from './ui';
import { AutomationBuilder } from './AutomationBuilder';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const APPROVAL = { always_ask: 'Always ask', external_only: 'Ask only for external changes', auto: 'Automatic where allowed' } as const;
const SCOPE: Record<string, string> = { brief: 'a morning brief', unresolved: 'unresolved items', bills_due: 'bills due soon', waiting_on: 'the waiting-on list', no_response: 'people who have not replied' };

export function describeTrigger(automation: Pick<AutomationInput, 'trigger' | 'filter' | 'scope'>, timezone: string): string {
  const { trigger, filter, scope } = automation;
  if (trigger.type === 'new_email') {
    const parts = [filter.category && `category is ${filter.category}`, filter.keyword && `it mentions “${filter.keyword}”`, filter.sender && `sender contains “${filter.sender}”`, filter.priority && `priority is ${filter.priority}`, filter.importantPeopleOnly && 'sender is a priority person', filter.account && `account is ${filter.account}`].filter(Boolean);
    return `When a new email arrives${parts.length ? ` and ${parts.join(' and ')}` : ''}`;
  }
  if (trigger.type === 'schedule') return `${trigger.kind === 'daily' ? 'Every day' : `Every ${DAYS[trigger.weekday ?? 1]}`} at ${trigger.at} (${timezone}) — review ${SCOPE[scope ?? 'brief']}`;
  return `When something is due within ${trigger.withinHours} hours — review ${SCOPE[scope ?? 'bills_due']}`;
}

export const describeActions = (actions: AutomationAction[]) => actions.map((action) => action.kind === 'create_task' ? 'create a task' : action.kind === 'draft_reply' ? `draft a ${action.template === 'follow_up' ? 'follow-up' : action.template === 'meeting' ? 'meeting reply' : 'reply'}` : action.kind === 'remind' ? 'set a reminder' : action.kind === 'notify' ? 'notify you' : 'track a commitment').join(', then ');

function AutomationCard({ automation, timezone, blocked, onChanged, onNotice, onEdit }: { automation: Automation; timezone: string; blocked: boolean; onChanged: () => void; onNotice: (message: string) => void; onEdit: () => void }) {
  const [error, setError] = useState<{ message: string; action?: string }>();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = async (body: object, done?: string) => { try { await api.patch(`/api/automations/${automation.id}`, body); if (done) onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  const run = async (dryRun: boolean) => {
    setBusy(true); setError(undefined);
    try { const result = await api.post<{ proposals: number }>(`/api/automations/${automation.id}/run`, { dryRun }); onNotice(dryRun ? `Dry run finished: ${result.proposals} action${result.proposals === 1 ? '' : 's'} would be proposed. See Runs.` : `${result.proposals} action${result.proposals === 1 ? '' : 's'} proposed. See Approvals.`); onChanged(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); }
  };
  const history = async () => { try { setRuns((await api.get<{ runs: Run[] }>(`/api/automations/${automation.id}/runs`)).runs); } catch (failure) { setError(describeError(failure)); } };
  return (
    <article className={`automation${automation.enabled && !blocked ? '' : ' off'}`}>
      <header>
        <div><h3>{automation.name}</h3><p>{describeTrigger(automation, timezone)} → {describeActions(automation.actions)}.</p></div>
        <label className="switch-label"><Toggle checked={automation.enabled} label={`${automation.name} enabled`} onChange={(value) => patch({ enabled: value }, value ? 'Automation on.' : 'Automation paused.')} /><span>{automation.enabled ? 'On' : 'Off'}</span></label>
      </header>
      <div className="memory-chips"><Chip tone={automation.approval === 'always_ask' ? 'good' : 'warn'}>{APPROVAL[automation.approval]}</Chip>{automation.dryRun && <Chip tone="info">Dry-run mode</Chip>}<Chip>Max {automation.maxRunsPerDay}/day</Chip>{automation.notifyOnFailure && <Chip>Alerts on failure</Chip>}</div>
      <dl className="facts-row"><div><dt>Next run</dt><dd>{automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : automation.trigger.type === 'new_email' ? 'On each new matching email' : '—'}</dd></div><div><dt>Last run</dt><dd>{automation.lastRunAt ? `${ago(automation.lastRunAt)} · ${automation.lastRunStatus}` : 'Never'}</dd></div><div><dt>Total runs</dt><dd>{automation.runCount}</dd></div></dl>
      {automation.lastRunNote && <p className={`hint${automation.lastRunStatus === 'failed' ? ' bad' : ''}`}>{automation.lastRunNote}</p>}
      <ErrorLine {...(error ?? {})} />
      <footer>
        <button className="btn plain" disabled={busy} onClick={() => run(true)}>Dry run</button>
        <button className="btn plain" disabled={busy} onClick={() => run(false)}><Play size={14} aria-hidden /> Run now</button>
        <button className="btn plain" onClick={onEdit}>Edit</button>
        <button className="btn plain" onClick={() => (runs ? setRuns(null) : void history())}>{runs ? 'Hide history' : 'Run history'}</button>
        <ConfirmButton label={<Trash2 size={14} aria-label="Delete automation" />} confirmLabel="Delete" onConfirm={async () => { await api.del(`/api/automations/${automation.id}`); onChanged(); }} />
      </footer>
      {runs && <ul className="run-history">{runs.map((item) => <li key={item.id}><Chip tone={item.status === 'succeeded' ? 'good' : item.status === 'failed' ? 'bad' : 'info'}>{item.status.replace('_', ' ')}</Chip> {item.dryRun && <Chip>dry run</Chip>} <span>{item.result ?? item.objective}</span> <small>{ago(item.startedAt)}</small></li>)}{!runs.length && <li className="hint">No runs yet.</li>}</ul>}
    </article>
  );
}

export function Automations({ timezone, onChanged, onNotice }: { timezone: string; onChanged: () => void; onNotice: (message: string) => void }) {
  const data = useLoad(() => api.get<{ automations: Automation[]; recipes: Recipe[]; killSwitch: boolean; paused: boolean; enabled: boolean }>('/api/automations'));
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const reload = () => { void data.reload(); onChanged(); };
  const blocked = !!data.data && (data.data.killSwitch || data.data.paused || !data.data.enabled);
  const setKill = async (value: boolean) => { await api.patch('/api/agent/settings', { automationsKilled: value }); onNotice(value ? 'All automations stopped.' : 'Automations can run again.'); reload(); };
  const addRecipe = async (recipe: Recipe) => { try { await api.post('/api/automations', { recipe: recipe.id, enabled: false }); onNotice(`“${recipe.name}” added. Review it, then switch it on.`); reload(); } catch (failure) { onNotice(describeError(failure).message); } };
  const existing = new Set((data.data?.automations ?? []).map((item) => item.recipe));
  return (
    <section aria-labelledby="automations-heading">
      <PageHead eyebrow="AUTOMATIONS" title="Let Orbit handle the routine." actions={<button className="btn primary" onClick={() => setEditing('new')}><Plus size={15} aria-hidden /> New automation</button>}>
        When something happens, Orbit prepares the work. Anything that changes something outside Orbit still asks first unless you explicitly allow it.
      </PageHead>
      {data.data && !data.data.enabled && <Notice tone="warn" title="Automations are disabled on this installation">Set AUTOMATIONS_ENABLED=true and redeploy to run them.</Notice>}
      {data.data?.paused && <Notice tone="warn" title="The agent is paused">Automations will not run until you resume it.</Notice>}
      <div className={`kill-switch${data.data?.killSwitch ? ' on' : ''}`}><ShieldOff size={18} aria-hidden /><div><strong>Kill switch</strong><span>{data.data?.killSwitch ? 'All automations are stopped.' : 'Stop every automation instantly. Your settings are kept.'}</span></div><Toggle checked={!!data.data?.killSwitch} label="Stop all automations" onChange={setKill} /></div>
      {data.error && <Notice tone="bad" title="Could not load automations">{data.error}</Notice>}
      <h2 className="section-title" id="automations-heading">Your automations <b>{data.data?.automations.length ?? 0}</b></h2>
      <div className="stack">
        {(data.data?.automations ?? []).map((automation) => <AutomationCard key={automation.id} automation={automation} timezone={timezone} blocked={blocked} onChanged={reload} onNotice={onNotice} onEdit={() => setEditing(automation)} />)}
        {!(data.data?.automations.length) && !data.loading && <Empty title="No automations yet.">Start from a recipe below, or build your own.</Empty>}
      </div>
      <h2 className="section-title">Starter recipes</h2>
      <div className="recipe-grid">{(data.data?.recipes ?? []).map((recipe) => <div className="recipe" key={recipe.id}><div><h3>{recipe.name}</h3><p>{recipe.summary}</p></div><button className="btn plain" disabled={existing.has(recipe.id)} onClick={() => addRecipe(recipe)}>{existing.has(recipe.id) ? 'Added' : 'Add'}</button></div>)}</div>
      {editing && <AutomationBuilder automation={editing === 'new' ? null : editing} timezone={timezone} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); onNotice('Automation saved.'); }} />}
    </section>
  );
}
