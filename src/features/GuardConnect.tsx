import { useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { api, describeError } from '../api';
import type { GuardAgent, GuardInstall } from '../types';
import { ErrorLine, Notice } from './ui';

async function copy(text: string, onNotice: (message: string) => void, label: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); onNotice(`${label} copied.`); } catch { onNotice('Copy failed — select the text and copy it yourself.'); }
}

function Snippet({ title, text, onNotice }: { title: string; text: string; onNotice: (message: string) => void }) {
  return (
    <div className="guard-snippet">
      <div><b>{title}</b><button type="button" className="btn plain" onClick={() => void copy(text, onNotice, title)}><Copy size={13} aria-hidden /> Copy</button></div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

/** Registers an agent and walks through the three things Claude Code needs. The token is shown here once, then never again. */
export function GuardConnect({ install, hasAgents, onCreated, onNotice }: { install: GuardInstall; hasAgents: boolean; onCreated: () => void; onNotice: (message: string) => void }) {
  const [open, setOpen] = useState(!hasAgents);
  const [name, setName] = useState('Claude Code');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ agent: GuardAgent; token: string; install: GuardInstall } | null>(null);
  const [error, setError] = useState<{ message: string; action?: string }>();

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try { setCreated(await api.post('/api/guard/agents', { name })); onCreated(); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); }
  };

  if (!open && !created) return <div className="row-gap"><button className="btn plain" onClick={() => setOpen(true)}><Plus size={14} aria-hidden /> Connect another agent</button></div>;
  const shown = created?.install ?? install;
  return (
    <div className="panel pad guard-connect">
      <div className="panel-head flush"><div><h3>{created ? `Connect ${created.agent.name}` : 'Connect an agent'}</h3><p>Three steps, about two minutes. Claude Code asks Orbit before every tool call; Orbit answers instantly for the safe ones.</p></div></div>
      {!created ? (
        <form className="inline-edit" onSubmit={create}>
          <input aria-label="Agent name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required />
          <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create access token'}</button>
        </form>
      ) : (
        <>
          <Notice tone="warn" title="Copy your token now">It is shown once and Orbit keeps only a fingerprint. If you lose it, make a new one.</Notice>
          <ol className="setup-steps guard-steps">
            <li><b>Download the hook</b> to the machine where you run Claude Code.</li>
          </ol>
          <Snippet title="Download" text={shown.download} onNotice={onNotice} />
          <ol className="setup-steps guard-steps" start={2}><li><b>Tell it where Orbit is</b> — add these to your shell profile (<code>~/.zshrc</code> or <code>~/.bashrc</code>).</li></ol>
          <Snippet title="Environment" text={[`export ORBIT_URL=${shown.url}`, `export ORBIT_GUARD_TOKEN=${created.token}`].join('\n')} onNotice={onNotice} />
          <ol className="setup-steps guard-steps" start={3}><li><b>Turn it on</b> — merge this into <code>~/.claude/settings.json</code>.</li></ol>
          <Snippet title="Claude Code settings" text={shown.settings} onNotice={onNotice} />
          <p className="hint">Start a new Claude Code session. Nothing dangerous goes through unseen; if Orbit can’t be reached, Claude Code simply asks you itself, the way it always did. Add <code>export ORBIT_GUARD_FAIL=deny</code> if you would rather it refuse.</p>
          <div className="row-gap"><button className="btn plain" onClick={() => { setCreated(null); setOpen(false); }}>Done</button></div>
        </>
      )}
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}
