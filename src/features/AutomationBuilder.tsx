import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api, describeError } from '../api';
import type { Automation, AutomationAction, AutomationInput } from '../types';
import { ErrorLine } from './ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CATEGORIES = ['action', 'waiting', 'calendar', 'money', 'travel', 'people'];
const KINDS: Array<[AutomationAction['kind'], string]> = [['create_task', 'Create a task'], ['draft_reply', 'Draft a reply'], ['remind', 'Set a reminder'], ['notify', 'Notify me'], ['track_commitment', 'Track a commitment']];
const defaultAction = (kind: AutomationAction['kind']): AutomationAction => kind === 'create_task' ? { kind, title: 'Follow up: {title}' } : kind === 'draft_reply' ? { kind, template: 'acknowledge' } : kind === 'remind' ? { kind, afterHours: 24 } : kind === 'notify' ? { kind } : { kind, direction: 'they_owe' };

const blank = (): AutomationInput => ({ name: '', enabled: false, trigger: { type: 'new_email' }, filter: {}, actions: [{ kind: 'notify' }], approval: 'always_ask', dryRun: false, maxRunsPerDay: 10, notifyOnFailure: true });

export function AutomationBuilder({ automation, timezone, onClose, onSaved }: { automation: Automation | null; timezone: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<AutomationInput>(automation ? { name: automation.name, recipe: automation.recipe, enabled: automation.enabled, trigger: automation.trigger, filter: automation.filter, scope: automation.scope, actions: automation.actions, approval: automation.approval, dryRun: automation.dryRun, maxRunsPerDay: automation.maxRunsPerDay, notifyOnFailure: automation.notifyOnFailure } : blank());
  const [error, setError] = useState<{ message: string; action?: string }>();
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<AutomationInput>) => setForm({ ...form, ...patch });
  const emailTrigger = form.trigger.type === 'new_email';

  const setTrigger = (type: string) => {
    if (type === 'new_email') set({ trigger: { type: 'new_email' }, scope: undefined });
    else if (type === 'schedule') set({ trigger: { type: 'schedule', kind: 'daily', at: '08:00' }, scope: form.scope ?? 'brief', filter: {} });
    else set({ trigger: { type: 'deadline', withinHours: 72 }, scope: 'bills_due', filter: {} });
  };
  const updateAction = (index: number, action: AutomationAction) => set({ actions: form.actions.map((item, i) => (i === index ? action : item)) });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(undefined);
    try {
      if (automation) await api.patch(`/api/automations/${automation.id}`, form);
      else await api.post('/api/automations', form);
      onSaved();
    } catch (failure) { setError(describeError(failure)); } finally { setSaving(false); }
  };
  const filter = form.filter;
  const setFilter = (patch: Partial<AutomationInput['filter']>) => set({ filter: Object.fromEntries(Object.entries({ ...filter, ...patch }).filter(([, value]) => value !== '' && value !== undefined && value !== false)) });

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal builder" onSubmit={save} aria-label="Automation builder">
        <div className="modal-head"><div><span>AUTOMATION BUILDER</span><h3>{automation ? 'Edit automation' : 'New automation'}</h3></div><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <label className="field"><span>Name</span><input value={form.name} onChange={(event) => set({ name: event.target.value })} required maxLength={100} placeholder="Travel changes" /></label>

        <fieldset><legend>WHEN</legend>
          <div className="field-grid">
            <label className="field"><span>Trigger</span><select value={form.trigger.type} onChange={(event) => setTrigger(event.target.value)}><option value="new_email">A new email arrives</option><option value="schedule">On a schedule</option><option value="deadline">A deadline is approaching</option></select></label>
            {form.trigger.type === 'schedule' && <><label className="field"><span>Repeats</span><select value={form.trigger.kind} onChange={(event) => set({ trigger: { ...form.trigger, kind: event.target.value as 'daily' | 'weekly', weekday: event.target.value === 'weekly' ? 1 : undefined } as never })}><option value="daily">Every day</option><option value="weekly">Every week</option></select></label><label className="field"><span>Time ({timezone})</span><input type="time" value={form.trigger.at.padStart(5, '0')} onChange={(event) => set({ trigger: { ...form.trigger, at: event.target.value } as never })} /></label>{form.trigger.kind === 'weekly' && <label className="field"><span>Day</span><select value={form.trigger.weekday ?? 1} onChange={(event) => set({ trigger: { ...form.trigger, weekday: Number(event.target.value) } as never })}>{DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}</>}
            {form.trigger.type === 'deadline' && <label className="field"><span>Within (hours)</span><input type="number" min={1} max={720} value={form.trigger.withinHours} onChange={(event) => set({ trigger: { type: 'deadline', withinHours: Number(event.target.value) } })} /></label>}
          </div>
        </fieldset>

        <fieldset><legend>IF</legend>
          {emailTrigger ? (
            <div className="field-grid">
              <label className="field"><span>Category</span><select value={filter.category ?? ''} onChange={(event) => setFilter({ category: event.target.value || undefined })}><option value="">Any</option>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
              <label className="field"><span>Priority</span><select value={filter.priority ?? ''} onChange={(event) => setFilter({ priority: (event.target.value || undefined) as never })}><option value="">Any</option><option>now</option><option>soon</option><option>later</option></select></label>
              <label className="field"><span>Sender contains</span><input value={filter.sender ?? ''} onChange={(event) => setFilter({ sender: event.target.value })} placeholder="@acme.com" /></label>
              <label className="field"><span>Mentions (words, or a|b)</span><input value={filter.keyword ?? ''} onChange={(event) => setFilter({ keyword: event.target.value })} placeholder="invoice|receipt" /></label>
              <label className="field"><span>Account name</span><input value={filter.account ?? ''} onChange={(event) => setFilter({ account: event.target.value })} placeholder="Work Gmail" /></label>
              <label className="check-inline"><input type="checkbox" checked={!!filter.importantPeopleOnly} onChange={(event) => setFilter({ importantPeopleOnly: event.target.checked })} /> Only priority people</label>
            </div>
          ) : (
            <label className="field"><span>What should it review?</span><select value={form.scope} onChange={(event) => set({ scope: event.target.value as AutomationInput['scope'] })}><option value="brief">A morning brief</option><option value="unresolved">Unresolved items today</option><option value="bills_due">Bills due soon</option><option value="waiting_on">Waiting-on review</option><option value="no_response">People who have not replied</option></select></label>
          )}
        </fieldset>

        <fieldset><legend>THEN</legend>
          {form.actions.map((action, index) => (
            <div className="action-row" key={index}>
              <select aria-label="Action" value={action.kind} onChange={(event) => updateAction(index, defaultAction(event.target.value as AutomationAction['kind']))}>{KINDS.map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select>
              {action.kind === 'create_task' && <input aria-label="Task title" value={action.title} onChange={(event) => updateAction(index, { ...action, title: event.target.value })} placeholder="Review: {title}" />}
              {action.kind === 'draft_reply' && <select aria-label="Template" value={action.template} onChange={(event) => updateAction(index, { ...action, template: event.target.value as never })}><option value="acknowledge">Acknowledge</option><option value="meeting">Offer to find a time</option><option value="follow_up">Polite follow-up</option></select>}
              {action.kind === 'remind' && <label className="inline-num">after <input type="number" min={1} max={720} aria-label="Hours" value={action.afterHours} onChange={(event) => updateAction(index, { ...action, afterHours: Number(event.target.value) })} /> h</label>}
              {action.kind === 'notify' && <input aria-label="Notification title" value={action.title ?? ''} onChange={(event) => updateAction(index, { ...action, title: event.target.value })} placeholder="Optional title, e.g. From {sender}: {title}" />}
              {action.kind === 'track_commitment' && <select aria-label="Direction" value={action.direction} onChange={(event) => updateAction(index, { ...action, direction: event.target.value as never })}><option value="they_owe">They owe me</option><option value="i_owe">I owe them</option></select>}
              {form.actions.length > 1 && <button type="button" className="btn plain" aria-label="Remove action" onClick={() => set({ actions: form.actions.filter((_, i) => i !== index) })}><X size={14} /></button>}
            </div>
          ))}
          {form.actions.length < 5 && <button type="button" className="btn plain" onClick={() => set({ actions: [...form.actions, defaultAction('notify')] })}><Plus size={14} aria-hidden /> Add a step</button>}
          <p className="hint">Placeholders: {'{title}'}, {'{sender}'}, {'{summary}'}.</p>
        </fieldset>

        <fieldset><legend>APPROVAL</legend>
          {([['always_ask', 'Always ask', 'Every action waits in the Approval Center. The safest choice.'], ['external_only', 'Ask only for external changes', 'Changes inside Orbit happen automatically. Gmail drafts, calendar events and external messages still ask.'], ['auto', 'Automatically allow', 'Orbit-local changes, notifications and Gmail drafts run on their own. Sending, deleting and calendar changes always ask.']] as const).map(([value, label, help]) => <label key={value} className={`radio-card${form.approval === value ? ' on' : ''}`}><input type="radio" name="approval" checked={form.approval === value} onChange={() => set({ approval: value })} /><span><b>{label}</b><small>{help}</small></span></label>)}
        </fieldset>

        <div className="field-grid">
          <label className="field"><span>Max runs per day</span><input type="number" min={1} max={100} value={form.maxRunsPerDay} onChange={(event) => set({ maxRunsPerDay: Number(event.target.value) })} /></label>
          <label className="check-inline"><input type="checkbox" checked={form.dryRun} onChange={(event) => set({ dryRun: event.target.checked })} /> Dry-run mode (preview only)</label>
          <label className="check-inline"><input type="checkbox" checked={form.notifyOnFailure} onChange={(event) => set({ notifyOnFailure: event.target.checked })} /> Notify me if it fails</label>
          <label className="check-inline"><input type="checkbox" checked={form.enabled} onChange={(event) => set({ enabled: event.target.checked })} /> Turn on</label>
        </div>
        <ErrorLine {...(error ?? {})} />
        <button className="btn primary wide-btn" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save automation'}</button>
      </form>
    </div>
  );
}
