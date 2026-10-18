import { useState } from 'react';
import { api, describeError } from '../api';
import { useLoad } from '../hooks';
import type { GuardRuleInfo, GuardVerdict } from '../types';
import { Chip, ConfirmButton, Empty, ErrorLine, ago } from './ui';

const TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'MultiEdit'];
const tone = (action: string) => (action === 'allow' ? 'good' : action === 'deny' ? 'bad' : 'warn');

/** What Orbit would do with a command, without running anything or writing to the log. */
function TryIt() {
  const [command, setCommand] = useState('git push --force origin main');
  const [result, setResult] = useState<{ verdict: GuardVerdict; reasons: string[]; category: string } | null>(null);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try { setResult(await api.post('/api/guard/try', { tool: 'Bash', command })); } catch (failure) { setError(describeError(failure)); }
  };
  const words: Record<GuardVerdict, string> = { allow: 'passes silently', ask: 'asks you on your phone', deny: 'is refused outright', defer: 'is left to the agent’s own prompt' };
  return (
    <div className="guard-try">
      <h4>What would Orbit do?</h4>
      <form className="inline-edit" onSubmit={run}><input aria-label="A command to try" value={command} onChange={(event) => setCommand(event.target.value)} maxLength={4000} spellCheck={false} /><button className="btn plain" type="submit">Try it</button></form>
      {result && <p role="status" className="guard-try-result"><Chip tone={result.verdict === 'allow' ? 'good' : result.verdict === 'deny' ? 'bad' : result.verdict === 'ask' ? 'warn' : 'neutral'}>{result.verdict}</Chip> This {words[result.verdict]}.{result.reasons.length > 0 && <span> {result.reasons.join('; ')}.</span>}</p>}
      <ErrorLine {...(error ?? {})} />
    </div>
  );
}

export function GuardRules({ onNotice }: { onNotice: (message: string) => void }) {
  const list = useLoad(() => api.get<{ rules: GuardRuleInfo[] }>('/api/guard/rules'));
  const [form, setForm] = useState({ tool: 'Bash', match: 'glob', value: '', project: '', action: 'ask', note: '' });
  const [error, setError] = useState<{ message: string; action?: string }>();
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try { await api.post('/api/guard/rules', { ...form, project: form.project || undefined, note: form.note || undefined }); setForm({ ...form, value: '', note: '' }); onNotice('Rule saved.'); await list.reload(); } catch (failure) { setError(describeError(failure)); }
  };
  const rules = list.data?.rules ?? [];
  return (
    <div className="panel pad">
      <div className="panel-head flush"><div><h3>Your rules</h3><p>Rules run before Orbit’s built-in judgement. <b>Deny</b> beats <b>ask</b> beats <b>allow</b>. Nothing can allow the catastrophic (wiping a disk or home folder), and an allow rule never covers a chained command.</p></div></div>
      <TryIt />
      <form className="guard-rule-form" onSubmit={save}>
        <label className="field"><span>Tool</span><select value={form.tool} onChange={(event) => setForm({ ...form, tool: event.target.value })}>{TOOLS.map((tool) => <option key={tool}>{tool}</option>)}</select></label>
        <label className="field"><span>Match</span><select value={form.match} onChange={(event) => setForm({ ...form, match: event.target.value })}><option value="glob">Pattern (* is a wildcard)</option><option value="exact">Exact text</option></select></label>
        <label className="field wide"><span>{form.tool === 'Bash' ? 'Command' : 'Path'}</span><input value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} required placeholder={form.tool === 'Bash' ? 'npm run build*' : '/path/to/file'} spellCheck={false} /></label>
        <label className="field"><span>Then</span><select value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value })}><option value="allow">Allow silently</option><option value="ask">Ask me</option><option value="deny">Refuse</option></select></label>
        <label className="field wide"><span>Only in this folder (optional)</span><input value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} placeholder="/Users/you/projects/app" spellCheck={false} /></label>
        <label className="field wide"><span>Note (optional)</span><input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} maxLength={200} /></label>
        <button className="btn primary" type="submit">Add rule</button>
      </form>
      <ErrorLine {...(error ?? {})} />
      <div className="guard-rules">
        {rules.map((rule) => (
          <div className="guard-rule" key={rule.id}>
            <Chip tone={tone(rule.action)}>{rule.action}</Chip>
            <div><code>{rule.tool}</code> <code>{rule.value}</code>{rule.project && <small> in {rule.project}</small>}{rule.note && <small> · {rule.note}</small>}<small>{rule.match === 'exact' ? ' · exact' : ' · pattern'} · used {rule.hits}×{rule.lastHitAt ? `, last ${ago(rule.lastHitAt)}` : ''}</small></div>
            <ConfirmButton label="Remove" confirmLabel="Remove" onConfirm={async () => { await api.del(`/api/guard/rules/${rule.id}`); onNotice('Rule removed.'); await list.reload(); }} />
          </div>
        ))}
        {!rules.length && !list.loading && <Empty title="No rules yet.">Approve something on your phone with “Always allow this here” and it shows up here.</Empty>}
      </div>
    </div>
  );
}
