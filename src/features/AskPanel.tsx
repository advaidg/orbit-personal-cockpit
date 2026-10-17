import { useState } from 'react';
import { ChevronRight, Sparkles, X } from 'lucide-react';
import { api, describeError } from '../api';
import type { Proposal } from '../types';
import { ProposalCard } from './ProposalCard';

const EXAMPLES = ['Who am I waiting on?', 'Prepare replies for everything urgent', 'Move all travel tasks into next week', 'Create reminders for bills due this month', 'Draft a response to Maya but don’t send it'];

/** Ask Orbit: answers questions and turns requests into previewed, approval-gated actions. */
export function AskPanel({ onClose, onChanged, onNotice, onOpenRun }: { onClose: () => void; onChanged: () => void; onNotice: (message: string) => void; onOpenRun: (runId: string) => void }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [runId, setRunId] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const ask = async (event?: React.FormEvent, text = question) => {
    event?.preventDefault();
    setAsking(true); setError(undefined); setAnswer(''); setProposals([]);
    try { const result = await api.post<{ answer: string; runId: string; proposals: Proposal[] }>('/api/ask', { question: text }); setAnswer(result.answer); setProposals(result.proposals); setRunId(result.runId); onChanged(); } catch (failure) { setError(describeError(failure)); } finally { setAsking(false); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal ask-modal wide" onSubmit={ask} aria-label="Ask Orbit">
        <div className="modal-head"><div><span>ASK YOUR ORBIT</span><h3>Ask, or tell Orbit what to prepare</h3></div><button type="button" onClick={onClose} aria-label="Close"><X size={20} /></button></div>
        <p className="modal-intro">Orbit uses what is already stored — not a new mailbox fetch. Anything that would change something becomes a preview you approve; the model never calls Gmail or Calendar directly.</p>
        <input autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={600} placeholder="Prepare replies for everything urgent" required aria-label="Your question or request" />
        {!answer && !asking && <div className="example-row">{EXAMPLES.map((example) => <button type="button" key={example} className="chipbtn btn" onClick={() => { setQuestion(example); void ask(undefined, example); }}>{example}</button>)}</div>}
        {answer && <div className="ask-answer"><Sparkles size={17} aria-hidden /><p style={{ whiteSpace: 'pre-wrap' }}>{answer}</p></div>}
        {error && <div className="ask-error" role="alert">{error.message}{error.action ? ` ${error.action}` : ''}</div>}
        {proposals.length > 0 && <div className="stack ask-proposals"><h4 className="section-title">Review before it happens</h4>{proposals.map((proposal) => <ProposalCard key={proposal.id} compact proposal={proposal} onChanged={onChanged} onNotice={onNotice} />)}{runId && <button type="button" className="link" onClick={() => onOpenRun(runId)}>See this run</button>}</div>}
        <button className="primary" disabled={asking}>{asking ? 'Thinking…' : 'Ask Orbit'} <ChevronRight size={16} /></button>
      </form>
    </div>
  );
}
