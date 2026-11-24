// GroupsPage.tsx -the console's Groups page: every talk group in a list
// (how people talk in it, transcription and chat, how many people have it,
// how many are in it now), and the selected group's details beside it:
// name and dial code, talk mode, features, who has it, and who's in it.
import { useCallback, useEffect, useState } from 'react';
import { api, DirectoryUser, Group, GroupHolder, LiveCall, LiveTalking } from './api';
import { Avatar, Icon, Switch, TALK_LABEL, TalkMode, since, talkModeFields, talkModeOf } from './ui';

export default function GroupsPage({ groups, users, calls, talking, canEdit, isAdmin, onChanged, onError }: {
  groups: Group[]; users: DirectoryUser[]; calls: LiveCall[]; talking: LiveTalking[];
  canEdit: boolean; isAdmin: boolean; onChanged: () => void; onError: (m: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const selected = groups.find((g) => g.id === selectedId) ?? null;
  useEffect(() => {
    if (!adding && !selected && groups.length) setSelectedId(groups[0].id);
  }, [groups, selected, adding]);
  const inNow = (g: Group) => calls.filter((c) => c.kind === 'group' && c.to === g.dial_code);

  return (
    <div className="c-page">
      <div className="c-page-head">
        <h1>Groups <span className="c-count">{groups.length}</span></h1>
        {canEdit && (
          <button className="c-btn primary" onClick={() => { setAdding(true); setSelectedId(null); }}>
            <Icon name="plus" size={14} /> New group
          </button>
        )}
      </div>
      <div className="c-split">
        <div className="c-card c-list">
          <div className="c-row c-row-head group-cols" aria-hidden="true">
            <span>Group</span><span>Talk</span><span>Features</span><span>People</span><span>Now</span>
          </div>
          <div className="c-list-body">
            {groups.map((g) => {
              const n = inNow(g).length;
              return (
                <button key={g.id} className={`c-row group-cols${g.id === selectedId ? ' sel' : ''}`} aria-pressed={g.id === selectedId}
                  onClick={() => { setAdding(false); setSelectedId(g.id); }}>
                  <span className="c-who-text"><strong>{g.name}</strong><span className="c-mono">*8{g.dial_code}</span></span>
                  <span>{TALK_LABEL[talkModeOf(g)]}</span>
                  <span className="c-tags">
                    {g.transcribe_enabled && <span className="c-tag">Transcribed</span>}
                    {g.chat_enabled && <span className="c-tag">Chat</span>}
                  </span>
                  <span className="c-mono">{g.holder_count ?? '–'}</span>
                  <span>{n ? <span className="c-live"><i />{n}</span> : <span className="c-mono">0</span>}</span>
                </button>
              );
            })}
            {!groups.length && <div className="c-empty">No groups yet.</div>}
          </div>
        </div>
        <div className="c-card c-detail">
          {adding
            ? <NewGroup onCancel={() => setAdding(false)} onError={onError}
                onCreated={(id) => { setAdding(false); setSelectedId(id); onChanged(); }} />
            : selected
              ? <GroupDetail key={selected.id} group={selected} users={users} inNow={inNow(selected)} talking={talking}
                  canEdit={canEdit} isAdmin={isAdmin} onChanged={onChanged} onError={onError}
                  onDeleted={() => { setSelectedId(null); onChanged(); }} />
              : <div className="c-empty">Pick a group from the list.</div>}
        </div>
      </div>
    </div>
  );
}

function TalkModePicker({ value, onChange, disabled }: { value: TalkMode; onChange: (t: TalkMode) => void; disabled?: boolean }) {
  return (
    <div className="c-seg" role="group" aria-label="How people talk">
      {(['open', 'ptt', 'listen'] as TalkMode[]).map((t) => (
        <button key={t} type="button" className={value === t ? 'on' : ''} aria-pressed={value === t} disabled={disabled} onClick={() => onChange(t)}>
          {TALK_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

// How long this group's transcripts and chat are kept (#26): as Settings,
// a set number of days, or not kept (deleted after 15 minutes, never
// archived or summarised).
function KeepPicker({ keepDays, disabled, onChange }: { keepDays: number | null; disabled: boolean; onChange: (k: number | null) => void }) {
  const mode = keepDays === null ? 'settings' : keepDays === 0 ? 'none' : 'days';
  const [days, setDays] = useState(keepDays && keepDays > 0 ? keepDays : 30);
  useEffect(() => { if (keepDays && keepDays > 0) setDays(keepDays); }, [keepDays]);
  const saveDays = () => { if (mode === 'days' && days !== keepDays && days >= 1 && days <= 3650) onChange(days); };
  return (
    <div className="c-field">Keep transcripts and chat
      <div className="c-seg" role="group" aria-label="Keep transcripts and chat">
        {([['settings', 'As Settings'], ['days', 'For a set time'], ['none', "Don't keep"]] as const).map(([m, label]) => (
          <button key={m} type="button" className={mode === m ? 'on' : ''} aria-pressed={mode === m} disabled={disabled}
            onClick={() => onChange(m === 'settings' ? null : m === 'none' ? 0 : days)}>{label}</button>
        ))}
      </div>
      {mode === 'days' && (
        <span className="c-keep-days">
          <input type="number" min={1} max={3650} value={days} disabled={disabled}
            onChange={(e) => setDays(parseInt(e.target.value) || 1)} onBlur={saveDays}
            onKeyDown={(e) => { if (e.key === 'Enter') saveDays(); }} /> days for this group
        </span>
      )}
      {mode === 'none' && <p className="c-help">Lines still show live, but are deleted after 15 minutes: nothing to search, archive or summarise later.</p>}
    </div>
  );
}

function NewGroup({ onCreated, onCancel, onError }: { onCreated: (id: string) => void; onCancel: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('');
  const [dialCode, setDialCode] = useState('');
  const [talk, setTalk] = useState<TalkMode>('open');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const g = await api.createGroup({ name: name.trim(), dial_code: dialCode.trim() || undefined, ...talkModeFields(talk) });
      onCreated((g as { id: string }).id);
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="c-detail-body" onSubmit={submit}>
      <h2 className="c-detail-title">New group</h2>
      <label className="c-field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lighting" required autoFocus /></label>
      <label className="c-field">Dial code<input value={dialCode} onChange={(e) => setDialCode(e.target.value)} placeholder="made from the name if left empty" className="mono" /></label>
      <div className="c-field">How people talk<TalkModePicker value={talk} onChange={setTalk} /></div>
      <p className="c-help">Transcription, chat and who has the group are set once it's made.</p>
      <div className="c-actions">
        <button className="c-btn primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create group'}</button>
        <button className="c-btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function GroupDetail({ group, users, inNow, talking, canEdit, isAdmin, onChanged, onDeleted, onError }: {
  group: Group; users: DirectoryUser[]; inNow: LiveCall[]; talking: LiveTalking[];
  canEdit: boolean; isAdmin: boolean; onChanged: () => void; onDeleted: () => void; onError: (m: string) => void;
}) {
  const [name, setName] = useState(group.name);
  const [dialCode, setDialCode] = useState(group.dial_code);
  const [holders, setHolders] = useState<GroupHolder[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setTick((x) => x + 1), 1000); return () => window.clearInterval(t); }, []);

  const loadHolders = useCallback(() => {
    api.listGroupHolders(group.id).then(setHolders).catch((e) => onError((e as Error).message));
  }, [group.id, onError]);
  useEffect(() => { loadHolders(); }, [loadHolders]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setNote(null);
    try { await fn(); if (done) setNote(done); onChanged(); loadHolders(); }
    catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  };
  const update = (body: Parameters<typeof api.updateGroup>[1], done?: string) => run(() => api.updateGroup(group.id, body), done);

  const free = users.filter((u) => !holders.some((h) => h.user_id === u.id));
  const isTalking = (ext: string) => talking.some((t) => t.group === group.dial_code && t.extension === ext);
  const dirty = name.trim() !== group.name || dialCode.trim() !== group.dial_code;
  const listenOnly = talkModeOf(group) === 'listen';

  return (
    <div className="c-detail-body">
      <div className="c-detail-head">
        <div className="c-grow">
          <h2 className="c-detail-title">{group.name}</h2>
          <div className="c-mono">dialled as *8{group.dial_code}</div>
        </div>
        {inNow.length > 0 && <span className="c-live"><i />{inNow.length} in it now</span>}
      </div>

      <div className="c-grid2">
        <label className="c-field">Name<input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} /></label>
        <label className="c-field">Dial code<input className="mono" value={dialCode} disabled={!canEdit} onChange={(e) => setDialCode(e.target.value)} /></label>
      </div>

      <div className="c-field">How people talk
        <TalkModePicker value={talkModeOf(group)} disabled={!canEdit || busy} onChange={(t) => update(talkModeFields(t))} />
      </div>
      {listenOnly && (
        <p className="c-help">Only the people marked <b className="c-talks-word">Talks</b> can talk (push to talk). Everyone else listens:
          their client joins by itself while one of the talkers is in the group, and leaves when they've all gone.</p>
      )}

      <div className="c-switches">
        <Switch label="Transcribe" help="What's said is written down, per speaker, readable without joining" checked={group.transcribe_enabled}
          disabled={!canEdit || busy} disabledReason="Editors and admins only" onChange={(v) => update({ transcribe_enabled: v })} />
        <Switch label="Chat" help="Members can type to the group, shown with the transcript" checked={group.chat_enabled}
          disabled={!canEdit || busy} disabledReason="Editors and admins only" onChange={(v) => update({ chat_enabled: v })} />
      </div>

      {(group.transcribe_enabled || group.chat_enabled) && (
        <KeepPicker keepDays={group.keep_days ?? null} disabled={!canEdit || busy} onChange={(k) => update({ keep_days: k })} />
      )}

      <div className="c-sec"><span>Who has this group</span><span className="c-sec-note">{holders.length} {holders.length === 1 ? 'person' : 'people'}
        {listenOnly && ` · ${holders.filter((h) => h.can_talk).length} talk`}</span></div>
      <div className="c-chips">
        {holders.map((h) => (
          <span key={h.button_id} className="c-chip with-avatar">
            <Avatar name={h.name} id={h.extension} size={22} />{h.name}
            {listenOnly && (
              <button type="button" className={`c-talks${h.can_talk ? ' on' : ''}`} aria-pressed={h.can_talk} disabled={!canEdit || busy}
                title={h.can_talk ? `${h.name} can talk. Click to make them listen only` : `${h.name} listens. Click to let them talk`}
                onClick={() => run(() => api.setHolderCanTalk(group.id, h.button_id, !h.can_talk))}>
                <Icon name="mic" size={11} />{h.can_talk ? 'Talks' : 'Listens'}
              </button>
            )}
            {canEdit && <button aria-label={`Remove ${h.name}`} onClick={() => run(() => api.removeDirectoryUserButton(h.user_id, h.button_id))}><Icon name="x" size={12} /></button>}
          </span>
        ))}
        {!holders.length && <span className="c-help">Nobody has this group yet.</span>}
        {canEdit && free.length > 0 && (
          <select className="c-add" value="" aria-label="Give this group to someone"
            onChange={(e) => e.target.value && run(() => api.addDirectoryUserButton(e.target.value, { button_type: 'group', target_group_id: group.id }))}>
            <option value="">+ Add people</option>
            {free.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.extension})</option>)}
          </select>
        )}
      </div>

      <div className="c-sec"><span>In it now</span></div>
      <div className="c-people-now">
        {inNow.map((c) => (
          <div key={c.callId} className="c-person-now">
            <Avatar name={c.fromName} id={c.from} size={24} talking={isTalking(c.from)} />
            <span>{c.fromName}</span>
            <span className="c-mono">· {isTalking(c.from) ? 'talking' : since(c.startedAt)}{c.recording ? ' · recorded' : ''}</span>
          </div>
        ))}
        {!inNow.length && <span className="c-help">Nobody's in it right now.</span>}
      </div>

      {note && <div className="c-note">{note}</div>}
      {canEdit && (
        <div className="c-actions c-actions-foot">
          <button className="c-btn primary" disabled={!dirty || busy}
            onClick={() => update({ name: name.trim(), dial_code: dialCode.trim() }, 'Saved.')}>Save changes</button>
          <span className="c-grow" />
          {isAdmin && (
            <button className="c-btn danger" disabled={busy} onClick={async () => {
              if (!window.confirm(`Delete ${group.name}? Everyone who has it loses it from their intercom client.`)) return;
              try { await api.deleteGroup(group.id); onDeleted(); } catch (err) { onError((err as Error).message); }
            }}>Delete group</button>
          )}
        </div>
      )}
    </div>
  );
}
