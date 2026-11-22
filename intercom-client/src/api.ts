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
  target_group_chat_enabled: boolean | null; // group has chat on
  target_name: string | null; // direct buttons: who that extension belongs to
  label: string | null;
  sort_order: number;
  favourite: boolean; // group buttons: shown as a full card, joined or not
  read_aloud: boolean; // group buttons: typed messages read aloud while joined
  can_talk: boolean; // listen-only groups: this person talks; everyone else listens (issue #11)
  target_group_mode: 'talkback' | 'announce' | null; // 'announce' = listen only
}

export interface TranscriptLine {
  id: string;
  speaker_extension: string;
  speaker_name: string | null;
  text: string;
  spoken_at: string;
}

export interface ChatMessage {
  id: string;
  author_extension: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

// Newest chat message / transcript line id in a group, for "new" markers.
export interface LatestIds { chat: string | null; transcript: string | null }

// What the client polls every second (GET /groups/participants).
export interface LiveState {
  participants: Record<string, GroupParticipant[]>; // dial code -> who's in it
  talkers?: Record<string, string[]>; // listen-only groups: dial code -> extensions that talk
  online: string[];                                  // registered extensions
  avatars: Record<string, number>;                   // extension -> photo version, for people with a photo
  latest?: Record<string, LatestIds>;                // dial code -> newest chat/transcript ids
  recording: {
    self: boolean;     // this user's calls are recorded (policy: their switch + a recording server)
    icm: boolean;      // their current direct call is being recorded right now
    groups: string[];  // dial codes being recorded right now (any member's leg)
  };
}

export interface DirectoryEntry {
  extension: string;
  name: string;
}

export interface GroupParticipant {
  extension: string;
  name: string;
  talking: boolean; // speaking right now (transcriber's per-member voice tap)
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

  // A group's chat; `after` = last message id seen, for polling.
  groupChat(dialCode: string, after?: string): Promise<{ messages: ChatMessage[] }> {
    return req(`/groups/${encodeURIComponent(dialCode)}/chat${after ? `?after=${after}` : ''}`);
  },
  postChat(dialCode: string, text: string): Promise<ChatMessage> {
    return req(`/groups/${encodeURIComponent(dialCode)}/chat`, { method: 'POST', body: JSON.stringify({ text }) });
  },

  // Everyone you could call (the "All" tab), excluding yourself.
  directory(): Promise<DirectoryEntry[]> {
    return req('/directory');
  },

  // Profile picture: an already-cropped image (see App.tsx cropToSquare).
  uploadAvatar(image: Blob): Promise<{ ok: boolean }> {
    return req('/me/avatar', { method: 'PUT', headers: { 'Content-Type': image.type || 'image/jpeg' }, body: image });
  },
  removeAvatar(): Promise<{ ok: boolean }> {
    return req('/me/avatar', { method: 'DELETE' });
  },
  // Served to signed-in users only (the login cookie rides along with <img>).
  avatarUrl(extension: string, version: number): string {
    return `${BASE}/avatars/${encodeURIComponent(extension)}?v=${version}`;
  },

  // Your preferences on one of your group buttons: the star, read aloud.
  setButtonPrefs(buttonId: string, prefs: { favourite?: boolean; read_aloud?: boolean }): Promise<{ ok: boolean }> {
    return req(`/buttons/${encodeURIComponent(buttonId)}`, { method: 'PATCH', body: JSON.stringify(prefs) });
  },

  // dial code -> who's in that group right now (see the backend route).
  groupParticipants(): Promise<LiveState> {
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
