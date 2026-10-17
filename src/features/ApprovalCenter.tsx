import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useLoad, usePoll } from '../hooks';
import type { AgentState, Approvals } from '../types';
import { ProposalCard } from './ProposalCard';
import { Empty, Notice, PageHead } from './ui';

export function ApprovalCenter({ agent, onChanged, onNotice, onOpenSignal, onOpenSettings }: { agent: AgentState | null; onChanged: () => void; onNotice: (message: string) => void; onOpenSignal: (id: string) => void; onOpenSettings: () => void }) {
  const approvals = useLoad(() => api.get<Approvals>('/api/agent/approvals'));
  const refresh = async () => { await approvals.reload(); onChanged(); };
  const data = approvals.data;
  const working = !!data && [...data.recent].some((item) => ['approved', 'executing'].includes(item.status));
  usePoll(approvals.reload, 4000, !!data && (data.pending.length > 0 || working));

  return (
    <section aria-labelledby="approvals-heading">
      <PageHead eyebrow="APPROVAL CENTER" title="Decide what Orbit does next.">
        Orbit prepares work, but nothing that changes something outside Orbit happens until you approve it. Each card shows what will change, why Orbit suggests it, and what leaves your installation.
      </PageHead>
      {agent?.settings.paused && <Notice tone="warn" title="The agent is paused" action={<button className="btn primary" onClick={onOpenSettings}>Open controls</button>}>New suggestions and approved actions are held until you resume.</Notice>}
      {approvals.error && <Notice tone="bad" title="Could not load approvals">{approvals.error}</Notice>}

      <div className="stack">
        <h2 className="section-title" id="approvals-heading">Waiting for you <b>{data?.pending.length ?? 0}</b></h2>
        {data && data.pending.length === 0 && <Empty title="You are caught up."><ShieldCheck size={16} aria-hidden /> Nothing needs a decision. New suggestions appear here after a sync, an automation, or Ask Orbit.</Empty>}
        {data?.pending.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onChanged={refresh} onNotice={onNotice} onOpenSignal={onOpenSignal} />)}

        {(data?.failed.length ?? 0) > 0 && <><h2 className="section-title">Needs attention <b>{data!.failed.length}</b></h2>{data!.failed.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onChanged={refresh} onNotice={onNotice} onOpenSignal={onOpenSignal} />)}</>}
        {(data?.blocked.length ?? 0) > 0 && <><h2 className="section-title">Blocked by policy <b>{data!.blocked.length}</b></h2>{data!.blocked.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onChanged={refresh} onNotice={onNotice} onOpenSignal={onOpenSignal} />)}</>}
        {(data?.recent.length ?? 0) > 0 && <><h2 className="section-title">Recently decided</h2>{data!.recent.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onChanged={refresh} onNotice={onNotice} onOpenSignal={onOpenSignal} />)}</>}
      </div>
    </section>
  );
}
