// src/api.ts -thin fetch wrapper for the intercom client's own controller endpoints.
const BASE = '/api/v1/intercom-client';

export interface Button {
  id: string;
  directory_user_id: string;
  button_type: 'direct' | 'group';
  target_extension: string | null;
  target_group_id: string | null;
  target_group_name: string | null;
  target_group_dial_code: string | null;
  target_group_ptt_default: boolean | null;
  target_group_transcribe_enabled: boolean | null;
  label: string | null;
  sort_order: number;
}

export interface TranscriptLine {
  id: string;
  speaker_extension: string;
  speaker_name: string | null;
  text: string;
  spoken_at: string;
}

export interface GroupParticipant {
  extension: string;
  name: string;
}

export interface IntercomClientSession {
  name: string;
  extension: string;
  buttons: Button[];
}

// A shared desk kiosk, not a personal device -sessionStorage (not
// localStorage) so a reload after the tab closes never inherits the
// previous operator's session. Explicit Log out still needed for
// mid-shift handoffs without closing the tab.
let token: string | null = sessionStorage.getItem('intercom_client_token');

function setToken(t: string | null) {
  token = t;
  if (t) sessionStorage.setItem('intercom_client_token', t);
  else sessionStorage.removeItem('intercom_client_token');
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) } });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  async login(extension: string, password: string): Promise<IntercomClientSession> {
    const out = await req<IntercomClientSession & { token: string }>('/login', {
      method: 'POST', body: JSON.stringify({ extension, password }),
    });
    setToken(out.token);
    return out;
  },
  async me(): Promise<IntercomClientSession> {
    return req<IntercomClientSession>('/me');
  },
  logout() {
    setToken(null);
    return req('/logout', { method: 'POST' }).catch(() => {});
  },
  isLoggedIn() { return !!token; },

  // A group's live transcript; `after` = last line id seen, for polling.
  groupTranscript(dialCode: string, after?: string): Promise<{ transcribing: boolean; lines: TranscriptLine[] }> {
    return req(`/groups/${encodeURIComponent(dialCode)}/transcript${after ? `?after=${after}` : ''}`);
  },

  // dial code -> who's in that group right now (see the backend route).
  groupParticipants(): Promise<{ participants: Record<string, GroupParticipant[]> }> {
    return req('/groups/participants');
  },

  reportCallEvent(evt: {
    type: 'start' | 'end'; clientCallId: string;
    kind?: 'direct' | 'group'; direction?: 'outgoing' | 'incoming';
    counterpartExtension?: string; reason?: string;
  }) {
    return req('/call-events', {
      method: 'POST',
      body: JSON.stringify({ event: evt.type, ...evt }),
    });
  },
};
