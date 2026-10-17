import { useState } from 'react';
import { Activity, CheckCircle2, CircleDashed, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { api, describeError } from '../api';
import { useLoad, usePoll } from '../hooks';
import type { JobInfo, Run, RunDetail, RunStatus } from '../types';
import { ProposalCard } from './ProposalCard';
import { Chip, Empty, ErrorLine, PageHead, ago } from './ui';

const STATUS: Record<RunStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }> = {
  planning: { label: 'Planning', tone: 'info' }, awaiting_approval: { label: 'Waiting for you', tone: 'warn' }, executing: { label: 'Working', tone: 'info' },
  succeeded: { label: 'Done', tone: 'good' }, failed: { label: 'Needs attention', tone: 'bad' }, canceled: { label: 'Canceled', tone: 'neutral' }
};
const TRIGGER: Record<string, string> = { manual: 'You', signal: 'New message', automation: 'Automation', ask: 'Ask Orbit', schedule: 'Schedule', sync: 'Sync' };
const STEP_ICON: Record<string, typeof Activity> = { succeeded: CheckCircle2, failed: XCircle, blocked: ShieldAlert, pending: CircleDashed, running: Loader2 };

function RunDetailView({ id, onClose, onChanged, onNotice }: { id: string; onClose: () => void; onChanged: () => void; onNotice: (message: string) => void }) {
  const detail = useLoad(() => api.get<RunDetail>(`/api/agent/runs/${id}`), [id]);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const data = detail.data;
  usePoll(detail.reload, 3000, !!data && ['planning', 'awaiting_approval', 'executing'].includes(data.run.status));
  const cancel = async () => { try { await api.post(`/api/agent/runs/${id}/cancel`); onNotice('Run canceled.'); await detail.reload(); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  if (!data) return <div className="panel run-detail"><p className="hint">{detail.error || 'Loading…'}</p></div>;
  const { run } = data;
  const active = ['planning', 'awaiting_approval', 'executing'].includes(run.status);
  return (
    <div className="panel run-detail" role="region" aria-label="Run details">
      <header><div><Chip tone={STATUS[run.status].tone}>{STATUS[run.status].label}</Chip> {run.dryRun && <Chip>Dry run</Chip>}<h2>{run.objective}</h2><small>{TRIGGER[run.trigger.type] ?? run.trigger.type}{run.trigger.label ? ` · ${run.trigger.label}` : ''} · {run.provider === 'rules' ? 'Private rules' : run.provider} · started {ago(run.startedAt)}</small></div><div className="row-gap">{active && <button className="btn plain danger-text" onClick={cancel}>Cancel run</button>}<button className="btn plain" onClick={onClose}>Close</button></div></header>
      <ErrorLine {...(error ?? {})} />
      {run.result && <p className="result-line">{run.result}</p>}
      {run.answer && <pre className="proposal-preview">{run.answer}</pre>}
      {run.error && <ErrorLine message={run.error.message} action={run.error.action} />}
      <h3 className="section-title">What Orbit did</h3>
      <ol className="timeline">{data.steps.map((step) => { const Icon = STEP_ICON[step.status] ?? CircleDashed; return <li key={step.id} className={step.status}><Icon size={15} aria-hidden className={step.status === 'running' ? 'spin' : ''} /><div><strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}</div></li>; })}</ol>
      {data.proposals.length > 0 && <><h3 className="section-title">Actions</h3><div className="stack">{data.proposals.map((proposal) => <ProposalCard key={proposal.id} compact proposal={{ ...proposal, execution: (() => { const execution = data.executions.find((item) => item.proposalId === proposal.id); return execution ? { summary: execution.summary, status: execution.status, undoable: execution.undoable && execution.status !== 'undone', verification: execution.verification } : undefined; })() }} onChanged={async () => { await detail.reload(); onChanged(); }} onNotice={onNotice} />)}</div></>}
    </div>
  );
}

function JobRow({ job, onCancel }: { job: JobInfo; onCancel: () => void }) {
  const tone = job.status === 'succeeded' ? 'good' : job.status === 'failed' ? 'bad' : job.status === 'running' ? 'info' : 'neutral';
  return (
    <li className="job-row"><div><Chip tone={tone}>{job.status}</Chip> <strong>{job.kind}</strong><small> · {ago(job.createdAt)}{job.attempts > 1 ? ` · attempt ${job.attempts}` : ''}</small>{job.progress?.message && job.status === 'running' && <p>{job.progress.message}{job.progress.total ? ` (${job.progress.done ?? 0}/${job.progress.total})` : ''}</p>}{job.error && <p className="error-line">{job.error.message} <span>{job.error.action}</span></p>}</div>{['queued', 'running'].includes(job.status) && <button className="btn plain danger-text" onClick={onCancel}>Cancel</button>}</li>
  );
}

export function Runs({ onChanged, onNotice }: { onChanged: () => void; onNotice: (message: string) => void }) {
  const runs = useLoad(() => api.get<{ runs: Run[] }>('/api/agent/runs?limit=60'));
  const jobs = useLoad(() => api.get<{ jobs: JobInfo[] }>('/api/jobs?limit=15'));
  const [selected, setSelected] = useState<string | null>(null);
  const live = (runs.data?.runs ?? []).some((run) => ['planning', 'awaiting_approval', 'executing'].includes(run.status)) || (jobs.data?.jobs ?? []).some((job) => ['queued', 'running'].includes(job.status));
  usePoll(async () => { await Promise.all([runs.reload(), jobs.reload()]); }, 4000, live);
  const list = runs.data?.runs ?? [];
  return (
    <section aria-labelledby="runs-heading">
      <PageHead eyebrow="RUNS" title="A record of everything Orbit did.">Every suggestion, approval, execution, verification and retry is logged here in plain language. Message content, prompts and credentials are never stored in this log.</PageHead>
      <div className="split">
        <div>
          <h2 className="section-title" id="runs-heading">Agent runs <b>{list.length}</b></h2>
          <div className="panel run-list">
            {list.map((run) => <button key={run.id} className={`run-row${selected === run.id ? ' active' : ''}`} onClick={() => setSelected(run.id)} aria-pressed={selected === run.id}><span><Chip tone={STATUS[run.status].tone}>{STATUS[run.status].label}</Chip> {run.dryRun && <Chip>Dry run</Chip>}</span><strong>{run.objective}</strong><small>{TRIGGER[run.trigger.type] ?? run.trigger.type} · {ago(run.startedAt)} · {run.proposalCount ?? 0} action{run.proposalCount === 1 ? '' : 's'}</small>{run.result && <em>{run.result}</em>}</button>)}
            {!list.length && !runs.loading && <Empty title="No runs yet.">Runs appear after a sync, an automation, or when you use Ask Orbit.</Empty>}
          </div>
          <h2 className="section-title">Background jobs</h2>
          <ul className="panel job-list">{(jobs.data?.jobs ?? []).map((job) => <JobRow key={job.id} job={job} onCancel={async () => { await api.post(`/api/jobs/${job.id}/cancel`); await jobs.reload(); }} />)}{!(jobs.data?.jobs ?? []).length && <li className="hint pad">No background jobs yet.</li>}</ul>
        </div>
        <div>{selected ? <RunDetailView key={selected} id={selected} onClose={() => setSelected(null)} onChanged={() => { void runs.reload(); onChanged(); }} onNotice={onNotice} /> : <Empty title="Select a run">See its plan, each step, what changed, and whether Orbit verified it.</Empty>}</div>
      </div>
    </section>
  );
}
