import { useState } from 'react';
import { Clock3, Plus } from 'lucide-react';
import { api, describeError } from '../api';
import { fromLocalInput, useLoad } from '../hooks';
import type { Commitment } from '../types';
import { Chip, Empty, ErrorLine, PageHead, ago } from './ui';
import { ProposalCard } from './ProposalCard';
import type { Proposal } from '../types';

const overdue = (item: Commitment) => item.status !== 'resolved' && (item.followUpAt ?? item.expectedAt ?? '9') <= new Date().toISOString();
const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'no date');

function CommitmentRow({ item, onChanged, onNotice, onProposals }: { item: Commitment; onChanged: () => void; onNotice: (message: string) => void; onProposals: (proposals: Proposal[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try { await work(); onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); }
  };
  const patch = (body: object, done: string) => act(() => api.patch(`/api/agent/commitments/${item.id}`, body), done);
  const days = (count: number) => new Date(Date.now() + count * 86_400_000).toISOString();
  const closed = item.status === 'resolved' || item.status === 'dismissed';
  return (
    <article className={`commit-row ${overdue(item) ? 'overdue' : ''} ${closed ? 'closed' : ''}`}>
      <div className="commit-main">
        <div className="commit-meta">
          <Chip tone={item.direction === 'they_owe' ? 'info' : 'warn'}>{item.direction === 'they_owe' ? 'They owe you' : 'You owe'}</Chip>
          {overdue(item) && !closed && <Chip tone="bad">Overdue</Chip>}
          {item.status === 'snoozed' && <Chip>Snoozed until {when(item.followUpAt)}</Chip>}
          {closed && <Chip tone="good">{item.status === 'resolved' ? 'Closed' : 'Dismissed'}</Chip>}
        </div>
        <h3>{item.otherPerson}</h3>
        <p>{item.action}</p>
        {item.evidence && <blockquote>“{item.evidence}”</blockquote>}
        <small><Clock3 size={12} aria-hidden /> Expected {when(item.expectedAt)} · noticed {ago(item.createdAt)}{item.followUpCount ? ` · ${item.followUpCount} follow-up${item.followUpCount === 1 ? '' : 's'} prepared` : ''}</small>
        <ErrorLine {...(error ?? {})} />
      </div>
      <div className="commit-actions">
        {!closed && <button className="btn primary" disabled={busy} onClick={() => patch({ status: 'resolve' }, 'Marked as done.')}>Mark done</button>}
        {!closed && item.direction === 'they_owe' && item.evidenceSignalId && <button className="btn plain" disabled={busy} onClick={() => act(async () => { const result = await api.post<{ proposals: Proposal[] }>(`/api/agent/commitments/${item.id}/follow-up`); onProposals(result.proposals); }, 'Follow-up draft prepared for your approval.')}>Draft follow-up</button>}
        {!closed && <select aria-label="Snooze" className="btn plain" disabled={busy} value="" onChange={(event) => { if (event.target.value) void patch({ status: 'snooze', until: days(Number(event.target.value)) }, 'Snoozed.'); }}><option value="">Snooze…</option><option value="1">1 day</option><option value="3">3 days</option><option value="7">1 week</option></select>}
        {!closed && <button className="btn plain" disabled={busy} onClick={() => patch({ status: 'dismiss' }, 'Dismissed.')}>Dismiss</button>}
        {closed && <button className="btn plain" disabled={busy} onClick={() => patch({ status: 'reopen' }, 'Reopened.')}>Reopen</button>}
      </div>
    </article>
  );
}

export function WaitingOn({ onChanged, onNotice, onOpenApprovals }: { onChanged: () => void; onNotice: (message: string) => void; onOpenApprovals: () => void }) {
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const list = useLoad(() => api.get<{ commitments: Commitment[] }>(`/api/agent/commitments?status=${showClosed ? 'open,snoozed,resolved,dismissed' : 'open,snoozed'}`), [showClosed]);
  const items = list.data?.commitments ?? [];
  const refresh = () => { void list.reload(); onChanged(); };
  const theyOwe = items.filter((item) => item.direction === 'they_owe');
  const iOwe = items.filter((item) => item.direction === 'i_owe');
  const falling = items.filter((item) => overdue(item) && item.status !== 'resolved' && item.status !== 'dismissed');

  return (
    <section aria-labelledby="waiting-heading">
      <PageHead eyebrow="WAITING ON" title="Nothing falls through." actions={<><label className="check-inline"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} /> Show closed</label><button className="btn primary" onClick={() => setAdding(true)}><Plus size={15} aria-hidden /> Track something</button></>}>
        Orbit watches your mail for promises and requests, suggests when to follow up, and asks before closing anything that looks finished.
      </PageHead>
      {falling.length > 0 && <div className="notice warn" role="status"><div><strong>{falling.length} item{falling.length === 1 ? '' : 's'} may be falling through</strong><span>{falling.slice(0, 3).map((item) => `${item.otherPerson}: ${item.action}`).join(' · ')}</span></div></div>}
      {proposals.length > 0 && <div className="stack inline-review"><h2 className="section-title">Review before it happens</h2>{proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} compact onChanged={() => { setProposals([]); onChanged(); }} onNotice={onNotice} />)}<button className="link" onClick={onOpenApprovals}>Open Approval Center</button></div>}
      {list.error && <p className="error-line">{list.error}</p>}
      <h2 className="section-title" id="waiting-heading">Waiting on others <b>{theyOwe.length}</b></h2>
      <div className="stack">{theyOwe.map((item) => <CommitmentRow key={item.id} item={item} onChanged={refresh} onNotice={onNotice} onProposals={setProposals} />)}{!theyOwe.length && !list.loading && <Empty title="Nobody owes you anything right now.">When someone writes “I’ll send that by Friday”, it shows up here.</Empty>}</div>
      <h2 className="section-title">You owe <b>{iOwe.length}</b></h2>
      <div className="stack">{iOwe.map((item) => <CommitmentRow key={item.id} item={item} onChanged={refresh} onNotice={onNotice} onProposals={setProposals} />)}{!iOwe.length && !list.loading && <Empty title="You are all caught up.">Requests addressed to you and promises you made appear here.</Empty>}</div>
      {adding && <AddCommitment onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); onNotice('Now tracking it.'); }} />}
    </section>
  );
}

function AddCommitment({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [direction, setDirection] = useState<'they_owe' | 'i_owe'>('they_owe');
  const [person, setPerson] = useState('');
  const [email, setEmail] = useState('');
  const [action, setAction] = useState('');
  const [expected, setExpected] = useState('');
  const [error, setError] = useState<{ message: string; action?: string }>();
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    try { await api.post('/api/agent/commitments', { direction, otherPerson: person, otherEmail: email || undefined, action, expectedAt: fromLocalInput(expected) }); onSaved(); } catch (failure) { setError(describeError(failure)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal form-modal" onSubmit={save} aria-label="Track a commitment">
        <div className="modal-head"><div><span>WAITING ON</span><h3>Track a commitment</h3></div><button type="button" onClick={onClose} aria-label="Close">×</button></div>
        <div className="seg-row" role="radiogroup" aria-label="Direction">{(['they_owe', 'i_owe'] as const).map((value) => <button type="button" role="radio" aria-checked={direction === value} key={value} className={direction === value ? 'active' : ''} onClick={() => setDirection(value)}>{value === 'they_owe' ? 'They owe me' : 'I owe them'}</button>)}</div>
        <label className="field"><span>Who</span><input value={person} onChange={(event) => setPerson(event.target.value)} required maxLength={120} placeholder="Maya Chen" /></label>
        <label className="field"><span>Email (optional)</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="maya@example.com" /></label>
        <label className="field"><span>What</span><input value={action} onChange={(event) => setAction(event.target.value)} required maxLength={240} placeholder="Send the revised contract" /></label>
        <label className="field"><span>Expected by (optional)</span><input type="datetime-local" value={expected} onChange={(event) => setExpected(event.target.value)} /></label>
        <ErrorLine {...(error ?? {})} />
        <button className="btn primary wide-btn" type="submit">Start tracking</button>
      </form>
    </div>
  );
}
