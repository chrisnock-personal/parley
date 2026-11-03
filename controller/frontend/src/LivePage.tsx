// LivePage.tsx -what's happening right now: totals, each group in use with
// who's in it and who's talking, direct calls, and everyone's online state.
// From pbx-core's in-memory state (via /live), polled by App.
import { useEffect, useState } from 'react';
import { DirectoryUser, Group, LiveCall, LiveRegistration, LiveTalking } from './api';
import { Avatar, since } from './ui';

export default function LivePage({ users, groups, registrations, calls, talking, liveError, onOpenPerson }: {
  users: DirectoryUser[]; groups: Group[]; registrations: LiveRegistration[]; calls: LiveCall[]; talking: LiveTalking[];
  liveError: string | null; onOpenPerson: (id: string) => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setTick((x) => x + 1), 1000); return () => window.clearInterval(t); }, []);

  const online = new Set(registrations.map((r) => r.extension));
  const groupCalls = calls.filter((c) => c.kind === 'group');
  const directCalls = calls.filter((c) => c.kind === 'direct');
  const inUse = groups.map((g) => ({ g, members: groupCalls.filter((c) => c.to === g.dial_code) })).filter((x) => x.members.length);
  const recorded = calls.filter((c) => c.recording).length;
  const talkingIn = (code: string) => talking.filter((t) => t.group === code).map((t) => t.extension);
  const nameOf = (ext: string) => users.find((u) => u.extension === ext)?.name ?? ext;
  // Online people first, then by name.
  const people = [...users].sort((a, b) => Number(online.has(b.extension)) - Number(online.has(a.extension)) || a.name.localeCompare(b.name));

  return (
    <div className="c-page">
      <div className="c-page-head">
        <h1>Live</h1>
        <span className="c-mono">{liveError ? `Can't reach the SIP core: ${liveError}` : 'updates every few seconds'}</span>
      </div>

      <div className="c-stats">
        <div className="c-card c-stat"><b>{users.filter((u) => online.has(u.extension)).length}<small> / {users.length}</small></b><span>people online</span></div>
        <div className="c-card c-stat"><b>{inUse.length}</b><span>{inUse.length === 1 ? 'group in use' : 'groups in use'}</span></div>
        <div className="c-card c-stat"><b>{directCalls.length}</b><span>{directCalls.length === 1 ? 'direct call' : 'direct calls'}</span></div>
        <div className="c-card c-stat"><b className={recorded ? 'rec' : ''}>{recorded}</b><span>being recorded</span></div>
      </div>

      <div className="c-live-grid">
        <div className="c-col">
          <section className="c-card">
            <h2 className="c-h2">Groups in use</h2>
            {inUse.map(({ g, members }) => {
              const talkers = talkingIn(g.dial_code);
              return (
                <div key={g.id} className="c-live-row">
                  <div className="c-grow">
                    <div><strong>{g.name}</strong> <span className="c-mono">*8{g.dial_code}</span></div>
                    <div className="c-tags">
                      {members.some((m) => m.recording) && <span className="c-tag rec">● REC</span>}
                      {g.transcribe_enabled && <span className="c-tag">Transcribed</span>}
                      {g.chat_enabled && <span className="c-tag">Chat</span>}
                    </div>
                  </div>
                  <span className="c-stack">
                    {members.map((m) => <Avatar key={m.callId} name={m.fromName} id={m.from} talking={talkers.includes(m.from)} />)}
                  </span>
                  <span className="c-mono c-live-note">{members.length} in{talkers.length ? ` · ${talkers.map(nameOf).join(', ')} talking` : ''}</span>
                </div>
              );
            })}
            {!inUse.length && <div className="c-empty">No group calls right now.</div>}
          </section>
          <section className="c-card">
            <h2 className="c-h2">Direct calls</h2>
            {directCalls.map((c) => (
              <div key={c.callId} className="c-live-row">
                <Avatar name={c.fromName} id={c.from} />
                <span className="c-grow">{c.fromName} <span className="c-mono">{c.from}</span> → {c.toName} <span className="c-mono">{c.to}</span></span>
                {c.recording && <span className="c-tag rec">● REC</span>}
                <span className="c-mono">{since(c.startedAt)}</span>
              </div>
            ))}
            {!directCalls.length && <div className="c-empty">No direct calls right now.</div>}
          </section>
        </div>

        <section className="c-card c-col">
          <h2 className="c-h2">People</h2>
          <div className="c-people-grid">
            {people.map((u) => (
              <button key={u.id} className={`c-person${online.has(u.extension) ? '' : ' off'}`} onClick={() => onOpenPerson(u.id)} title={`Open ${u.name} in People`}>
                <span className={`c-dot${online.has(u.extension) ? ' on' : ''}`} aria-hidden="true" />
                <span className="c-grow">{u.name}</span>
                <span className="c-mono">{u.extension}</span>
              </button>
            ))}
          </div>
          <p className="c-help">Online means their intercom client's line is registered.</p>
        </section>
      </div>
    </div>
  );
}
