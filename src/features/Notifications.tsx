import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '../api';
import { useLoad, usePoll } from '../hooks';
import type { OrbitNotification } from '../types';
import { Chip, ago } from './ui';

const SHOWN_KEY = 'orbit.shownNotifications';
const seen = (): Set<string> => { try { return new Set(JSON.parse(sessionStorage.getItem(SHOWN_KEY) || '[]')); } catch { return new Set(); } };
const remember = (ids: Set<string>) => { try { sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...ids].slice(-200))); } catch { /* storage may be unavailable */ } };

/** Bell + popover. While the page is open, new notifications also appear as browser alerts if allowed. */
export function NotificationBell({ browserEnabled, onNavigate }: { browserEnabled: boolean; onNavigate: (link: string) => void }) {
  const list = useLoad(() => api.get<{ notifications: OrbitNotification[]; unread: number }>('/api/notifications'));
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  usePoll(list.reload, 45_000);

  useEffect(() => {
    if (!browserEnabled || !list.data || !('Notification' in window) || Notification.permission !== 'granted') return;
    const shown = seen();
    const fresh = list.data.notifications.filter((item) => !item.read && !shown.has(item.id) && Date.now() - new Date(item.createdAt).getTime() < 15 * 60_000);
    for (const item of fresh.slice(0, 3)) { new Notification(item.title, { body: item.body.slice(0, 160), tag: item.id }); shown.add(item.id); }
    if (fresh.length) remember(shown);
  }, [list.data, browserEnabled]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', close); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); };
  }, [open]);

  const unread = list.data?.unread ?? 0;
  const markRead = async () => { await api.post('/api/notifications/read', {}); await list.reload(); };
  return (
    <div className="bell" ref={root}>
      <button className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><Bell size={18} aria-hidden />{unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}</button>
      {open && (
        <div className="bell-pop" role="dialog" aria-label="Notifications">
          <header><strong>Notifications</strong>{unread > 0 && <button className="link" onClick={markRead}><CheckCheck size={13} aria-hidden /> Mark all read</button>}</header>
          <ul>{(list.data?.notifications ?? []).map((item) => <li key={item.id} className={item.read ? '' : 'unread'}><button onClick={() => { setOpen(false); if (item.link) onNavigate(item.link); void api.post('/api/notifications/read', { ids: [item.id] }).then(list.reload); }}><span><Chip tone={item.kind === 'failure' ? 'bad' : item.kind === 'reminder' ? 'warn' : 'info'}>{item.kind}</Chip> <small>{ago(item.createdAt)}</small></span><b>{item.title}</b><em>{item.body.slice(0, 140)}</em></button></li>)}{!(list.data?.notifications.length) && <li className="empty">You are all caught up.</li>}</ul>
        </div>
      )}
    </div>
  );
}
