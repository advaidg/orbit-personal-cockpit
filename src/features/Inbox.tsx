import { useMemo, useState } from 'react';
import { BellOff, CalendarDays, CheckCircle2, Clock3, FilePenLine, Inbox as InboxIcon, ListPlus, Mail, MoreHorizontal, Star, UserRoundX, Zap } from 'lucide-react';
import { api, describeError } from '../api';
import type { Priority, Proposal, Signal } from '../types';
import { ProposalCard } from './ProposalCard';
import { Chip, Empty, ErrorLine, PageHead, ago } from './ui';

type Filter = 'open' | 'urgent' | 'waiting' | 'snoozed' | 'quieted' | 'resolved';
const stateOf = (signal: Signal) => ((signal.metadata?.state ?? {}) as { status?: string; snoozedUntil?: string });
const FILTERS: Array<[Filter, string]> = [['open', 'Open'], ['urgent', 'Urgent'], ['waiting', 'Waiting'], ['snoozed', 'Snoozed'], ['quieted', 'Quieted'], ['resolved', 'Resolved']];
const ICONS: Record<string, typeof Mail> = { action: Zap, waiting: Clock3, calendar: CalendarDays, money: Mail, travel: Mail, people: Mail, noise: BellOff };

function matches(signal: Signal, filter: Filter): boolean {
  const state = stateOf(signal).status ?? 'open';
  if (filter === 'snoozed') return state === 'snoozed';
  if (filter === 'resolved') return state === 'resolved';
  if (state === 'snoozed' || state === 'resolved') return false;
  if (filter === 'quieted') return signal.category === 'noise';
  if (signal.category === 'noise') return false;
  if (filter === 'urgent') return signal.priority === 'now';
  if (filter === 'waiting') return signal.category === 'waiting';
  return true;
}

function SignalItem({ signal, expanded, onToggle, onProposals, onNotice, canDraft }: { signal: Signal; expanded: boolean; onToggle: () => void; onProposals: (proposals: Proposal[], duplicates: number) => void; onNotice: (message: string) => void; canDraft: boolean }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<{ message: string; action?: string }>();
  const Icon = ICONS[signal.category] ?? Mail;
  const state = stateOf(signal);
  const isEmail = signal.source === 'gmail';
  const act = async (action: string, params: object = {}) => {
    setBusy(action);
    setError(undefined);
    try {
      const result = await api.post<{ proposals: Proposal[]; duplicates: number }>(`/api/agent/signals/${signal.id}/actions`, { action, params });
      onProposals(result.proposals, result.duplicates);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy('');
    }
  };
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const tomorrowMorning = () => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return date.toISOString(); };

  return (
    <article className={`inbox-item${expanded ? ' open' : ''}`} id={`signal-${signal.id}`}>
      <button className="inbox-head" onClick={onToggle} aria-expanded={expanded}>
        <span className={`signal-icon ${signal.category}`}><Icon size={17} aria-hidden /></span>
        <span className="inbox-text">
          <span className="signal-meta"><span className={`priority ${signal.priority}`}>{signal.priority}</span><span>{signal.sender.replace(/<[^>]*>/g, '').trim()}</span><i /> <span>{ago(signal.occurredAt)}</span>{state.status === 'snoozed' && <Chip>Snoozed until {state.snoozedUntil ? new Date(state.snoozedUntil).toLocaleDateString() : '…'}</Chip>}{state.status === 'resolved' && <Chip tone="good">Resolved</Chip>}</span>
          <strong>{signal.title}</strong>
          <span className="inbox-summary">{signal.summary}</span>
        </span>
        <MoreHorizontal size={17} aria-hidden className="row-chevron" />
      </button>
      {expanded && (
        <div className="inbox-actions" role="group" aria-label={`Actions for ${signal.title}`}>
          {isEmail && <button className="btn primary" disabled={!!busy || !canDraft} title={canDraft ? undefined : 'Choose “Read plus create drafts” in Connections first'} onClick={() => act('draft_reply')}><FilePenLine size={15} aria-hidden /> {busy === 'draft_reply' ? 'Writing…' : 'Draft reply'}</button>}
          <button className="btn plain" disabled={!!busy} onClick={() => act('waiting_on')}><Clock3 size={15} aria-hidden /> Track waiting-on</button>
          <button className="btn plain" disabled={!!busy} onClick={() => act('i_owe')}>I owe a reply</button>
          <button className="btn plain" disabled={!!busy} onClick={() => act('create_task')}><ListPlus size={15} aria-hidden /> Create task</button>
          <select aria-label="Snooze" className="btn plain" disabled={!!busy} value="" onChange={(event) => { const value = event.target.value; if (value) void act('snooze', { until: value === 'tomorrow' ? tomorrowMorning() : inDays(Number(value)) }); }}><option value="">Snooze…</option><option value="tomorrow">Until tomorrow</option><option value="3">3 days</option><option value="7">Next week</option></select>
          <button className="btn plain" disabled={!!busy} onClick={() => act('resolve')}><CheckCircle2 size={15} aria-hidden /> Resolved</button>
          {isEmail && <button className="btn plain" disabled={!!busy} onClick={() => act('priority_person')}><Star size={15} aria-hidden /> Priority person</button>}
          {isEmail && <button className="btn plain" disabled={!!busy} onClick={() => act('ignore_sender')}><UserRoundX size={15} aria-hidden /> Ignore sender</button>}
          <button className="btn plain" disabled={!!busy} onClick={() => act('noise')}><BellOff size={15} aria-hidden /> Not important</button>
          <ErrorLine {...(error ?? {})} />
          <p className="hint">Each action becomes a preview you approve. {state.status === 'snoozed' ? 'It will return on its own.' : ''}</p>
        </div>
      )}
    </article>
  );
}

export function Inbox({ signals, query, canDraft, onChanged, onNotice, onOpenApprovals, focusId }: { signals: Signal[]; query: string; canDraft: boolean; onChanged: () => void; onNotice: (message: string) => void; onOpenApprovals: () => void; focusId?: string }) {
  const [filter, setFilter] = useState<Filter>('open');
  const [expanded, setExpanded] = useState<string | null>(focusId ?? null);
  const [review, setReview] = useState<{ proposals: Proposal[]; duplicates: number } | null>(null);
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(() => signals.filter((signal) => matches(signal, filter) && (!normalized || `${signal.title} ${signal.summary} ${signal.sender}`.toLowerCase().includes(normalized))), [signals, filter, normalized]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([key]) => [key, signals.filter((signal) => matches(signal, key)).length])) as Record<Filter, number>, [signals]);

  return (
    <section aria-labelledby="inbox-heading">
      <PageHead eyebrow="INBOX" title="Messages that matter.">Everything Orbit surfaced. Open an item to act on it: each action is previewed and waits for your approval.</PageHead>
      <div className="filter-row" role="tablist" aria-label="Inbox filter">{FILTERS.map(([key, label]) => <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}<b>{counts[key]}</b></button>)}</div>
      {review && (
        <div className="stack inline-review" role="region" aria-label="Review before it happens">
          <h2 className="section-title" id="inbox-heading">Review before it happens</h2>
          {review.proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} compact onChanged={() => { setReview(null); onChanged(); }} onNotice={onNotice} />)}
          {!review.proposals.length && <Empty title="Already proposed.">Orbit has already prepared this exact action{review.duplicates ? ' — find it in Approvals or Runs' : ''}.</Empty>}
          <div className="row-gap"><button className="link" onClick={() => setReview(null)}>Dismiss</button><button className="link" onClick={onOpenApprovals}>Open Approval Center</button></div>
        </div>
      )}
      <div className="panel inbox-list">
        {visible.map((signal) => <SignalItem key={signal.id} signal={signal} expanded={expanded === signal.id} canDraft={canDraft} onToggle={() => setExpanded(expanded === signal.id ? null : signal.id)} onProposals={(proposals, duplicates) => { setReview({ proposals, duplicates }); onChanged(); }} onNotice={onNotice} />)}
        {!visible.length && <Empty title={normalized ? 'No messages match your search.' : 'Nothing here.'}><InboxIcon size={16} aria-hidden /> {filter === 'open' ? 'Sync to bring in new messages.' : 'Try another filter.'}</Empty>}
      </div>
    </section>
  );
}

export type { Priority };
