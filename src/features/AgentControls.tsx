import { useState } from 'react';
import { Pause, Play, ShieldCheck } from 'lucide-react';
import { api, describeError } from '../api';
import type { AgentState } from '../types';
import { Chip, ErrorLine, Toggle } from './ui';

const ZONES = (() => { try { return (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('timeZone'); } catch { return ['UTC']; } })();

/** Global pause plus the installation ceilings. The UI can only make things stricter than these. */
export function AgentControls({ agent, onChanged }: { agent: AgentState; onChanged: () => void }) {
  const [error, setError] = useState<{ message: string; action?: string }>();
  const patch = async (body: object) => { setError(undefined); try { await api.patch('/api/agent/settings', body); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  const { limits, settings } = agent;
  return (
    <div className="settings-section agent-controls">
      <h4>Agent controls</h4>
      <p>Pause stops schedules, automations and every write action at once. Your connected sources stay connected and reading keeps working.</p>
      <div className="pause-row"><button className={`btn ${settings.paused ? 'primary' : 'plain'}`} onClick={() => patch({ paused: !settings.paused })}>{settings.paused ? <Play size={15} aria-hidden /> : <Pause size={15} aria-hidden />}{settings.paused ? 'Resume agent' : 'Pause agent'}</button><Chip tone={settings.paused ? 'warn' : 'good'}>{settings.paused ? 'Paused' : 'Active'}</Chip></div>
      <label className="toggle-row"><span><strong>Stop all automations</strong><small>Kill switch. Keeps their settings.</small></span><Toggle checked={settings.automationsKilled} label="Stop all automations" onChange={(value) => patch({ automationsKilled: value })} /></label>
      <label className="settings-fields"><label><span>Your time zone</span><select value={settings.timezone} onChange={(event) => patch({ timezone: event.target.value })}>{[...new Set([settings.timezone, ...ZONES])].map((zone) => <option key={zone}>{zone}</option>)}</select></label></label>
      <div className="ceilings"><h5><ShieldCheck size={13} aria-hidden /> Installation limits <small>set by the person who runs this server; the app can only be stricter</small></h5>
        <dl>
          <div><dt>Agent</dt><dd>{limits.enabled ? 'enabled' : 'disabled'}</dd></div>
          <div><dt>Approval default</dt><dd>{limits.approvalDefault === 'required' ? 'ask before every change' : 'ask before external changes'}</dd></div>
          <div><dt>External changes</dt><dd>{limits.externalWritesEnabled ? 'allowed (with approval)' : 'blocked'}</dd></div>
          <div><dt>Sending email</dt><dd>{limits.emailSendingEnabled ? 'allowed by installation, but Orbit has no send tool' : 'off'}</dd></div>
          <div><dt>Skills / MCP</dt><dd>{limits.skillsEnabled ? 'skills on' : 'skills off'} · {limits.mcpEnabled ? 'MCP on' : 'MCP off'}</dd></div>
          <div><dt>Automations</dt><dd>{limits.automationsEnabled ? 'on' : 'off'}</dd></div>
          <div><dt>Memory</dt><dd>{limits.memoryEnabled ? `on · ${limits.memoryRetentionDays} days` : 'off'}</dd></div>
          <div><dt>Limits</dt><dd>{limits.maxSteps} steps per run · {limits.maxRunsPerDay} runs per day · runs kept {limits.runRetentionDays} days</dd></div>
        </dl>
      </div>
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}
