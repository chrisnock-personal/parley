// PeoplePage.tsx -the console's People page: everyone with an intercom
// client login, in a list you can search, and the selected person's
// details beside it: name and extension, whether they can log in and are
// recorded, their groups and intercom keys, password reset and delete.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, DirectoryUser, DirectoryUserButton, Group, LiveRegistration } from './api';
import { Avatar, Icon, Switch } from './ui';

export default function PeoplePage({ users, groups, registrations, canEdit, isAdmin, onChanged, onError, initialId = null }: {
  users: DirectoryUser[]; groups: Group[]; registrations: LiveRegistration[]; initialId?: string | null;
  canEdit: boolean; isAdmin: boolean; onChanged: () => void; onError: (m: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const online = useMemo(() => new Set(registrations.map((r) => r.extension)), [registrations]);

  const shown = users.filter((u) => {
    const q = search.trim().toLowerCase();
    return !q || u.name.toLowerCase().includes(q) || u.extension.includes(q);
  });
  const selected = users.find((u) => u.id === selectedId) ?? null;
  useEffect(() => {
    if (!adding && !selected && users.length) setSelectedId(users[0].id);
  }, [users, selected, adding]);

  return (
    <div className="c-page">
      <div className="c-page-head">
        <h1>People <span className="c-count">{users.length}</span></h1>
        <label className="c-search">
          <Icon name="search" size={14} />
          <span className="sr-only">Search people</span>
          <input type="search" placeholder="Search by name or extension" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {canEdit && (
          <button className="c-btn primary" onClick={() => { setAdding(true); setSelectedId(null); }}>
            <Icon name="plus" size={14} /> Add person
          </button>
        )}
      </div>

      <div className="c-split">
        <div className="c-card c-list">
          <div className="c-row c-row-head people-cols" aria-hidden="true">
            <span>Name</span><span>Groups</span><span>Keys</span><span>Online</span><span />
          </div>
          <div className="c-list-body">
            {shown.map((u) => (
              <button key={u.id} className={`c-row people-cols${u.id === selectedId ? ' sel' : ''}`} aria-pressed={u.id === selectedId}
                onClick={() => { setAdding(false); setSelectedId(u.id); }}>
                <span className="c-who">
                  <Avatar name={u.name} id={u.extension} />
                  <span className="c-who-text"><strong>{u.name}</strong><span className="c-mono">ext {u.extension}</span></span>
                </span>
                <span className="c-mono">{u.group_count ?? '–'}</span>
                <span className="c-mono">{u.key_count ?? '–'}</span>
                <span>{online.has(u.extension)
                  ? <span className="c-dot on" role="img" aria-label="Online" />
                  : <span className="c-dot" role="img" aria-label="Offline" />}</span>
                <span className="c-tags">
                  {u.siprec_enabled && <span className="c-tag rec">● REC</span>}
                  {!u.enabled && <span className="c-tag">Can't log in</span>}
                </span>
              </button>
            ))}
            {!shown.length && <div className="c-empty">{users.length ? 'Nobody matches that search.' : 'No people yet.'}</div>}
          </div>
        </div>

        <div className="c-card c-detail">
          {adding
            ? <NewPerson onCancel={() => setAdding(false)} onError={onError}
                onCreated={(id) => { setAdding(false); setSelectedId(id); onChanged(); }} />
            : selected
              ? <PersonDetail key={selected.id} user={selected} users={users} groups={groups} online={online.has(selected.extension)}
                  canEdit={canEdit} isAdmin={isAdmin} onChanged={onChanged} onError={onError}
                  onDeleted={() => { setSelectedId(null); onChanged(); }} />
              : <div className="c-empty">Pick someone from the list.</div>}
        </div>
      </div>
    </div>
  );
}

function NewPerson({ onCreated, onCancel, onError }: { onCreated: (id: string) => void; onCancel: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('');
  const [extension, setExtension] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const u = await api.createDirectoryUser({ name: name.trim(), extension: extension.trim(), password });
      onCreated((u as { id: string }).id);
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="c-detail-body" onSubmit={submit}>
      <h2 className="c-detail-title">Add a person</h2>
      <p className="c-help">They log in to the intercom client with their extension and this password.</p>
      <label className="c-field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alice Chen" required autoFocus /></label>
      <label className="c-field">Extension<input value={extension} onChange={(e) => setExtension(e.target.value)} placeholder="e.g. 2009" required /></label>
      <label className="c-field">Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={4} /></label>
      <div className="c-actions">
        <button className="c-btn primary" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add person'}</button>
        <button className="c-btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function PersonDetail({ user, users, groups, online, canEdit, isAdmin, onChanged, onDeleted, onError }: {
  user: DirectoryUser; users: DirectoryUser[]; groups: Group[]; online: boolean;
  canEdit: boolean; isAdmin: boolean; onChanged: () => void; onDeleted: () => void; onError: (m: string) => void;
}) {
  const [name, setName] = useState(user.name);
  const [extension, setExtension] = useState(user.extension);
  const [buttons, setButtons] = useState<DirectoryUserButton[]>([]);
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadButtons = useCallback(() => {
    api.listDirectoryUserButtons(user.id).then(setButtons).catch((e) => onError((e as Error).message));
  }, [user.id, onError]);
  useEffect(() => { loadButtons(); }, [loadButtons]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setNote(null);
    try { await fn(); if (done) setNote(done); onChanged(); loadButtons(); }
    catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  };

  const groupButtons = buttons.filter((b) => b.button_type === 'group');
  const keyButtons = buttons.filter((b) => b.button_type === 'direct');
  const freeGroups = groups.filter((g) => !groupButtons.some((b) => b.target_group_id === g.id));
  const freeKeys = users.filter((u) => u.id !== user.id && !keyButtons.some((b) => b.target_extension === u.extension));
  const byExt = new Map(users.map((u) => [u.extension, u]));
  const dirty = name.trim() !== user.name || extension.trim() !== user.extension;

  return (
    <div className="c-detail-body">
      <div className="c-detail-head">
        <Avatar name={user.name} id={user.extension} size={44} />
        <div>
          <h2 className="c-detail-title">{user.name}</h2>
          <div className="c-mono">ext {user.extension} · {online ? 'online' : 'offline'}{user.enabled ? '' : ' · can’t log in'}</div>
        </div>
      </div>

      <div className="c-grid2">
        <label className="c-field">Name<input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} /></label>
        <label className="c-field">Extension<input value={extension} disabled={!canEdit} onChange={(e) => setExtension(e.target.value)} /></label>
      </div>
      {dirty && extension.trim() !== user.extension && (
        <p className="c-help warn">Changing the extension means they need a new password before their line works again.</p>
      )}

      <div className="c-switches">
        <Switch label="Can log in" help="Sign in to the intercom client and register its line" checked={user.enabled}
          disabled={!canEdit || busy} disabledReason="Editors and admins only"
          onChange={(v) => run(() => api.updateDirectoryUser(user.id, { enabled: v }))} />
        <Switch label="Record calls" help="Every call they make goes to the recording server (Settings)" checked={user.siprec_enabled}
          disabled={!isAdmin || busy} disabledReason="Admins only"
          onChange={(v) => run(() => api.updateDirectoryUser(user.id, { siprec_enabled: v }))} />
      </div>

      <div className="c-sec"><span>Groups</span><span className="c-sec-note">talk groups on their client</span></div>
      <div className="c-chips">
        {groupButtons.map((b) => (
          <span key={b.id} className="c-chip">
            {b.target_group_name}
            {canEdit && <button aria-label={`Remove ${b.target_group_name}`} onClick={() => run(() => api.removeDirectoryUserButton(user.id, b.id))}><Icon name="x" size={12} /></button>}
          </span>
        ))}
        {!groupButtons.length && <span className="c-help">No groups yet.</span>}
        {canEdit && freeGroups.length > 0 && (
          <select className="c-add" value="" aria-label="Add a group"
            onChange={(e) => e.target.value && run(() => api.addDirectoryUserButton(user.id, { button_type: 'group', target_group_id: e.target.value }))}>
            <option value="">+ Add group</option>
            {freeGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
      </div>

      <div className="c-sec"><span>Intercom keys</span><span className="c-sec-note">people they call with one press</span></div>
      <div>
        {keyButtons.map((b) => {
          const t = byExt.get(b.target_extension ?? '');
          const label = t?.name ?? b.target_extension ?? '';
          return (
            <div key={b.id} className="c-keyrow">
              <Avatar name={label} id={b.target_extension ?? ''} size={24} />
              <span className="c-grow">{label}</span>
              <span className="c-mono">{b.target_extension}</span>
              {canEdit && <button className="c-icon-btn" aria-label={`Remove key for ${label}`} onClick={() => run(() => api.removeDirectoryUserButton(user.id, b.id))}><Icon name="x" size={14} /></button>}
            </div>
          );
        })}
        {!keyButtons.length && <span className="c-help">No keys yet.</span>}
        {canEdit && freeKeys.length > 0 && (
          <select className="c-add" value="" aria-label="Add an intercom key" style={{ marginTop: 10 }}
            onChange={(e) => e.target.value && run(() => api.addDirectoryUserButton(user.id, { button_type: 'direct', target_extension: e.target.value }))}>
            <option value="">+ Add key</option>
            {freeKeys.map((u) => <option key={u.id} value={u.extension}>{u.name} ({u.extension})</option>)}
          </select>
        )}
      </div>

      {resetting && (
        <form className="c-inline-form" onSubmit={(e) => { e.preventDefault(); void run(() => api.resetDirectoryUserPassword(user.id, newPassword), 'Password changed.').then(() => { setResetting(false); setNewPassword(''); }); }}>
          <label className="c-field c-grow">New password<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={4} autoFocus /></label>
          <button className="c-btn primary" type="submit" disabled={busy}>Set password</button>
          <button className="c-btn" type="button" onClick={() => setResetting(false)}>Cancel</button>
        </form>
      )}
      {note && <div className="c-note">{note}</div>}

      {canEdit && (
        <div className="c-actions c-actions-foot">
          <button className="c-btn primary" disabled={!dirty || busy}
            onClick={() => run(() => api.updateDirectoryUser(user.id, { name: name.trim(), extension: extension.trim() }), 'Saved.')}>Save changes</button>
          {isAdmin && !resetting && <button className="c-btn" onClick={() => setResetting(true)}>Reset password</button>}
          <span className="c-grow" />
          {isAdmin && (
            <button className="c-btn danger" disabled={busy} onClick={async () => {
              if (!window.confirm(`Delete ${user.name} (${user.extension})? Their groups and keys go too, and they can no longer log in.`)) return;
              try { await api.deleteDirectoryUser(user.id); onDeleted(); } catch (err) { onError((err as Error).message); }
            }}>Delete</button>
          )}
        </div>
      )}
    </div>
  );
}
