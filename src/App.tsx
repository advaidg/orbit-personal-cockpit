import { useEffect, useMemo, useState } from 'react';
import { Activity, Bell, CalendarDays, Check, ChevronRight, CircleDollarSign, Clock3, GitBranch, Inbox, LayoutDashboard, Mail, Menu, MessageSquare, Orbit as OrbitIcon, Plane, Plus, RefreshCw, Search, Settings, Sparkles, UserRound, X, Zap } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { Connection, Dashboard, Priority, Signal, Source, Task } from './types';

const sourceIcons: Record<Source, typeof Mail> = { gmail: Mail, outlook: Inbox, calendar: CalendarDays, github: GitBranch, slack: MessageSquare, manual: UserRound };
const categoryIcons: Record<string, typeof Mail> = { action: Zap, waiting: Clock3, calendar: CalendarDays, money: CircleDollarSign, travel: Plane, people: UserRound, noise: Inbox };

function timeAgo(value?: string) { return value ? formatDistanceToNow(new Date(value), { addSuffix: true }) : 'Never'; }

export function App() {
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
  const [config,setConfig]=useState<{gmailConfigured:boolean;demoMode:boolean;ai:{provider:string};privacy:{signalRetentionDays:number}}|null>(null);
  useEffect(()=>{fetch('/api/config').then(r=>r.json()).then(setConfig).catch(()=>null)},[]);
  const setupMissing=new URLSearchParams(location.search).get('setup')==='gmail'||config?.gmailConfigured===false;
  return <div className="welcome"><div className="welcome-card"><div className="wordmark"><div className="brand-mark"><OrbitIcon size={20}/></div><span>ORBIT</span></div><span className="welcome-tag">YOUR PERSONAL OPERATIONS LAYER</span><h1>Everything important.<br/>Nothing noisy.</h1><p>Orbit turns your real inboxes, calendars, tasks, and work tools into one calm, intelligent daily brief.</p>
    {setupMissing&&<div className="setup-note"><strong>Owner setup is not finished yet.</strong><span>Add Google OAuth credentials to this deployment before connecting a real inbox. No sample data is being shown.</span></div>}
    <div className="welcome-actions">{config?.gmailConfigured?<a href="/auth/google"><Mail size={17}/> Continue with Gmail</a>:<button disabled><Mail size={17}/> Gmail setup required</button>}{config?.demoMode&&<button onClick={onDemo}><Sparkles size={17}/> Explore labeled sample data</button>}</div>
    <div className="privacy-chips"><span>AI: {config?.ai.provider||'checking'}</span><span>Raw bodies: never stored</span><span>Retention: {config?.privacy.signalRetentionDays||30} days</span></div><small>Open source · Self-hostable · Your data stays yours</small></div></div>
}
