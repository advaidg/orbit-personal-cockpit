import { useState } from 'react';
import { Puzzle, ShieldAlert } from 'lucide-react';
import { api, describeError } from '../api';
import { useLoad } from '../hooks';
import type { Proposal, SkillInfo } from '../types';
import { Chip, ConfirmButton, ErrorLine, Notice } from './ui';
import { ProposalCard } from './ProposalCard';

function SkillCard({ skill, onChanged, onProposals, onNotice }: { skill: SkillInfo; onChanged: () => void; onProposals: (proposals: Proposal[]) => void; onNotice: (message: string) => void }) {
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const act = async (work: () => Promise<unknown>, done?: string) => { setError(undefined); try { await work(); if (done) onNotice(done); onChanged(); } catch (failure) { setError(describeError(failure)); } };
  const tools = skill.manifest.mcp ? skill.discoveredTools ?? [] : skill.manifest.tools;
  return (
    <article className="skill">
      <header><div><h3><Puzzle size={16} aria-hidden /> {skill.manifest.name} <small>v{skill.manifest.version}</small></h3><p>{skill.manifest.description}</p></div><Chip tone={skill.status === 'enabled' ? 'good' : 'neutral'}>{skill.status}</Chip></header>
      <div className="memory-chips">{skill.verified ? <Chip tone="good">Checksum verified</Chip> : <Chip tone="warn">No verified checksum</Chip>}{skill.manifest.mcp && <Chip tone="info">MCP server</Chip>}<Chip>Talks to {skill.allowedDomains.join(', ') || 'no domains'}</Chip></div>
      <dl className="facts-row"><div><dt>Can read</dt><dd>{skill.manifest.permissions.read.join('; ') || '—'}</dd></div><div><dt>Can change</dt><dd>{skill.manifest.permissions.write.join('; ') || '—'}</dd></div><div><dt>Tools</dt><dd>{tools.map((tool) => `${tool.name} (${'effect' in tool ? tool.effect : ''})`).join(', ') || 'none yet'}</dd></div></dl>
      {skill.manifest.mcp && skill.discoveredTools?.map((tool) => <label className="check-inline" key={tool.name}><input type="checkbox" checked={tool.effect === 'read'} onChange={(event) => act(() => api.patch(`/api/skills/${skill.skillId}/tools/${tool.name}`, { effect: event.target.checked ? 'read' : 'write' }))} /> Treat <b>{tool.name}</b> as read-only (the server’s own claim is ignored)</label>)}
      {skill.manifest.env.length > 0 && <div className="secret-grid">{skill.manifest.env.map((entry) => <label className="field" key={entry.name}><span>{entry.name}{skill.secretsSet.includes(entry.name) ? ' ✓ set' : entry.required ? ' (required)' : ''}</span><input type="password" autoComplete="off" placeholder={skill.secretsSet.includes(entry.name) ? 'Leave blank to keep' : entry.description} value={secrets[entry.name] ?? ''} onChange={(event) => setSecrets({ ...secrets, [entry.name]: event.target.value })} /></label>)}<button className="btn plain" disabled={!Object.values(secrets).some(Boolean)} onClick={() => act(async () => { await api.put(`/api/skills/${skill.skillId}/secrets`, { secrets: Object.fromEntries(Object.entries(secrets).filter(([, value]) => value)) }); setSecrets({}); }, 'Stored encrypted. Orbit never shows secrets again.')}>Save secrets</button></div>}
      {!skill.verified && skill.status !== 'enabled' && <label className="check-inline warn"><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} /> I trust the source of this unverified package.</label>}
      <ErrorLine {...(error ?? {})} />
      <footer>
        {skill.manifest.mcp && <button className="btn plain" onClick={() => act(() => api.post(`/api/skills/${skill.skillId}/discover`), 'Tools discovered. Review them, then enable.')}>Discover tools</button>}
        {skill.status !== 'enabled' && <button className="btn primary" onClick={() => act(async () => { const result = await api.post<{ proposals: Proposal[] }>(`/api/skills/${skill.skillId}/enable`, { acknowledgeUnverified: ack }); onProposals(result.proposals); })}>Review &amp; enable</button>}
        {skill.status === 'enabled' && <button className="btn plain" onClick={() => act(() => api.post(`/api/skills/${skill.skillId}/disable`), 'Disabled.')}>Disable</button>}
        <ConfirmButton label="Remove & delete credentials" confirmLabel="Delete skill" onConfirm={() => act(() => api.del(`/api/skills/${skill.skillId}`), 'Removed, and its credentials were deleted.')} />
      </footer>
    </article>
  );
}

export function Skills({ onNotice, onChanged }: { onNotice: (message: string) => void; onChanged: () => void }) {
  const data = useLoad(() => api.get<{ enabled: boolean; mcpEnabled: boolean; skills: SkillInfo[] }>('/api/skills'));
  const [manifest, setManifest] = useState('');
  const [sha, setSha] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<{ message: string; action?: string }>();
  const install = async (event: React.FormEvent) => {
    event.preventDefault(); setError(undefined);
    try { const parsed = JSON.parse(manifest); const result = await api.post<{ proposals: Proposal[]; rejected: Array<{ error: string }> }>('/api/skills/install', { manifest: parsed, sha256: sha.trim() || undefined }); if (!result.proposals.length) throw new Error(result.rejected[0]?.error ?? 'The manifest was not accepted.'); setProposals(result.proposals); onChanged(); } catch (failure) { setError(failure instanceof SyntaxError ? { message: 'That is not valid JSON.' } : describeError(failure)); }
  };
  const d = data.data;
  if (d && !d.enabled && !d.mcpEnabled) return <div className="panel pad"><h3>Skills &amp; MCP</h3><Notice tone="info" title="Disabled on this installation">Skills extend Orbit with new tools and are off by default. The installation owner can enable them with SKILLS_ENABLED=true (and MCP_ENABLED=true for MCP servers). Every skill still needs your approval, a permission review, and a domain allowlist.</Notice></div>;
  return (
    <div className="panel pad skills">
      <div className="panel-head flush"><div><h3>Skills &amp; MCP</h3><p>Disabled by default. A skill can only contact the domains you approve, never runs code on this server, and every call shows what leaves your installation first.</p></div></div>
      <ErrorLine message={data.error} />
      {proposals.length > 0 && <div className="stack inline-review"><h4 className="section-title">Review the permissions</h4>{proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onChanged={() => { setProposals([]); void data.reload(); onChanged(); }} onNotice={onNotice} />)}</div>}
      <div className="stack">{(d?.skills ?? []).map((skill) => <SkillCard key={skill.id} skill={skill} onChanged={() => void data.reload()} onProposals={setProposals} onNotice={onNotice} />)}</div>
      <form className="skill-install" onSubmit={install}>
        <h4><ShieldAlert size={15} aria-hidden /> Install from a manifest</h4>
        <label className="field"><span>Skill manifest (JSON)</span><textarea rows={6} value={manifest} onChange={(event) => setManifest(event.target.value)} required placeholder='{"id":"weather-lookup","name":"Weather lookup", …}' /></label>
        <label className="field"><span>Publisher’s SHA-256 (recommended)</span><input value={sha} onChange={(event) => setSha(event.target.value)} placeholder="64 hex characters" /></label>
        <ErrorLine {...(error ?? {})} />
        <button className="btn primary" type="submit">Review install</button>
      </form>
    </div>
  );
}
