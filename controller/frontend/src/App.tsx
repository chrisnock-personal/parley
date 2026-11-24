// App.tsx -the Parley console: sign-in, then a sidebar shell with Live,
// People and Groups, and (admins) Settings, Health, Audit and Backups.
// Shared data (people, groups, live status) is loaded here and handed to
// the pages; live status is polled every 3 s.
import ConversationsPage from './ConversationsPage';
import { useCallback, useEffect, useState } from 'react';
import { api, DirectoryUser, Group, LiveCall, LiveRegistration, LiveTalking, SessionUser } from './api';
import { markSvg, PRODUCT_NAME } from '../../../brand/mark';
import { Icon } from './ui';
import LivePage from './LivePage';
import PeoplePage from './PeoplePage';
import GroupsPage from './GroupsPage';
import HealthPanel from './HealthPanel';
import AuditPanel from './AuditPanel';
import DatabasePanel from './DatabasePanel';
import SettingsPanel from './SettingsPanel';

// The product logo, from the shared brand/mark.ts (colours: --mark-a/-b).
function Mark({ size }: { size: number }) {
  return <span className="mark" dangerouslySetInnerHTML={{ __html: markSvg(size) }} />;
}

// ── Sign in ────────────────────────────────────────────────────────────────
function Login({ onLoggedIn }: { onLoggedIn: (u: SessionUser) => void }) {
  const [email, setEmail] = useState('admin@intercom.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await api.login(email, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-brand"><Mark size={28} /> {PRODUCT_NAME} Console</h1>
        <div className="sub">Sign in to manage people, groups and the system</div>
        {error && <div className="error-banner">{error}</div>}
        <label className="c-field">Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required /></label>
        <label className="c-field">Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required autoFocus /></label>
        <button className="c-btn primary wide" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

// The password a console user was given (for the admin, ADMIN_PASSWORD)
// has to be replaced before anything else; the server refuses every other
// request until it is (#36).
function ChangePassword({ user, onChanged, onLogout }: { user: SessionUser; onChanged: () => void; onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 12) { setError('The new password needs at least 12 characters.'); return; }
    if (next !== again) { setError("The new passwords don't match."); return; }
    setBusy(true);
    try { await api.changePassword(current, next); onChanged(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-brand"><Mark size={28} /> Choose a new password</h1>
        <div className="sub">{user.email} is still using the password it was given. Choose your own before carrying on.</div>
        {error && <div className="error-banner">{error}</div>}
        <label className="c-field">Current password<input value={current} onChange={(e) => setCurrent(e.target.value)} type="password" autoComplete="current-password" required autoFocus /></label>
        <label className="c-field">New password (12 characters or more)<input value={next} onChange={(e) => setNext(e.target.value)} type="password" autoComplete="new-password" required /></label>
        <label className="c-field">New password again<input value={again} onChange={(e) => setAgain(e.target.value)} type="password" autoComplete="new-password" required /></label>
        <button className="c-btn primary wide" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save and continue'}</button>
        <button className="c-link" type="button" onClick={onLogout} style={{ display: 'block', margin: '14px auto 0' }}>Sign out</button>
      </form>
    </div>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────────
type View = 'live' | 'people' | 'groups' | 'conversations' | 'settings' | 'health' | 'audit' | 'backups';
const MAIN_NAV: { id: View; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'live', label: 'Live', icon: 'live' },
  { id: 'people', label: 'People', icon: 'people' },
  { id: 'groups', label: 'Groups', icon: 'groups' },
  { id: 'conversations', label: 'Conversations', icon: 'chat' },
];
const SYSTEM_NAV: typeof MAIN_NAV = [
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'health', label: 'Health', icon: 'health' },
  { id: 'audit', label: 'Audit', icon: 'audit' },
  { id: 'backups', label: 'Backups', icon: 'backups' },
];
const VIEW_KEY = 'parley-console-view';

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);
  const [view, setViewState] = useState<View>(() => {
    try { return (localStorage.getItem(VIEW_KEY) as View) || 'live'; } catch { return 'live'; }
  });
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* fine */ } };
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [registrations, setRegistrations] = useState<LiveRegistration[]>([]);
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [talking, setTalking] = useState<LiveTalking[]>([]);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPerson, setOpenPerson] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [u, g] = await Promise.all([api.listDirectoryUsers(), api.listGroups()]);
      setUsers(u); setGroups(g);
    } catch (err) { setError((err as Error).message); }
  }, []);
  const loadLive = useCallback(async () => {
    try {
      const live = await api.getLiveStatus();
      setRegistrations(live.registrations); setCalls(live.calls); setTalking(live.talking ?? []); setLiveError(null);
    } catch (err) { setLiveError((err as Error).message); }
  }, []);

  useEffect(() => {
    if (!api.isLoggedIn()) { setCheckedSession(true); return; }
    api.me().then(setUser).catch(() => {}).finally(() => setCheckedSession(true));
  }, []);
  useEffect(() => {
    if (!user || user.password_changed === false) return;
    void loadData(); void loadLive();
    // Live status is pushed whenever it changes (issue #12); while that
    // stream is down the page polls every 3 s and reconnects with a growing delay.
    let stopped = false;
    let streaming = false;
    const live = window.setInterval(() => { if (!streaming) void loadLive(); }, 3000);
    const abort = new AbortController();
    (async () => {
      let delay = 1000;
      while (!stopped) {
        try {
          await api.liveStream((s) => {
            streaming = true; delay = 1000;
            setRegistrations(s.registrations); setCalls(s.calls); setTalking(s.talking ?? []); setLiveError(null);
          }, abort.signal);
        } catch { /* fall back to polling */ }
        streaming = false;
        if (stopped) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    })();
    const data = window.setInterval(loadData, 30000); // pick up changes made elsewhere
    return () => { stopped = true; abort.abort(); window.clearInterval(live); window.clearInterval(data); };
  }, [user, loadData, loadLive]);
  const onError = useCallback((m: string) => setError(m), []);

  if (!checkedSession) return null;
  if (!user) return <div className="app-shell"><Login onLoggedIn={setUser} /></div>;
  if (user.password_changed === false) {
    return <div className="app-shell"><ChangePassword user={user}
      onChanged={() => setUser({ ...user, password_changed: true })}
      onLogout={() => { void api.logout(); setUser(null); }} /></div>;
  }

  const isAdmin = user.role === 'admin';
  const canEdit = isAdmin || user.role === 'editor';
  const systemNav = isAdmin ? SYSTEM_NAV : [];
  const current = (isAdmin || MAIN_NAV.some((n) => n.id === view)) ? view : 'live';
  const navButton = (n: typeof MAIN_NAV[number]) => (
    <button key={n.id} className={`c-nav-item${current === n.id ? ' on' : ''}`} aria-current={current === n.id ? 'page' : undefined}
      onClick={() => { setError(null); setView(n.id); }}>
      <Icon name={n.icon} /> {n.label}
    </button>
  );

  return (
    <div className="c-shell">
      <nav className="c-nav" aria-label="Console">
        <div className="c-brand"><Mark size={24} /> {PRODUCT_NAME} <span>Console</span></div>
        {MAIN_NAV.filter((n) => n.id !== 'conversations' || canEdit).map(navButton)}
        {systemNav.length > 0 && <div className="c-nav-head">System</div>}
        {systemNav.map(navButton)}
        <div className="c-grow" />
        <div className="c-nav-foot">
          Signed in as <strong>{user.email}</strong> <span className="c-role">{user.role}</span>
          <button className="c-linkbtn" onClick={() => { void api.logout(); setUser(null); }}>Sign out</button>
        </div>
      </nav>

      <main className="c-main">
        {error && <div className="error-banner c-banner">{error}<button className="c-linkbtn" onClick={() => setError(null)}>Dismiss</button></div>}
        {current === 'live' && (
          <LivePage users={users} groups={groups} registrations={registrations} calls={calls} talking={talking} liveError={liveError}
            canEdit={canEdit} onChanged={loadLive} onError={onError}
            onOpenPerson={(id) => { setOpenPerson(id); setView('people'); }} />
        )}
        {current === 'people' && (
          <PeoplePage key={openPerson ?? 'people'} initialId={openPerson} users={users} groups={groups} registrations={registrations}
            canEdit={canEdit} isAdmin={isAdmin} onChanged={loadData} onError={onError} />
        )}
        {current === 'groups' && (
          <GroupsPage groups={groups} users={users} calls={calls} talking={talking}
            canEdit={canEdit} isAdmin={isAdmin} onChanged={loadData} onError={onError} />
        )}
        {current === 'conversations' && canEdit && <ConversationsPage groups={groups} users={users} onError={onError} />}
        {current === 'settings' && <div className="c-page c-narrow"><div className="c-page-head"><h1>Settings</h1></div><SettingsPanel onError={onError} /></div>}
        {current === 'health' && <div className="c-page c-narrow"><div className="c-page-head"><h1>Health</h1></div><HealthPanel onError={onError} /></div>}
        {current === 'audit' && <AuditPanel groups={groups} onError={onError} />}
        {current === 'backups' && <div className="c-page c-narrow"><div className="c-page-head"><h1>Backups</h1></div><DatabasePanel onError={onError} /></div>}
      </main>
    </div>
  );
}
