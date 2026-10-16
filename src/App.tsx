import { useEffect, useMemo, useState } from 'react';
import { Activity, Bell, CalendarDays, Check, ChevronRight, CircleDollarSign, Clock3, GitBranch, Inbox, LayoutDashboard, Mail, Menu, MessageSquare, Orbit as OrbitIcon, Plane, Plus, RefreshCw, Search, Settings, Sparkles, UserRound, X, Zap } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { Connection, Dashboard, Priority, Signal, Source, Task } from './types';

const sourceIcons: Record<Source, typeof Mail> = { gmail: Mail, outlook: Inbox, calendar: CalendarDays, github: GitBranch, slack: MessageSquare, manual: UserRound };
const categoryIcons: Record<string, typeof Mail> = { action: Zap, waiting: Clock3, calendar: CalendarDays, money: CircleDollarSign, travel: Plane, people: UserRound, noise: Inbox };

function timeAgo(value?: string) { return value ? formatDistanceToNow(new Date(value), { addSuffix: true }) : 'Never'; }

export function App(){
  const page=location.pathname.replace(/\/$/,'');
  if(page==='/privacy')return <LegalPage type="privacy"/>;
  if(page==='/terms')return <LegalPage type="terms"/>;
  if(page==='/security')return <LegalPage type="security"/>;
  return <DashboardApp/>;
}

function DashboardApp() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState<'all' | Priority>('all');
  const [taskOpen, setTaskOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState('');

  const load = async () => { const response = await fetch('/api/dashboard'); if (!response.ok) throw new Error('Could not load dashboard'); setData(await response.json()); setLoading(false); };
  useEffect(() => { load().catch(() => setLoading(false)); }, []);
  const sync = async () => { setSyncing(true); try { await fetch('/api/sync', { method:'POST' }); await load(); setToast('Everything is up to date'); } catch { setToast('Sync needs attention'); } finally { setSyncing(false); setTimeout(() => setToast(''), 2600); } };
  const toggleTask = async (task: Task) => { await fetch(`/api/tasks/${task.id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status:task.status === 'done' ? 'open' : 'done' }) }); await load(); };
  const visibleSignals = useMemo(() => data?.signals.filter(s => filter === 'all' || s.priority === filter) || [], [data, filter]);

  if (loading) return <div className="loading"><div className="brand-mark"><OrbitIcon size={24}/></div><span>Plotting your orbit…</span></div>;
  if (!data) return <Welcome onDemo={async () => { await fetch('/auth/demo',{method:'POST'}); location.reload(); }} />;

  return <div className="app-shell">
    <aside className={mobileNav ? 'sidebar open' : 'sidebar'}>
      <div className="wordmark"><div className="brand-mark"><OrbitIcon size={20}/></div><span>ORBIT</span><button className="mobile-close" onClick={() => setMobileNav(false)}><X size={20}/></button></div>
      <nav>
        <NavItem icon={LayoutDashboard} label="Today" active />
        <NavItem icon={Inbox} label="Signals" count={data.stats.needsYou} />
        <NavItem icon={Check} label="Tasks" count={data.tasks.filter(t => t.status === 'open').length} />
        <NavItem icon={CalendarDays} label="Timeline" />
        <div className="nav-label">Sources</div>
        {data.connections.filter(c => c.status === 'connected').map(c => <NavItem key={c.id} icon={sourceIcons[c.provider]} label={c.label} dot />)}
        <button className="add-source" onClick={() => setConnectOpen(true)}><Plus size={15}/> Add a source</button>
      </nav>
      <div className="sidebar-bottom">
        <button><Settings size={17}/> Settings</button>
        <div className="profile"><div className="avatar">{data.user.name.split(' ').map(n=>n[0]).slice(0,2).join('')}</div><div><strong>{data.user.name}</strong><span>{data.mode === 'demo' ? 'Demo workspace' : data.user.email}</span></div><ChevronRight size={16}/></div>
      </div>
    </aside>

    <main>
      <header className="topbar">
        <button className="menu-btn" onClick={() => setMobileNav(true)}><Menu size={22}/></button>
        <div className="search"><Search size={17}/><span>Search your orbit</span><kbd>⌘ K</kbd></div>
        <div className="top-actions"><span className="sync-state"><i/>Synced {timeAgo(data.connections.find(c => c.lastSyncedAt)?.lastSyncedAt)}</span><button className="icon-btn"><Bell size={18}/><b/></button><button className="sync-btn" onClick={sync} disabled={syncing}><RefreshCw size={16} className={syncing ? 'spin':''}/><span>{syncing?'Syncing':'Sync now'}</span></button></div>
      </header>

      <div className="content">
        {data.mode === 'demo' && <div className="demo-banner"><span><Sparkles size={15}/> You’re exploring a live demo with sample data.</span><button onClick={() => setConnectOpen(true)}>Connect your world <ChevronRight size={15}/></button></div>}
        <section className="hero-head"><div><p>{data.greeting}, {data.user.name.split(' ')[0]}</p><h1>Here’s what needs you.</h1></div><div className="date-stamp"><span>{new Intl.DateTimeFormat('en-US',{weekday:'long'}).format(new Date())}</span><strong>{new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric'}).format(new Date()).toUpperCase()}</strong></div></section>

        <section className="brief-card">
          <div className="brief-orb"><Sparkles size={22}/></div>
          <div className="brief-copy"><div className="eyebrow">Your orbit brief <span>AI SYNTHESIZED</span></div><h2>{data.brief.headline}</h2><p>{data.brief.narrative}</p>
            <div className="brief-tags">{data.brief.watchouts.map(x=><span key={x} className="watch"><Zap size={12}/>{x}</span>)}{data.brief.wins.slice(0,1).map(x=><span key={x}><Check size={12}/>{x}</span>)}</div>
          </div><button className="ask-button">Ask Orbit <ChevronRight size={16}/></button>
        </section>

        <section className="metrics">
          <Metric label="Needs you" value={data.stats.needsYou} note="Decisions & replies" tone="coral" />
          <Metric label="Waiting on" value={data.stats.waitingOn} note="Others have the ball" tone="yellow" />
          <Metric label="Cleared" value={data.stats.cleared} note="Completed this week" tone="green" />
          <Metric label="Quieted" value={data.stats.noiseFiltered} note="Low-signal updates" tone="blue" />
        </section>

        <div className="dashboard-grid">
          <section className="panel signals-panel">
            <div className="panel-head"><div><h3>Signal radar</h3><p>Important changes across your connected world</p></div><div className="segmented">{(['all','now','soon','later'] as const).map(v=><button key={v} className={filter===v?'active':''} onClick={()=>setFilter(v)}>{v === 'all' ? 'All' : v[0].toUpperCase()+v.slice(1)}</button>)}</div></div>
            <div className="signal-list">{visibleSignals.map(signal => <SignalRow key={signal.id} signal={signal}/>)}</div>
            <button className="view-all">View all signals <ChevronRight size={15}/></button>
          </section>

          <section className="panel focus-panel">
            <div className="panel-head"><div><h3>Focus queue</h3><p>Your next best actions</p></div><button className="round-add" onClick={()=>setTaskOpen(true)}><Plus size={18}/></button></div>
            <div className="task-list">{data.tasks.filter(t=>t.status==='open').slice(0,5).map((task,i)=><TaskRow key={task.id} task={task} index={i} onToggle={()=>toggleTask(task)}/>)}</div>
            <button className="quick-add" onClick={()=>setTaskOpen(true)}><Plus size={16}/> Capture something</button>
          </section>
        </div>

        <section className="source-strip"><div><div className="pulse-icon"><Activity size={18}/></div><div><strong>Your world, connected</strong><span>{data.connections.filter(c=>c.status==='connected').length} sources are feeding your brief</span></div></div><div className="source-icons">{data.connections.map(c=>{const Icon=sourceIcons[c.provider];return <button key={c.id} title={c.label} className={c.status}><Icon size={18}/>{c.status==='connected'&&<i/>}</button>})}<button className="source-plus" onClick={()=>setConnectOpen(true)}><Plus size={18}/></button></div></section>
      </div>
    </main>
    {taskOpen && <TaskModal onClose={()=>setTaskOpen(false)} onSaved={async()=>{setTaskOpen(false);await load();setToast('Added to your focus queue')}}/>}
    {connectOpen && <ConnectModal connections={data.connections} onClose={()=>setConnectOpen(false)}/>} 
    {toast && <div className="toast"><Check size={16}/>{toast}</div>}
  </div>;
}

function NavItem({icon:Icon,label,count,active,dot}:{icon:typeof Mail;label:string;count?:number;active?:boolean;dot?:boolean}) { return <button className={active?'nav-item active':'nav-item'}><Icon size={17}/><span>{label}</span>{count!==undefined&&<b>{count}</b>}{dot&&<i/>}</button> }
function Metric({label,value,note,tone}:{label:string;value:number;note:string;tone:string}) { return <div className={`metric ${tone}`}><div><span>{label}</span><strong>{String(value).padStart(2,'0')}</strong></div><p>{note}</p></div> }
function SignalRow({signal}:{signal:Signal}) { const Icon=categoryIcons[signal.category]||Mail; return <article className="signal-row"><div className={`signal-icon ${signal.category}`}><Icon size={17}/></div><div className="signal-main"><div className="signal-meta"><span className={`priority ${signal.priority}`}>{signal.priority}</span><span>{signal.source}</span><i/> <span>{timeAgo(signal.occurredAt)}</span></div><h4>{signal.title}</h4><p>{signal.summary}</p></div><ChevronRight size={17} className="row-chevron"/></article> }
function TaskRow({task,index,onToggle}:{task:Task;index:number;onToggle:()=>void}) { const Icon=sourceIcons[task.source]; return <article className="task-row"><button className="task-check" onClick={onToggle}><Check size={14}/></button><div><span className={`task-index ${task.priority}`}>{String(index+1).padStart(2,'0')}</span><h4>{task.title}</h4><p><Icon size={12}/>{task.source}{task.dueAt&&<> · due {timeAgo(task.dueAt).replace('in ','')}</>}</p></div></article> }

function TaskModal({onClose,onSaved}:{onClose:()=>void;onSaved:()=>void}) { const [title,setTitle]=useState(''); const [priority,setPriority]=useState<Priority>('soon'); const save=async(e:React.FormEvent)=>{e.preventDefault();await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,priority,source:'manual'})});onSaved()}; return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><form className="modal" onSubmit={save}><div className="modal-head"><div><span>QUICK CAPTURE</span><h3>What needs to happen?</h3></div><button type="button" onClick={onClose}><X size={20}/></button></div><input autoFocus value={title} onChange={e=>setTitle(e.target.value)} placeholder="e.g. Book dentist appointment" required/><label>Priority</label><div className="priority-select">{(['now','soon','later'] as const).map(p=><button type="button" className={priority===p?'active':''} onClick={()=>setPriority(p)} key={p}>{p}</button>)}</div><button className="primary" type="submit">Add to focus queue <ChevronRight size={16}/></button></form></div> }
function ConnectModal({connections,onClose}:{connections:Connection[];onClose:()=>void}) { const options:Connection[]=[{id:'gmail-new',provider:'gmail',label:'Gmail',status:'available'},...connections.filter(c=>c.provider!=='gmail')];return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><div className="modal connect-modal"><div className="modal-head"><div><span>SOURCE LIBRARY</span><h3>Connect your world</h3></div><button onClick={onClose}><X size={20}/></button></div><p className="modal-intro">Orbit reads the signals you choose and turns them into one focused brief. Your credentials stay encrypted.</p><div className="connect-grid">{options.map(c=>{const Icon=sourceIcons[c.provider];return <div className="connect-card" key={c.id}><div className={`connect-logo ${c.provider}`}><Icon size={22}/></div><div><strong>{c.label}</strong><span>{c.provider==='gmail'?'Mail, receipts & follow-ups':c.provider==='calendar'?'Events, conflicts & prep':c.provider==='github'?'Reviews, issues & releases':c.provider==='slack'?'Mentions & decisions':'Mail & calendar'}</span></div>{c.provider==='gmail'?<a href="/auth/google">Connect</a>:<button disabled>{c.status==='available'?'Soon':'Waitlist'}</button>}</div>})}</div></div></div> }
function Welcome({onDemo}:{onDemo:()=>void}) {
  const [config,setConfig]=useState<{ownerConfigured:boolean;gmailConfigured:boolean;databaseConfigured:boolean;demoMode:boolean;ai:{provider:string};privacy:{signalRetentionDays:number}}|null>(null);
  useEffect(()=>{fetch('/api/config').then(r=>r.json()).then(setConfig).catch(()=>null)},[]);
  const setupMissing=new URLSearchParams(location.search).get('setup')==='gmail'||config?.gmailConfigured===false||config?.ownerConfigured===false;
  return <div className="welcome"><div className="welcome-card"><div className="wordmark"><div className="brand-mark"><OrbitIcon size={20}/></div><span>ORBIT</span></div><span className="welcome-tag">YOUR PERSONAL OPERATIONS LAYER</span><h1>Everything important.<br/>Nothing noisy.</h1><p>Orbit turns your real inboxes, calendars, tasks, and work tools into one calm, intelligent daily brief.</p>
    {setupMissing&&<div className="setup-note"><strong>Owner setup is not finished yet.</strong><span>Add OWNER_EMAIL and Google OAuth credentials to this deployment before connecting a real inbox. No sample data is being shown.</span></div>}
    <div className="welcome-actions">{config?.gmailConfigured?<a href="/auth/google"><Mail size={17}/> Continue with Gmail</a>:<button disabled><Mail size={17}/> Gmail setup required</button>}{config?.demoMode&&<button onClick={onDemo}><Sparkles size={17}/> Explore labeled sample data</button>}</div>
    <div className="privacy-chips"><span>Owner: {config?.ownerConfigured?'locked':'not set'}</span><span>AI: {config?.ai.provider||'checking'}</span><span>Raw bodies: never stored</span><span>Retention: {config?.privacy.signalRetentionDays||30} days</span></div><small>Open source · Self-hostable · Your data stays yours</small><div className="legal-links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a><a href="https://github.com/advaidg/orbit-personal-cockpit">Source code</a></div></div></div>
}

function LegalPage({type}:{type:'privacy'|'terms'|'security'}){
  const content={
    privacy:{title:'Privacy policy',updated:'Effective October 15, 2026',intro:'Orbit is self-hosted software. The person who deploys an Orbit instance controls that instance and its data. The Orbit open-source project does not operate a central user database or receive data from independent installations.',sections:[
      ['Information the instance accesses','When its owner connects Google, Orbit requests read-only Gmail access plus basic Google identity information. It reads recent messages to identify actions, deadlines, changes, and low-signal mail. Orbit does not send, edit, or delete email.'],
      ['Information the instance stores','Orbit stores the owner profile, encrypted OAuth credentials, short normalized signals, tasks, connection status, and the latest brief in the instance’s PostgreSQL database. Raw email bodies are processed transiently and are not stored.'],
      ['AI processing','Rules-only mode sends no message content to an AI provider. If the owner explicitly configures OpenAI, Anthropic, or a compatible provider, bounded message excerpts are sent to that provider to produce the requested classification or brief. The selected provider’s terms and privacy policy apply.'],
      ['Sharing and selling','Orbit does not contain advertising, analytics, data brokerage, or a central telemetry service. The project does not sell personal information. A self-host operator is responsible for any additional services or modifications they enable.'],
      ['Retention and deletion','Normalized signals expire according to SIGNAL_RETENTION_DAYS, which defaults to 30 days. Owners can export their Orbit data, disconnect providers, revoke credentials, or permanently delete their account and associated database records. Infrastructure backups remain subject to the operator’s Railway or hosting configuration.'],
      ['Google API Limited Use','Orbit’s use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Google user data is used only to provide visible, owner-requested Orbit features and is not used to train a generalized or cross-user AI model.'],
      ['Security','Provider tokens are encrypted before storage. Production deployments use HTTPS, secure HTTP-only cookies, owner allowlisting, rate limits, and same-origin mutation checks. No system is perfectly secure; operators should keep dependencies updated and protect their encryption keys.'],
      ['Contact','For the open-source project, use GitHub private vulnerability reporting for security concerns. Questions about a particular installation should be directed to that installation’s operator.']
    ]},
    terms:{title:'Terms of use',updated:'Effective October 15, 2026',intro:'Orbit is open-source, self-hosted software provided under the MIT License. These terms describe the upstream project; each independent operator is responsible for their own deployment.',sections:[
      ['Your installation','You control the infrastructure, credentials, connected accounts, AI provider, users, retention settings, and costs for your deployment. Orbit is not a hosted email or AI service provided by the upstream maintainers.'],
      ['Permitted use','Use Orbit only with accounts and data you are authorized to access. Follow Google, AI-provider, hosting-provider, and applicable legal requirements. Do not use Orbit for surveillance, unauthorized access, spam, discrimination, or unlawful profiling.'],
      ['Third-party services','Google, Railway, OpenAI, Anthropic, and other optional services operate under their own terms. The Orbit project does not control their availability, pricing, data practices, or account decisions.'],
      ['No professional advice','Orbit summaries and priorities may be incomplete or incorrect. They are not legal, medical, financial, or safety advice. Review original sources before making consequential decisions.'],
      ['No warranty','The software is provided “as is,” without warranties of merchantability, fitness for a particular purpose, or non-infringement, as stated in the MIT License.'],
      ['Changes','Operators should review release notes before upgrading. Material changes to these upstream terms will be recorded in the public repository.']
    ]},
    security:{title:'Security model',updated:'Reviewed October 15, 2026',intro:'Orbit is designed as a private, single-tenant installation. Security depends on both the upstream code and how each owner configures their infrastructure.',sections:[
      ['Isolation','Every owner deploys an independent application and database. OWNER_EMAIL restricts sign-in to the configured Google identity. There is no shared Orbit tenant or central administration service.'],
      ['Credentials','OAuth tokens are encrypted with AES-256-GCM using APP_ENCRYPTION_KEY. Secrets remain server-side and must be stored in the hosting provider’s protected environment-variable system.'],
      ['Data minimization','Raw bodies are not persisted. External AI is optional. Signals automatically expire. Export excludes encrypted credentials. Disconnect and account deletion attempt provider-token revocation before removing local records.'],
      ['Operational responsibilities','Use unique generated secrets, HTTPS, database backups, dependency updates, and restricted project access. Never reuse production encryption keys in public examples or support messages.'],
      ['Reporting','Do not report vulnerabilities containing personal data in a public issue. Use GitHub private vulnerability reporting for the repository.']
    ]}
  }[type];
  return <div className="legal-page"><header><a href="/" className="wordmark"><div className="brand-mark"><OrbitIcon size={20}/></div><span>ORBIT</span></a><nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a></nav></header><main><span className="welcome-tag">SELF-HOSTED · SINGLE-TENANT</span><h1>{content.title}</h1><p className="legal-date">{content.updated}</p><p className="legal-intro">{content.intro}</p>{content.sections.map(([title,body])=><section key={title}><h2>{title}</h2><p>{body}</p></section>)}</main><footer><span>Orbit open-source project</span><a href="https://github.com/advaidg/orbit-personal-cockpit">View source</a></footer></div>;
}
