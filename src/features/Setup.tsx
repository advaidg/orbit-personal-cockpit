import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { api, describeError } from '../api';
import { useLoad } from '../hooks';
import type { SetupStatus } from '../types';
import { Chip, ErrorLine, Notice, Toggle } from './ui';
import { SetupAi } from './SetupAi';
import { SetupEmail } from './SetupEmail';
import { SetupTelegram } from './SetupTelegram';

function Sharing({ status, onChanged, onNotice }: { status: SetupStatus['federation']; onChanged: () => void; onNotice: (message: string) => void }) {
  const [error, setError] = useState<{ message: string; action?: string }>();
  const change = async (enabled: boolean) => {
    setError(undefined);
    try { await api.put('/api/setup/federation', { enabled }); onNotice(enabled ? 'Orbit-to-Orbit sharing is on.' : 'Orbit-to-Orbit sharing is off.'); onChanged(); } catch (failure) { setError(describeError(failure)); }
  };
  return (
    <div className="setup-body">
      <div className="setup-head"><div><h4><Users size={15} aria-hidden /> Share pacts with friends’ Orbits</h4><p>Friends who run their own Orbit can exchange pacts directly: signed messages, no accounts, and both of you must approve each other first.</p></div><Toggle checked={status.enabled} disabled={!status.enabled && !status.canEnable} label="Orbit-to-Orbit sharing" onChange={change} /></div>
      {status.enabled && <p className="hint">Your address is <code>{status.address}</code>. Add friends and compare fingerprints in <a href="#/pacts">Pacts</a>.</p>}
      {!status.enabled && status.blocker && <p className="hint">{status.blocker}</p>}
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}

/** Everything that used to need environment variables and a redeploy, in one place. */
export function Setup({ onChanged, onNotice }: { onChanged: () => void; onNotice: (message: string) => void }) {
  const status = useLoad(() => api.get<SetupStatus>('/api/setup'));
  // Returning from a provider's sign-in page: say what happened, then tidy the address.
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const failed = query.get('setup_error');
    const connected = query.get('connected');
    if (!failed && !connected) return;
    onNotice(failed ?? `${connected === 'openrouter' ? 'OpenRouter' : 'Provider'} connected.`);
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
    void status.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const refresh = () => { void status.reload(); onChanged(); };
  const data = status.data;
  const ready = data ? [data.telegram.linked, data.email.configured, data.ai.active !== 'rules', data.federation.enabled].filter(Boolean).length : 0;
  return (
    <div className="panel pad setup-panel">
      <div className="panel-head flush"><div><h3>Set up Orbit</h3><p>Add the extras here, in your browser. Changes apply immediately — no redeploy, no environment variables. Everything is optional.</p></div>{data && <Chip tone={ready ? 'good' : 'neutral'}>{ready} of 4 on</Chip>}</div>
      {status.error && <Notice tone="info" title="Setup is not available here">{status.error}</Notice>}
      {data && !data.persistent && <Notice tone="warn" title="Nothing here will survive a restart">This installation has no database connected, so saved settings disappear when it restarts. Add a PostgreSQL database to keep them.</Notice>}
      {data && (
        <div className="setup-stack">
          <SetupTelegram status={data.telegram} onChanged={refresh} onNotice={onNotice} />
          <SetupEmail status={data.email} onChanged={refresh} onNotice={onNotice} />
          <SetupAi status={data.ai} onChanged={refresh} onNotice={onNotice} />
          <Sharing status={data.federation} onChanged={refresh} onNotice={onNotice} />
        </div>
      )}
      <p className="hint">Sign-in credentials (Google client ID and secret), your domain, the two security secrets and the database are deployment settings: they are needed before anyone can sign in, so they stay in your host’s variables.</p>
    </div>
  );
}
