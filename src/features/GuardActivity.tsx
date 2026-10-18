import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { GuardEventInfo } from '../types';
import { Chip, Empty, ago } from './ui';

const FILTERS = [{ id: '', label: 'Everything' }, { id: 'deny', label: 'Refused' }, { id: 'ask', label: 'Asked you' }, { id: 'defer', label: 'Left to the agent' }, { id: 'allow', label: 'Silent' }] as const;

function chip(event: GuardEventInfo) {
  if (event.decidedBy === 'budget') return <Chip tone="bad">Budget stop</Chip>;
  if (event.decidedBy === 'owner') return <Chip tone={event.verdict === 'allow' ? 'good' : 'bad'}>{event.verdict === 'allow' ? 'You approved' : 'You denied'}</Chip>;
  if (event.decidedBy === 'timeout') return <Chip tone="warn">{event.verdict === 'deny' ? 'No answer · refused' : 'No answer · handed back'}</Chip>;
  const tone = event.verdict === 'allow' ? 'good' : event.verdict === 'deny' ? 'bad' : 'neutral';
  return <Chip tone={tone}>{event.verdict === 'allow' ? (event.decidedBy === 'rule' ? 'Your rule' : 'Silent') : event.verdict === 'defer' ? 'Left to agent' : 'Refused'}</Chip>;
}

/** The flight recorder: every call an agent made, what Orbit did about it, and why. */
export function GuardActivity({ refreshKey }: { refreshKey: number }) {
  const [filter, setFilter] = useState('');
  const list = useLoad(() => api.get<{ events: GuardEventInfo[] }>(`/api/guard/events?limit=80${filter ? `&verdict=${filter}` : ''}`), [filter, refreshKey]);
  const items = list.data?.events ?? [];
  return (
    <div className="panel pad">
      <div className="panel-head flush"><div><h3>What your agents did</h3><p>Every tool call, with what Orbit decided and why. Secrets are redacted and file contents are never stored.</p></div></div>
      <div className="seg-row wrap" role="tablist" aria-label="Filter activity">{FILTERS.map((item) => <button type="button" role="tab" aria-selected={filter === item.id} key={item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      <ul className="guard-feed">
        {items.map((event) => (
          <li key={event.id}>
            <div className="guard-feed-top">{chip(event)}<span className="guard-tool">{event.tool}</span>{event.project && <span className="guard-project">{event.project}</span>}<time dateTime={event.createdAt}>{ago(event.createdAt)}</time></div>
            <code className="guard-summary">{event.summary}</code>
            {event.reasons.length > 0 && event.verdict !== 'allow' && <small>{event.reasons.join(' · ')}</small>}
            {event.waitedMs >= 1000 && <small>Waited {Math.round(event.waitedMs / 1000)}s for your answer</small>}
          </li>
        ))}
      </ul>
      {!items.length && !list.loading && <Empty title="Nothing yet.">Once a connected agent makes a call, it appears here.</Empty>}
    </div>
  );
}
