import { useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { api, describeError } from '../api';
import { useLoad } from '../hooks';
import type { MemoryItem } from '../types';
import { Chip, ConfirmButton, Empty, ErrorLine, Notice, PageHead, Toggle, ago } from './ui';

const TYPE_LABEL: Record<string, string> = {
  important_person: 'Important people', organization: 'Organizations', working_hours: 'Preferred working hours', recurring_commitment: 'Recurring commitments',
  communication_preference: 'Communication preferences', inbox_rule: 'Inbox classification rules', privacy_restriction: 'Privacy restrictions', approved_automation: 'Approved automation behavior'
};
const SOURCE: Record<string, string> = { owner: 'You added this', feedback: 'Learned from your feedback', agent: 'Created by an action you approved' };

function MemoryRow({ item, onChanged, onNotice }: { item: MemoryItem; onChanged: () => void; onNotice: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.statement);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const patch = async (body: object, done?: string) => { try { await api.patch(`/api/agent/memories/${item.id}`, body); if (done) onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  const remove = async () => { try { await api.del(`/api/agent/memories/${item.id}`); onNotice('Deleted.'); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  const effect = item.type === 'approved_automation' ? String(item.params.effect ?? 'allow') : '';
  return (
    <li className={`memory-row${item.enabled ? '' : ' off'}`}>
      <div className="memory-main">
        {editing ? <form onSubmit={(event) => { event.preventDefault(); void patch({ statement: text }, 'Saved.'); setEditing(false); }} className="inline-edit"><input aria-label="Edit rule" value={text} onChange={(event) => setText(event.target.value)} maxLength={300} autoFocus /><button className="btn primary" type="submit">Save</button><button className="btn plain" type="button" onClick={() => { setEditing(false); setText(item.statement); }}>Cancel</button></form> : <p>{item.statement}</p>}
        <small>{SOURCE[item.source.kind]}{item.source.label ? ` · “${item.source.label}”` : ''} · {ago(item.createdAt)}</small>
        <div className="memory-chips">{effect && <Chip tone={effect === 'deny' ? 'bad' : 'good'}>{effect === 'deny' ? 'Never' : 'Always allow'}</Chip>}{item.localOnly && <Chip tone="info">Local only</Chip>}</div>
        <ErrorLine {...(error ?? {})} />
      </div>
      <div className="memory-controls">
        <label className="switch-label"><Toggle checked={item.enabled} label={`Rule enabled: ${item.statement}`} onChange={(value) => patch({ enabled: value })} /><span>{item.enabled ? 'On' : 'Off'}</span></label>
        {item.type !== 'approved_automation' && <label className="switch-label" title="Never included in anything sent to an external AI provider"><Toggle checked={item.localOnly} label={`Local only: ${item.statement}`} onChange={(value) => patch({ localOnly: value })} /><span>Local only</span></label>}
        <button className="btn plain" onClick={() => setEditing(true)}>Edit</button>
        <ConfirmButton label={<Trash2 size={14} aria-label="Delete" />} confirmLabel="Delete" onConfirm={remove} />
      </div>
    </li>
  );
}

function AddMemory({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState('important_person');
  const [value, setValue] = useState('');
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(17);
  const [statement, setStatement] = useState('');
  const [error, setError] = useState<{ message: string; action?: string }>();
  const identity = ['important_person', 'inbox_rule', 'privacy_restriction'].includes(type);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const email = value.includes('@') && !value.startsWith('@') ? value.trim().toLowerCase() : '';
    const domain = value.startsWith('@') ? value.slice(1).trim().toLowerCase() : '';
    const params: Record<string, string | number | boolean> = type === 'working_hours' ? { startHour, endHour } : identity ? { ...(email ? { [type === 'important_person' ? 'email' : 'senderEmail']: email } : {}), ...(domain ? { domain } : {}), ...(type === 'inbox_rule' ? { action: 'ignore' } : {}), ...(type === 'privacy_restriction' ? { scope: 'no_external_ai' } : {}) } : {};
    const text = statement.trim() || (type === 'important_person' ? `Messages from ${value} are high priority.` : type === 'inbox_rule' ? `Messages from ${value} are ignored.` : type === 'privacy_restriction' ? `Content from ${value} is never sent to an external AI provider.` : type === 'working_hours' ? `I work ${startHour}:00–${endHour}:00 on weekdays.` : '');
    try { await api.post('/api/agent/memories', { type, statement: text, params, localOnly: type === 'privacy_restriction' }); onSaved(); } catch (failure) { setError(describeError(failure)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal form-modal" onSubmit={save} aria-label="Add a memory">
        <div className="modal-head"><div><span>MEMORY</span><h3>Teach Orbit a rule</h3></div><button type="button" onClick={onClose} aria-label="Close">×</button></div>
        <label className="field"><span>Type</span><select value={type} onChange={(event) => setType(event.target.value)}>{Object.entries(TYPE_LABEL).filter(([key]) => key !== 'approved_automation').map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
        {identity && <label className="field"><span>Email address, or @domain</span><input value={value} onChange={(event) => setValue(event.target.value)} required placeholder="maya@example.com or @acme.com" /></label>}
        {type === 'working_hours' && <div className="field-grid"><label className="field"><span>Start hour</span><input type="number" min={0} max={23} value={startHour} onChange={(event) => setStartHour(Number(event.target.value))} /></label><label className="field"><span>End hour</span><input type="number" min={1} max={24} value={endHour} onChange={(event) => setEndHour(Number(event.target.value))} /></label></div>}
        {!identity && type !== 'working_hours' && <label className="field"><span>The rule, in a sentence</span><input value={statement} onChange={(event) => setStatement(event.target.value)} required maxLength={300} placeholder={type === 'communication_preference' ? 'Keep replies short and friendly.' : 'Acme Corp is our biggest customer.'} /></label>}
        <ErrorLine {...(error ?? {})} />
        <button className="btn primary wide-btn" type="submit">Save rule</button>
      </form>
    </div>
  );
}

export function Memory({ onNotice }: { onNotice: (message: string) => void }) {
  const memories = useLoad(() => api.get<{ memories: MemoryItem[]; enabled: boolean }>('/api/agent/memories'));
  const [adding, setAdding] = useState(false);
  const items = memories.data?.memories ?? [];
  const groups = Object.entries(TYPE_LABEL).map(([type, label]) => ({ type, label, items: items.filter((item) => item.type === type) })).filter((group) => group.items.length);
  return (
    <section aria-labelledby="memory-heading">
      <PageHead eyebrow="MEMORY" title="What Orbit has learned, in plain sight." actions={<><a className="btn plain" href="/api/agent/memories/export"><Download size={15} aria-hidden /> Export</a><button className="btn primary" onClick={() => setAdding(true)}><Plus size={15} aria-hidden /> Add a rule</button></>}>
        Orbit never retrains itself on your data. Everything it remembers is a rule you can read, edit, switch off, export or delete. Memory stays on this installation.
      </PageHead>
      {memories.data && !memories.data.enabled && <Notice tone="warn" title="Memory is disabled on this installation">Set MEMORY_ENABLED=true and redeploy to let Orbit remember preferences.</Notice>}
      {memories.error && <Notice tone="bad" title="Could not load memory">{memories.error}</Notice>}
      <h2 className="sr-only" id="memory-heading">Memory rules</h2>
      {groups.map((group) => <div key={group.type} className="memory-group"><h3 className="section-title">{group.label} <b>{group.items.length}</b></h3><ul className="panel memory-list">{group.items.map((item) => <MemoryRow key={item.id} item={item} onChanged={() => void memories.reload()} onNotice={onNotice} />)}</ul></div>)}
      {!items.length && !memories.loading && <Empty title="No rules yet.">Use “Remember this preference” after an action, “Priority person” on a message, or add a rule yourself.</Empty>}
      <p className="hint">Rules marked <b>Local only</b>, and privacy restrictions, are never included in anything sent to an external AI provider. Memories expire after the installation’s retention window.</p>
      {adding && <AddMemory onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void memories.reload(); onNotice('Saved to Memory.'); }} />}
    </section>
  );
}
