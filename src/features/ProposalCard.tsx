import { useState } from 'react';
import { Check, FileText, Lock, ShieldCheck, Sparkles, Undo2, X } from 'lucide-react';
import { api, describeError } from '../api';
import { fromLocalInput, toLocalInput } from '../hooks';
import type { Proposal, ToolRisk } from '../types';
import { Chip, ErrorLine, ago } from './ui';

const RISK_LABEL: Record<ToolRisk, string> = { read: 'Read', local: 'Orbit only', notify: 'Notification', draft: 'Gmail draft', calendar_write: 'Calendar', send: 'Send', delete: 'Delete', financial: 'Financial', shell: 'Command', skill_admin: 'Skill install', skill_read: 'Skill', skill_write: 'Skill' };
const RISK_TONE: Record<ToolRisk, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = { read: 'neutral', local: 'good', notify: 'info', draft: 'warn', calendar_write: 'warn', send: 'bad', delete: 'bad', financial: 'bad', shell: 'bad', skill_admin: 'bad', skill_read: 'info', skill_write: 'warn' };

const LONG = new Set(['body', 'description', 'note']);

function FieldEditor({ name, value, onChange }: { name: string; value: unknown; onChange: (value: unknown) => void }) {
  const label = name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  if (name === 'priority') return <label><span>{label}</span><select value={String(value ?? 'soon')} onChange={(event) => onChange(event.target.value)}>{['now', 'soon', 'later'].map((option) => <option key={option}>{option}</option>)}</select></label>;
  if (/At$|until$/.test(name)) return <label><span>{label}</span><input type="datetime-local" value={toLocalInput(value)} onChange={(event) => onChange(fromLocalInput(event.target.value))} /></label>;
  if (LONG.has(name)) return <label className="wide"><span>{label}</span><textarea rows={Math.min(12, Math.max(4, String(value ?? '').split('\n').length + 1))} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} /></label>;
  return <label><span>{label}</span><input value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} /></label>;
}

export interface ProposalCardProps {
  proposal: Proposal;
  compact?: boolean;
  onChanged: () => void | Promise<void>;
  onNotice?: (message: string) => void;
  onOpenSignal?: (signalId: string) => void;
}

/** One proposed action: what it will do, why, what leaves the installation, and the controls to decide. */
export function ProposalCard({ proposal, compact, onChanged, onNotice, onOpenSignal }: ProposalCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(proposal.input);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<{ message: string; action?: string }>();
  const editable = proposal.preview.editable ?? [];
  const edited = editing && JSON.stringify(draft) !== JSON.stringify(proposal.input);

  const run = async (label: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    setError(undefined);
    try {
      await work();
      if (done) onNotice?.(done);
      await onChanged();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy('');
    }
  };

  const approve = () => run('approve', () => api.post(`/api/agent/proposals/${proposal.id}/approve`, { editedInput: edited ? draft : undefined, alwaysAllow }), 'Approved. Orbit is carrying it out.');
  const reject = () => run('reject', () => api.post(`/api/agent/proposals/${proposal.id}/reject`, {}), 'Rejected. Orbit will not suggest this exact action again.');
  const retry = () => run('retry', () => api.post(`/api/agent/proposals/${proposal.id}/retry`), 'Retry queued.');
  const undo = () => run('undo', () => api.post(`/api/agent/proposals/${proposal.id}/undo`), 'Undone.');
  const feedback = (kind: 'helpful' | 'not_helpful' | 'remember' | 'never') => run(kind, async () => {
    try {
      await api.post(`/api/agent/proposals/${proposal.id}/feedback`, { kind });
    } catch (failure) {
      if (kind === 'never' && (failure as { code?: string }).code === 'scope_required' && confirm(`${describeError(failure).message}\n\nBlock this whole action type?`)) await api.post(`/api/agent/proposals/${proposal.id}/feedback`, { kind, scope: 'tool' });
      else throw failure;
    }
  }, kind === 'helpful' || kind === 'not_helpful' ? 'Thanks. Noted.' : kind === 'remember' ? 'Saved to Memory. You can edit it there.' : 'Saved to Memory as a rule. You can remove it there.');

  const pending = proposal.status === 'pending';
  const decided = ['executed', 'rejected', 'canceled'].includes(proposal.status);
  const leaves = proposal.preview.dataLeaving;

  return (
    <article className={`proposal ${proposal.status}${compact ? ' compact' : ''}`} aria-label={proposal.preview.title}>
      <header>
        <div className="proposal-title">
          <Chip tone={RISK_TONE[proposal.risk]}>{RISK_LABEL[proposal.risk]}</Chip>
          <h3>{proposal.preview.title}</h3>
        </div>
        <time dateTime={proposal.createdAt}>{ago(proposal.createdAt)}</time>
      </header>

      <div className="proposal-why"><Sparkles size={14} aria-hidden /><span><b>Why:</b> {proposal.reason}{proposal.sourceSignalId && onOpenSignal ? <> · <button type="button" className="link" onClick={() => onOpenSignal(proposal.sourceSignalId!)}>View original</button></> : null}</span></div>

      {proposal.preview.description && <pre className="proposal-preview"><FileText size={13} aria-hidden />{proposal.preview.description}</pre>}

      <dl className="proposal-facts">
        <div className={leaves.length ? 'leaves' : 'stays'}><dt>{leaves.length ? 'Data that leaves Orbit' : 'Data that leaves Orbit'}</dt><dd>{leaves.length ? <ul>{leaves.map((line) => <li key={line}>{line}</li>)}</ul> : 'Nothing. This stays inside your installation.'}</dd></div>
        <div><dt>Services it will modify</dt><dd>{proposal.preview.services.length ? proposal.preview.services.join(', ') : 'None. Orbit only.'}</dd></div>
      </dl>

      {editing && editable.length > 0 && <div className="proposal-editor">{editable.map((name) => <FieldEditor key={name} name={name} value={draft[name]} onChange={(value) => setDraft({ ...draft, [name]: value })} />)}</div>}

      {pending && (
        <>
          <p className="policy-line"><Lock size={12} aria-hidden /> {proposal.policyReason}</p>
          {proposal.alwaysAllowable && <label className="always-allow"><input type="checkbox" checked={alwaysAllow} onChange={(event) => setAlwaysAllow(event.target.checked)} /> Always allow this kind of action <small>(creates a rule you can edit or remove in Memory)</small></label>}
          <ErrorLine {...(error ?? {})} />
          <footer>
            <button type="button" className="btn primary" disabled={!!busy} onClick={approve}><Check size={15} aria-hidden /> {busy === 'approve' ? 'Approving…' : edited ? 'Approve with edits' : 'Approve'}</button>
            {editable.length > 0 && <button type="button" className="btn plain" onClick={() => { setEditing(!editing); setDraft(proposal.input); }}>{editing ? 'Discard edits' : 'Edit first'}</button>}
            <button type="button" className="btn plain danger-text" disabled={!!busy} onClick={reject}><X size={15} aria-hidden /> Reject</button>
          </footer>
        </>
      )}

      {proposal.status === 'failed' && (
        <>
          <ErrorLine message={proposal.lastError?.message ?? 'This action failed.'} action={proposal.lastError?.action} />
          <ErrorLine {...(error ?? {})} />
          <footer><button type="button" className="btn primary" disabled={!!busy} onClick={retry}>Retry</button><button type="button" className="btn plain" disabled={!!busy} onClick={reject}>Dismiss</button></footer>
        </>
      )}

      {proposal.status === 'blocked' && <p className="blocked-line"><ShieldCheck size={14} aria-hidden /> {proposal.blockedReason ?? proposal.policyReason}</p>}
      {['approved', 'executing'].includes(proposal.status) && <p className="policy-line" role="status">Running now{proposal.decidedBy === 'policy' ? ' (allowed automatically)' : ''}…</p>}
      {proposal.status === 'previewed' && <p className="policy-line">Dry run: nothing was changed.</p>}

      {decided && (
        <>
          {proposal.execution?.summary && <p className="result-line"><Check size={14} aria-hidden /> {proposal.execution.summary}{proposal.execution.verification?.ok ? <span> Verified: {proposal.execution.verification.detail}</span> : null}</p>}
          {proposal.status === 'rejected' && <p className="policy-line">You rejected this.</p>}
          <ErrorLine {...(error ?? {})} />
          <footer className="feedback" aria-label="Teach Orbit">
            {proposal.execution?.undoable && <button type="button" className="btn plain" disabled={!!busy} onClick={undo}><Undo2 size={14} aria-hidden /> Undo</button>}
            {proposal.status === 'executed' && !compact && (
              <>
                <button type="button" className={`btn chipbtn${proposal.feedback === 'helpful' ? ' on' : ''}`} disabled={!!busy} onClick={() => feedback('helpful')}>Helpful</button>
                <button type="button" className={`btn chipbtn${proposal.feedback === 'not_helpful' ? ' on' : ''}`} disabled={!!busy} onClick={() => feedback('not_helpful')}>Not helpful</button>
                <button type="button" className="btn chipbtn" disabled={!!busy} onClick={() => feedback('remember')}>Remember this preference</button>
                <button type="button" className="btn chipbtn danger-text" disabled={!!busy} onClick={() => feedback('never')}>Never do this again</button>
              </>
            )}
          </footer>
        </>
      )}
    </article>
  );
}
