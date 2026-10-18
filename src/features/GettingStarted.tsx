import { useState } from 'react';
import { Check, Circle, X } from 'lucide-react';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { Dashboard, Pact, SetupStatus } from '../types';

const KEY = 'orbit.gettingStarted.dismissed';

function dismissed(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

interface Step { id: string; title: string; hint: string; done: boolean; href: string; cta: string }

/** A short, honest checklist for a fresh install. It disappears on its own once the basics are done. */
export function GettingStarted({ data }: { data: Dashboard }) {
  const [hidden, setHidden] = useState(dismissed);
  const setup = useLoad(() => api.get<SetupStatus>('/api/setup').catch(() => null));
  const pacts = useLoad(() => api.get<{ pacts: Pact[] }>('/api/pacts?status=open,done,declined,canceled').catch(() => null));
  if (hidden || data.mode === 'demo' || setup.loading || pacts.loading) return null;

  const steps: Step[] = [
    { id: 'gmail', title: 'Connect Gmail', hint: 'So Orbit can find promises and deadlines. Read-only by default.', done: data.connections.some((connection) => connection.provider === 'gmail' && connection.status === 'connected'), href: '#/connections', cta: 'Connect' },
    { id: 'password', title: 'Set a dashboard password', hint: 'So you can sign in from new browsers.', done: !!data.system.passwordLoginConfigured, href: '#/connections', cta: 'Open Settings' },
    { id: 'pact', title: 'Make your first pact', hint: 'Turn “I’ll send it Friday” into a link the other person can answer in one tap.', done: (pacts.data?.pacts.length ?? 0) > 0, href: '#/pacts', cta: 'Make a pact' },
    ...(setup.data ? [{ id: 'telegram', title: 'Chat with Orbit from your phone', hint: 'Optional: set up Telegram in two minutes.', done: setup.data.telegram.linked, href: '#/connections', cta: 'Set up Telegram' }] : [])
  ];
  const remaining = steps.filter((step) => !step.done);
  if (!remaining.length) return null;
  const hide = () => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode: it just comes back next visit */ } setHidden(true); };

  return (
    <section className="getting-started" aria-label="Getting started">
      <header><div><span className="eyebrow-tag">GETTING STARTED</span><h2>{steps.length - remaining.length} of {steps.length} done</h2></div><button type="button" className="icon-btn" onClick={hide} aria-label="Hide the getting started list"><X size={16} aria-hidden /></button></header>
      <ul>
        {steps.map((step) => (
          <li key={step.id} className={step.done ? 'done' : ''}>
            {step.done ? <Check size={16} aria-hidden /> : <Circle size={16} aria-hidden />}
            <div><strong>{step.title}</strong>{!step.done && <small>{step.hint}</small>}</div>
            {!step.done && <a className="btn plain" href={step.href}>{step.cta}</a>}
          </li>
        ))}
      </ul>
    </section>
  );
}
