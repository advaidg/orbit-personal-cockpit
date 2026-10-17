import { useState } from 'react';
import { Copy, Link2, Plus, RefreshCw, Users } from 'lucide-react';
import { api, describeError } from '../api';
import { fromLocalInput, useLoad } from '../hooks';
import type { FederationInfo, FederationPeer, Pact, SharedPact } from '../types';
import { Chip, ConfirmButton, Empty, ErrorLine, Notice, PageHead, ago } from './ui';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'no date');

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Shown once, right after a link is created or replaced: only a hash of it is stored afterwards. */
export function ShareModal({ shared, person, onClose, onNotice }: { shared: SharedPact; person: string; onClose: () => void; onNotice: (message: string) => void }) {
  const [copied, setCopied] = useState('');
  const copy = async (label: string, text: string) => {
    const ok = await copyText(text);
    setCopied(ok ? label : '');
    onNotice(ok ? `${label} copied.` : 'Copy failed — select the text and copy it yourself.');
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal form-modal" role="dialog" aria-label="Share this pact">
        <div className="modal-head"><div><span>PACT READY</span><h3>Send it to {person}</h3></div><button type="button" onClick={onClose} aria-label="Close">×</button></div>
        <p className="hint">Orbit sends nothing. Copy the message below and send it however you normally talk to {person.split(' ')[0]}. They don’t need an account.</p>
        <label className="field"><span>Message</span><textarea readOnly rows={5} value={shared.message} onFocus={(event) => event.currentTarget.select()} /></label>
        <div className="row-gap"><button className="btn primary" onClick={() => copy('Message', shared.message)}><Copy size={14} aria-hidden /> Copy message</button><button className="btn plain" onClick={() => copy('Link', shared.url)}><Link2 size={14} aria-hidden /> Copy link only</button></div>
        {copied && <p className="hint good" role="status">{copied} copied.</p>}
        <p className="hint">This link is shown once. If you lose it, make a new one — the old one stops working.</p>
      </div>
    </div>
  );
}

function PactRow({ pact, peers, onChanged, onNotice, onShare }: { pact: Pact; peers: FederationPeer[]; onChanged: () => void; onNotice: (message: string) => void; onShare: (shared: SharedPact, person: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(undefined);
    try { await work(); if (done) onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); }
  };
  const act = (action: string, done: string) => run(() => api.post(`/api/pacts/${pact.id}/action`, { action }), done);
  const open = pact.status === 'open';
  const last = pact.events[pact.events.length - 1];
  const theirReply = [...pact.events].reverse().find((event) => event.actor !== 'owner');
  const peer = peers.find((item) => item.id === pact.peerId);
  const ownerDoes = pact.direction === 'i_owe';
  return (
    <article className={`pact-row ${open ? '' : 'closed'}`}>
      <div className="pact-main">
        <div className="commit-meta">
          <Chip tone={ownerDoes ? 'warn' : 'info'}>{ownerDoes ? 'You owe' : 'They owe you'}</Chip>
          {pact.channel === 'federated' ? <Chip>Orbit to Orbit{peer ? ` · ${peer.name}` : ''}</Chip> : pact.link?.active ? <Chip tone="good">Link live</Chip> : <Chip tone="bad">Link off</Chip>}
          {open && pact.confirmed && <Chip tone="good">Confirmed</Chip>}
          {!open && <Chip tone={pact.status === 'done' ? 'good' : 'neutral'}>{pact.status === 'done' ? 'Done' : pact.status === 'declined' ? 'Declined' : 'Withdrawn'}</Chip>}
        </div>
        <h3>{pact.otherPerson}</h3>
        <p>{pact.action}</p>
        <small>Due {when(pact.dueAt)}{pact.requestedDueAt ? ` · they asked for ${when(pact.requestedDueAt)}` : ''} · {last ? `${last.actor === 'owner' ? 'you' : 'they'} ${last.action.replace('_', ' ')} ${ago(last.at)}` : ago(pact.createdAt)}</small>
        {theirReply?.note && <blockquote>“{theirReply.note}”</blockquote>}
        <ErrorLine {...(error ?? {})} />
      </div>
      <div className="commit-actions">
        {open && <button className="btn primary" disabled={busy} onClick={() => act('done', 'Marked as done.')}>Mark done</button>}
        {open && pact.channel === 'link' && <button className="btn plain" disabled={busy} onClick={() => run(async () => onShare(await api.post<SharedPact>(`/api/pacts/${pact.id}/link`), pact.otherPerson), 'New link ready. The old one no longer works.')}><RefreshCw size={13} aria-hidden /> New link</button>}
        {open && pact.channel === 'link' && pact.link?.active && <ConfirmButton tone="plain" label="Turn link off" confirmLabel="Turn off" onConfirm={() => run(() => api.del(`/api/pacts/${pact.id}/link`), 'Link turned off.')} />}
        {open && <button className="btn plain" disabled={busy} onClick={() => act(ownerDoes ? 'decline' : 'cancel', ownerDoes ? 'Marked as declined.' : 'Withdrawn.')}>{ownerDoes ? 'I can’t do it' : 'No longer needed'}</button>}
        <ConfirmButton label="Delete" onConfirm={() => run(() => api.del(`/api/pacts/${pact.id}`), 'Pact deleted.')} />
      </div>
    </article>
  );
}

function NewPact({ peers, onClose, onCreated }: { peers: FederationPeer[]; onClose: () => void; onCreated: (shared: SharedPact | null, person: string) => void }) {
  const trusted = peers.filter((peer) => peer.status === 'trusted');
  const [direction, setDirection] = useState<'they_owe' | 'i_owe'>('they_owe');
  const [person, setPerson] = useState('');
  const [action, setAction] = useState('');
  const [due, setDue] = useState('');
  const [peerId, setPeerId] = useState('');
  const [error, setError] = useState<{ message: string; action?: string }>();
  const [busy, setBusy] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.post<{ pact: Pact } & Partial<SharedPact>>('/api/pacts', { direction, otherPerson: person, action, dueAt: fromLocalInput(due), peerId: peerId || undefined });
      onCreated(result.url && result.token && result.message ? { url: result.url, token: result.token, message: result.message } : null, person);
    } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal form-modal" onSubmit={save} aria-label="New pact">
        <div className="modal-head"><div><span>PACTS</span><h3>Make a pact</h3></div><button type="button" onClick={onClose} aria-label="Close">×</button></div>
        <div className="seg-row" role="radiogroup" aria-label="Who does it">{(['they_owe', 'i_owe'] as const).map((value) => <button type="button" role="radio" aria-checked={direction === value} key={value} className={direction === value ? 'active' : ''} onClick={() => setDirection(value)}>{value === 'they_owe' ? 'They will…' : 'I will…'}</button>)}</div>
        <label className="field"><span>Who</span><input value={person} onChange={(event) => setPerson(event.target.value)} required maxLength={120} placeholder="Maya Chen" /></label>
        <label className="field"><span>What</span><input value={action} onChange={(event) => setAction(event.target.value)} required maxLength={240} placeholder={direction === 'they_owe' ? 'send the revised deck' : 'review their draft'} /></label>
        <label className="field"><span>By when (optional)</span><input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></label>
        {trusted.length > 0 && <label className="field"><span>Deliver</span><select value={peerId} onChange={(event) => setPeerId(event.target.value)}><option value="">With a link I send myself</option>{trusted.map((peer) => <option key={peer.id} value={peer.id}>Straight to {peer.name}’s Orbit</option>)}</select></label>}
        <ErrorLine {...(error ?? {})} />
        <button className="btn primary wide-btn" type="submit" disabled={busy}>{peerId ? 'Send to their Orbit' : 'Create pact and link'}</button>
      </form>
    </div>
  );
}

function Federation({ info, onChanged, onNotice }: { info: FederationInfo; onChanged: () => void; onNotice: (message: string) => void }) {
  const [url, setUrl] = useState('');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ message: string; action?: string }>();
  const run = async (work: () => Promise<unknown>, done: string) => { setError(undefined); try { await work(); onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  if (!info.enabled) return <div className="panel pad"><div className="panel-head flush"><div><h3><Users size={16} aria-hidden /> Orbit to Orbit</h3><p>{info.reason}</p></div><Chip>Off</Chip></div></div>;
  return (
    <div className="panel pad">
      <div className="panel-head flush"><div><h3><Users size={16} aria-hidden /> Orbit to Orbit</h3><p>Friends who run their own Orbit can share pacts directly: signed messages, no accounts, and both of you must approve first.</p></div><Chip tone="good">On</Chip></div>
      <div className="id-card"><span>Your address</span><code>{info.url}</code><span>Your fingerprint — read it to a friend so they know it’s you</span><code>{info.fingerprint}</code></div>
      {info.peers.map((peer) => (
        <div className="peer-row" key={peer.id}>
          <div><strong>{peer.name}</strong><small>{peer.url}</small><code>{peer.fingerprint}</code></div>
          <div className="peer-actions">
            <Chip tone={peer.status === 'trusted' ? 'good' : peer.status === 'blocked' ? 'bad' : 'warn'}>{peer.status === 'trusted' ? 'Trusted' : peer.status === 'blocked' ? 'Blocked' : peer.status === 'pending_in' ? 'Wants to connect' : 'Waiting for you'}</Chip>
            {(peer.status === 'pending_in' || peer.status === 'pending_out') && <form className="inline-edit" onSubmit={(event) => { event.preventDefault(); void run(() => api.post(`/api/federation/peers/${peer.id}/trust`, { fingerprint: typed[peer.id] ?? '' }), `Now trusting ${peer.name}.`); }}><input aria-label={`Fingerprint of ${peer.name}`} value={typed[peer.id] ?? ''} onChange={(event) => setTyped({ ...typed, [peer.id]: event.target.value })} placeholder="Type their fingerprint to trust" /><button className="btn primary" type="submit">Trust</button></form>}
            {peer.status !== 'blocked' && <button className="btn plain" onClick={() => run(() => api.post(`/api/federation/peers/${peer.id}/block`), `${peer.name} blocked.`)}>Block</button>}
            <ConfirmButton label="Remove" onConfirm={() => run(() => api.del(`/api/federation/peers/${peer.id}`), 'Removed.')} />
          </div>
        </div>
      ))}
      {!info.peers.length && <Empty title="No connections yet.">Add a friend’s Orbit address below. They’ll see your request and can approve it.</Empty>}
      <form className="inline-edit" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.post('/api/federation/peers', { url }); setUrl(''); }, 'Request sent. Compare fingerprints, then trust them.'); }}><input aria-label="Their Orbit address" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="their-orbit.up.railway.app" required /><button className="btn plain" type="submit">Add</button></form>
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}

export function Pacts({ onChanged, onNotice }: { onChanged: () => void; onNotice: (message: string) => void }) {
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [shared, setShared] = useState<{ shared: SharedPact; person: string } | null>(null);
  const list = useLoad(() => api.get<{ pacts: Pact[]; enabled: boolean }>(`/api/pacts?status=${showClosed ? 'open,done,declined,canceled' : 'open'}`), [showClosed]);
  const federation = useLoad(() => api.get<FederationInfo>('/api/federation'));
  const refresh = () => { void list.reload(); void federation.reload(); onChanged(); };
  const peers = federation.data?.enabled ? federation.data.peers : [];
  const items = list.data?.pacts ?? [];
  const enabled = list.data?.enabled !== false;
  return (
    <section aria-labelledby="pacts-heading">
      <PageHead eyebrow="PACTS" title="Promises, kept by both of you." actions={<><label className="check-inline"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} /> Show closed</label><button className="btn primary" disabled={!enabled} onClick={() => setCreating(true)}><Plus size={15} aria-hidden /> Make a pact</button></>}>
        <span id="pacts-heading">Turn a promise into a private link. The other person can confirm, finish or reschedule it with one tap — no account — and Orbit tells you. Nothing is ever sent for you.</span>
      </PageHead>
      {!enabled && <Notice tone="warn" title="Pacts are turned off">Set PACTS_ENABLED=true and redeploy to use them.</Notice>}
      {list.error && <p className="error-line">{list.error}</p>}
      <div className="stack">
        {items.map((pact) => <PactRow key={pact.id} pact={pact} peers={peers} onChanged={refresh} onNotice={onNotice} onShare={(value, person) => setShared({ shared: value, person })} />)}
        {!items.length && !list.loading && <Empty title="No open pacts.">Say “I’ll send it Friday” in Waiting On, or make a pact here, and the other person gets a one-tap page to answer.</Empty>}
      </div>
      <h2 className="section-title">Connections between Orbits</h2>
      {federation.data && <Federation info={federation.data} onChanged={refresh} onNotice={onNotice} />}
      {creating && <NewPact peers={peers} onClose={() => setCreating(false)} onCreated={(value, person) => { setCreating(false); refresh(); if (value) setShared({ shared: value, person }); else onNotice('Sent to their Orbit.'); }} />}
      {shared && <ShareModal shared={shared.shared} person={shared.person} onClose={() => setShared(null)} onNotice={onNotice} />}
    </section>
  );
}
