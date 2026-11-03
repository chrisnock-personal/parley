<img src="brand/public/icon-512.png" width="72" alt="Parley logo">

# Parley

A container-based IP intercom with **direct** (point-to-point) and **group**
(open-mic + PTT) calling, a **custom TypeScript PBX core** (drachtio +
rtpengine), a real-browser **WebRTC intercom client** (a direct-intercom
panel plus any number of talk **groups** joined at once, laid out after
Eyevinn's open intercom), and an admin **controller console** for directory
users, groups, live status, health, audit, and database backup. Built for a
**routed / multi-subnet** deployment.

Parley (called Open Intercom until 2026-10-18) continues **ip-intercom**
(`chrisnock-personal/ip-intercom`) in a fresh repo, without its git
history. It starts from ip-intercom `92ea17a` (2026-10-17). Trading-turret features (handsets, speaker, external PBX
lines) live in a sister project, **Open Turret**
(`chrisnock-personal/open-turret`), forked from ip-intercom the same day.

```
intercom-client (browser: getUserMedia/RTCPeerConnection, wss:// or ws:// via nginx)
      │ SIP/WS (WebRTC media, DTLS-SRTP)
      ▼
   pbx-core (drachtio + TS)  ◀─ ng ─▶  rtpengine (media anchor; bridges DTLS-SRTP ↔ plain RTP)
      │ group calls (*8<code>) B2BUA'd to ▼
   freeswitch (mod_conference open-mic mixer)

controller-frontend (nginx: console + /intercom-client/ + /ws proxy, HTTP+HTTPS)
                                                  ──/api/v1──▶ controller-backend
                                                                (Express+TS, Postgres)
```

Seven compose services: `postgres`, `controller-backend`, `controller-frontend`
(also serves the intercom client at `/intercom-client/`), `pbx-core`,
`rtpengine`, `freeswitch`, `transcriber`.

## Screenshots
<img width="806" height="709" alt="Image" src="https://github.com/user-attachments/assets/8303f000-b91e-44af-9d4f-048e5aab5b8f" />
<br>
<img width="1169" height="959" alt="Image" src="https://github.com/user-attachments/assets/5ff5b03c-87df-4565-b258-da077731dd2f" /><br>
<img width="1169" height="959" alt="Image" src="https://github.com/user-attachments/assets/1380e9f6-4454-46c2-8348-d31b81dd0813" /><br>
<img width="1169" height="959" alt="Image" src="https://github.com/user-attachments/assets/78be5a90-a6b2-4580-9e5a-92e42d4a4555"/><br>
<img width="1174" height="896" alt="Image" src="https://github.com/user-attachments/assets/08cc2e70-3216-43cd-baeb-8fe4c050febc" /><br>

``

## What's implemented

### Calling
- **Direct intercom** -dial a registered extension; pbx-core injects an
  auto-answer header (`Call-Info`/`Alert-Info`) and anchors media through
  rtpengine. Real SIP **hold/resume** (a genuine re-INVITE, not just local
  mute) works both directions of a call.
- **Group open-mic** -pbx-core B2BUAs a group call (`*8<dial_code>`)
  straight to FreeSWITCH, which joins it into a `mod_conference` room of the
  same name. Every unmuted member hears every other one -no custom mixing
  logic. PTT floor control is done client-side (gating the local mic track),
  not at the mixer.
- **intercom-client/** -the only endpoint type in this system: a real-browser
  softphone (genuine `getUserMedia`/`RTCPeerConnection`, no headless shims)
  laid out after Eyevinn's open intercom
  ([intercom-frontend](https://github.com/Eyevinn/intercom-frontend)). An
  **Intercom** panel holds the one direct call (auto-answer toggle, real SIP
  hold/resume) and its ICM keys. Below it, one strip per assigned
  **group**: join or leave each independently, any number at once. Each
  group lists who's in it right now, even before you join (from
  pbx-core's live call list, polled every 3s). Every
  slot has its own talk controls (latching mute plus hold-to-talk PTT),
  its own listen controls (listen mute and volume), and an activity light
  driven by inbound audio level. Driven by a **directory user** login
  (extension + password, a hot-desk model -not tied to one physical
  device).
- rtpengine bridges a genuine WebRTC leg (the intercom client) to plain RTP
  (FreeSWITCH) automatically -including the trickier case of **two**
  simultaneous WebRTC legs (intercom client ↔ intercom client), which needed
  its own `ICE-lite` handling distinct from the single-WebRTC-leg case.

### Call recording (SIP-REC) and live transcription
Both take a copy of call media from **rtpengine** (`subscribe request`), so
nothing extra sits in the media path and browser legs arrive already
decrypted.
- **SIP-REC** (RFC 7865/7866): turn on **Record calls** for a directory user
  and set the **recording server URI** under Settings. pbx-core then acts as
  the recording client for that user's direct calls and group legs. It opens
  a separate session to the recording server carrying one labelled stream
  per party plus RFC 7865 participant metadata, and ends it with the call.
  Recording is fail-open: if the server can't be reached, the call goes
  ahead unrecorded (logged).
- **Live transcription**: turn on **Transcribe** for a group. The
  `transcriber` service taps each member's own voice, cuts it into
  utterances at pauses (silence and muted PTT members are never sent),
  transcribes it with a whisper.cpp `whisper-server` (`WHISPER_URL`; by
  default a shared instance on the host), and stores lines attributed to
  the speaker. In the intercom client, a **Transcript** button on that
  group's strip shows it live to anyone with the group, joined or not. Lines
  are kept for the retention set under Settings.

### Controller console
- **Live** -real registered intercom clients and in-progress calls, polled
  straight from pbx-core's own in-memory state (pbx-core has no database
  by design; a small admin HTTP endpoint on pbx-core exposes this, enriched
  with friendly names by the controller). Call-type badges (ICM/GRP-ICM)
  and per-type metrics.
- **Groups** / **Directory Users** -full CRUD (create/edit/delete), button
  assignments (direct or group targets) per directory user.
- **Health** (admin only) -host CPU/mem/disk, DB size/stats, endpoint
  statuses, pbx-core reachability, and a live container-log viewer (reads
  other containers' logs over the podman API socket).
- **Audit** (admin only) -searchable history of `audit_log` (who did what,
  when -logins, CRUD, call start/end, PTT grants, including intercom-client-
  placed calls).
- **Database** (admin only) -`pg_dump` backup download, restore from an
  uploaded dump, `VACUUM ANALYZE`, table size/bloat stats, retention/purge
  for `audit_log`/`intercom_sessions`, and gzip archive + optional SCP
  transfer.
- Users / JWT / RBAC (viewer/editor/admin), append-only audit log,
  background endpoint health polling -conventions deliberately mirror
  Chris's Walk the Nxt Floor project (`pg` pool, numbered migrations, JWT
  roles, `audit_log` shape).

### Media images are built locally, not pulled
Both media components are built from Dockerfiles under `images/` rather
than pulled as pre-built images, because the obvious public images don't
work: SignalWire's FreeSWITCH image is behind an auth-gated registry, and
the only `:latest` rtpengine on Docker Hub is ~5 years old.

- **`images/rtpengine`** installs `rtpengine-daemon` from the Debian
  bookworm package and runs it **userspace-only** (`--table=-1`) so it
  needs no kernel module in the container.
- **`images/freeswitch`** builds `FROM drachtio/drachtio-freeswitch-base`,
  overlaying a minimal `modules.conf`, a `sofia.conf` including our SIP
  profile, the intercom SIP profile + dialplan, and an open-mic conference
  profile. The profile's bind IP is set explicitly via `FREESWITCH_BIND_IP`
  (see `entrypoint.sh`) rather than FreeSWITCH's own `$${local_ip_v4}`
  auto-detection -on a multi-homed host, that auto-detection can pick a
  different interface than the one pbx-core is configured to dial, which
  silently breaks every group call.

## Run it (podman-compose)
```bash
cp .env.example .env
# edit .env: set RTPENGINE_PUBLIC_IP to this host's routed/LAN IP,
# and change JWT_SECRET / ADMIN_PASSWORD / DRACHTIO_SECRET

podman-compose up -d --build
```
- Controller UI: `http://<host>:8080` or `https://<host>:8445` -sign in
  with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. (Host `8445`, not the
  usual `8443` -see `docker-compose.yml`'s comment: `8443`/`8444` collide
  with other projects on the reference lab host.)
- Intercom Client: `http://<host>:8080/intercom-client/` (localhost only
  -`getUserMedia` needs a secure context, and `localhost` is
  browser-exempted) or `https://<host>:8445/intercom-client/` (works from a
  genuinely separate machine too, once you click through the self-signed
  cert warning once per browser -see "TLS" below).
- Controller API: `http://<host>:3100/api/v1/...`
- pbx-core SIP/WS: `<host>:8188`, SIP UDP/TCP on `:5063` (neither is the
  standard `:8088`/`:5060` -see `pbx-core/entrypoint.sh`'s comment: this
  host also runs another SIP stack, `asterisk-ci`, that already holds both).
- Postgres: exposed on host `5433` for direct inspection if needed.

`pbx-core`, `rtpengine`, and `freeswitch` run with `network_mode: host` —
required so rtpengine can anchor media reachably for endpoints on other
subnets in a routed deployment.

### Demo data
Set `SEED_DEMO=true` in `.env` before `podman-compose up` to get a
ready-to-use demo: a broadcast control-room crew on extensions **2001-2008**
(Director, Producer, Vision Mixer, Audio Engineer, Camera 1/2, Floor
Manager, Graphics), all with password `DEMO_PASSWORD` (default
`demo1234`). There are five talk groups: Production and Engineering (open
mic), and Cameras, Studio Floor and All Call (PTT). Each crew member gets
ICM keys to the people they'd talk to and buttons for their groups.
Seeding is additive and idempotent: existing extensions and group dial
codes are never touched, so it's safe to leave on. Production is created with
live transcription on, so the demo shows it straight away.

### Optional: the Health page's log viewer
The console's Health page can show live logs from every container over the
podman API socket. This needs one host-level prerequisite (rootless
podman):
```bash
systemctl --user enable --now podman.socket
```
On SELinux-enforcing hosts (Fedora/RHEL), `controller-backend` also runs
with `security_opt: label:disable` in `docker-compose.yml` -SELinux
denies a confined container from connecting to the podman socket even with
the file permissions otherwise correct, and no stock boolean covers that
specific case. This widens that one container's blast radius (full
control-plane visibility into every container on the host, not just this
project's 6) -accepted deliberately for this lab; skip the log viewer
entirely if you'd rather not take that tradeoff.

### TLS
`controller-frontend` creates a small **local CA** on first start, and that
CA signs the server certificate nginx presents. Both are kept in a volume,
so they survive redeploys. Plain HTTP (`:8080`) and HTTPS (`:8445` in this
compose file; see `docker-compose.yml`) are served side by side. Opening
the intercom client over plain HTTP from anywhere but `localhost` redirects
to HTTPS, because browsers only allow the microphone in a secure context.
Nothing else needs configuring beyond `RTPENGINE_PUBLIC_IP` in `.env`, which
is used as the certificate's IP entry. The client's SIP/WS signaling is
proxied through the same nginx at `/ws`.

**Trust the CA on each device** (once per device):
- **iPad / iPhone**: open `http://<host>:8080/ca.crt` in Safari and allow
  the profile download. Install it in Settings → *Profile Downloaded*, then
  turn it on under Settings → General → About → *Certificate Trust
  Settings*. Tapping through Safari's certificate warning is **not
  enough**: WebKit doesn't extend that exception to WebSocket connections,
  so the client's SIP line never connects ("connecting…" forever).
- **Desktop browsers**: import `ca.crt` as a trusted authority, or click
  through the warning (desktop Chrome/Firefox do allow the WebSocket after
  that).

The CA has **no** name constraints: iOS rejected a name-constrained version
(see `controller/frontend/entrypoint.sh`). Its private key never leaves the
`parley-tls-certs` volume, but anyone holding that key could mint
certificates that trusting devices would accept for any site, so protect
the volume, and remove the profile from devices you no longer use. The server certificate follows Apple's rules (825-day validity,
server-auth usage) and is re-issued automatically within 30 days of expiry.
If `RTPENGINE_PUBLIC_IP` changes, a new CA is generated and every device
must install it again.

### Setting up an intercom client
1. Console → **Directory Users** panel → create a person (name, extension,
   intercom-client login password), then add them a direct button (target
   extension) and/or a group button.
2. Open `http://localhost:8080/intercom-client/`, log in with the extension
   + password.
3. Press an ICM key -direct calls auto-connect instantly (pbx-core's
   auto-answer headers) on the Intercom panel; press the same key again to
   hang up. Press **Join** on a group to enter its FreeSWITCH
   conference; join as many groups as you like, and **Leave** each one
   separately. A group with `ptt_default` set starts muted: hold
   **Hold to talk**, or click the mute toggle to latch the mic open.
4. Testing two intercom clients on **one machine**: use genuinely separate
   browser contexts (an Incognito window, or a different browser)
   -duplicated tabs share `sessionStorage` and will fight over the same
   login.

### Testing a group (open-mic)
1. Console → **Groups** panel → create a group (mode *Talkback* for
   open-mic, *Announce* for one-way paging). Dial code defaults to a slug
   of the name.
2. Tick which endpoints/directory users are members via their button
   assignments, or add a group button to a directory user directly.
3. Have an intercom client press the group button -pbx-core routes
   `*8<dial_code>` to FreeSWITCH, which joins every talking member into the
   same conference. Everyone unmuted hears everyone else.

## Repo layout
```
docker-compose.yml          -full stack (this is what you run)
.env.example                -copy to .env and fill in
pod.yaml                    -alternative: podman play kube (pbx-core+rtpengine only)
migrations/                 -controller's numbered SQL migrations
controller/
  backend/                  -Express API: auth, endpoints, groups, intercom,
                               directory users, intercom client login, system
                               health/audit/logs, admin db backup/restore
  frontend/                 -console (Vite/React, built + served by nginx) —
                               its Containerfile also builds intercom-client/
                               as a second stage, served at /intercom-client/;
                               entrypoint.sh generates a self-signed TLS
                               cert on first start
intercom-client/            -real-browser intercom client (Vite/React/TS):
                               genuine getUserMedia/RTCPeerConnection, an
                               Intercom (direct) slot + N groups,     
                               directory-user login
pbx-core/                   -drachtio SIP core: registrar, direct/group
                               routing, rtpengine wrapper, admin status API
images/
  rtpengine/                -rtpengine media relay image (Debian package, userspace mode)
  freeswitch/                -group open-mic mixer image (FROM drachtio FS base + conf overlay)
patches/
  endpoint-auto-answer.md   -reference notes for the separate, unrelated
                               container-sip-endpoint sibling project
```

## Notes / knobs
- **SIP digest auth is on** for pbx-core's REGISTER/INVITE (RFC 2617/3261) —
  each directory user's intercom-client login password doubles as their SIP
  credential (pbx-core stores/checks a precomputed HA1 hash of it, never the
  plaintext -see `migrations/011_directory_user_sip_auth.sql`). A directory
  user created or password-reset before this migration, or whose extension
  was changed since, needs a password reset (Directory Users panel -> "Reset
  intercom client login password") before they can register again.
- **Endpoint REST API tokens**: `controller-backend` sends `Authorization:
  Bearer <token>` on every call to an endpoint's `rest_url` when one is set
  (`POST /endpoints/:id/regenerate-token`, admin-only, returns the token
  once -no other route ever exposes it again). Optional, not required: an
  endpoint with no token configured gets no `Authorization` header at all.
  Whether this is actually enforced depends entirely on that endpoint's own
  implementation -nothing built into this repo runs a real endpoint today
  (`intercom_endpoints` is empty by design; `intercom-client` doesn't use
  this REST path at all, it dials pbx-core directly over SIP).
  Still unauthenticated: FreeSWITCH's own `intercom` SIP profile (the
  pbx-core-to-FreeSWITCH leg, internal-only) -add FreeSWITCH auth before
  this leaves the lab.
- TLS is self-signed (see "TLS" above) -fine for a private LAN lab, but
  every browser/device needs its own one-time trust exception. Swap in a
  real cert by mounting it over `/etc/nginx/tls/{cert,key}.pem` if you
  ever have one (e.g. an internal CA).
- `HEALTH_INTERVAL_MS` / retention are env-configurable on
  `controller-backend`, same pattern as Walk the Nxt Floor's
  `sipHealthService`.
- Local dev without containers: `cd controller/backend && npm install &&
  npm run dev` needs `PGHOST`/`PGPORT` etc pointed at a reachable Postgres;
  note `migrate.ts`'s `MIGRATIONS_DIR` assumes the container layout —
  adjust the relative path if running straight from `src/`.

## Brand

The name is **Parley**, and the logo is two voices with their waves meeting
in the middle. It lives in one place, `brand/`:
- `brand/mark.ts`: the logo as SVG markup (a full version, and a simpler
  one used below 28px so the thin waves don't blur together). Both apps
  import it; its colours come from each app's `--mark-a`/`--mark-b` CSS
  variables, so it follows the theme.
- `brand/public/`: `favicon.svg`, `apple-touch-icon.png` (iPad home screen)
  and `icon-512.png`, copied into both builds as Vite's `publicDir`.

Everything else was renamed from `open-intercom` on 2026-10-18 too: the
GitHub repo (`chrisnock-personal/parley`), containers (`parley-*`), volumes,
packages, the SIP realm (`parley`) and browser storage keys. The realm is
part of every stored SIP password hash; a user's hash is refreshed the next
time they log in to the client, so nobody needs a password reset. The
generic word "intercom" stays where it names the thing rather than the
product: the intercom client (`intercom-client/`, `/intercom-client/`), the
`intercom_*` tables and the `intercom` database.

A second logo is kept in reserve, for if the product grows text chat
alongside voice: a speech bubble with a live level meter (`P5` on the design
canvas). Its 48x48 drawing:

```svg
<path d="M12 6 H36 A8 8 0 0 1 44 14 V28 A8 8 0 0 1 36 36 H22 L13 43 V36 H12 A8 8 0 0 1 4 28 V14 A8 8 0 0 1 12 6 Z" fill="#5BC0EB"/>
<rect x="13.2" y="17" width="3.6" height="8" rx="1.8" fill="#121417"/>
<rect x="19.2" y="13" width="3.6" height="16" rx="1.8" fill="#121417"/>
<rect x="25.2" y="15.5" width="3.6" height="11" rx="1.8" fill="#121417"/>
<rect x="31.2" y="18.5" width="3.6" height="5" rx="1.8" fill="#121417"/>
<circle cx="38.5" cy="11.5" r="4.5" fill="#4CC38A" stroke="#121417" stroke-width="2.5"/>
```

## Roadmap
Each item needs mocking or working through before it's built.

**Admin console rework (mock first)**
The console works but isn't user friendly (Chris, 2026-11-03). Seen while
taking the overview screenshots:
- Groups and Directory Users are one long form each: a "create" form at
  the top, then a dropdown to pick the item to edit. A list or table of
  groups and people (with their extension, mode, Transcribe/Chat/Record
  flags) that you click into would be easier to scan and edit.
- A person's keys show as bare arrows and extensions ("→ 2001") with no
  names, and the help text still talks about "Handset A/B/Speaker" from
  the turret days.
- A group page ends in a "Start" button and member checkboxes left over
  from the old endpoint-driven group calls, which mean nothing for browser
  users.
- Settings, Health, Audit and Database are serviceable, but Audit can only be
  filtered by entity type and actor (no dates or actions), and Health mixes host stats,
  tables and logs on one long page.
- Same look as the client (themes, cards) rather than its own older style.

**Read chat messages aloud (mocked; decisions made)**
Optional text-to-voice for incoming chat messages, switched on per group
in the client (Chris, 2026-11-03). Mocked on the "Parley Read Aloud"
design canvas: a Read aloud toggle on the group's Conversation header, a
"Read aloud" tag on the card while it's on, settings (voice, speed,
volume, say who sent it, turn group audio down while reading, wait while
I'm talking, say which group) in the profile menu, and a speaker button in
the phone's conversation sheet. Decided:
- **Only joined groups, and only where it's switched on.** The toggle can
  be set on any group, but messages are read only while you're in it.
  Never your own messages.
- **The setting follows the person**, stored on the server per group
  button like favourites, not per device.
- **Voice:** start with the browser's own `speechSynthesis` (no server,
  works on iPads; voices differ by device). Server-side Piper later if a
  consistent voice matters. Played to this listener only, never into the
  group.
- **Clashes:** queue messages rather than overlap them, turn that group's
  audio down while one is read, and hold them while you're holding Push To
  Talk; Skip and Stop while a queue is waiting.
Still to settle: **echo.** On open mic with speakers the read-out could go
back into the mic, into the group and its transcript. The browser's echo
cancellation may not cover OS speech synthesis; test on real devices, and
if needed mute the mic while reading on open mic, or play server-made audio
through the page so echo cancellation can see it.

**Client UI (mock first)**
- **Keyboard hotkeys** (from Eyevinn), if wanted: per-group push-to-talk
  and mute, answer/hang up the intercom, a global mute. Mainly for desk
  operators with busy hands, and for foot pedals / Stream Deck, which send
  key presses. Mocked (design canvas, options H1-H3); not chosen yet.
- **Input/output device selection** (`setSinkId`, `getUserMedia` device
  ids): per device or per slot (e.g. a group to a speaker, the intercom to
  a headset), and where it lives (profile menu or per card).
- Saved **presets** (a set of groups to join in one go), and Stream Deck
  control via Bitfocus Companion (both from Eyevinn).

**Needs working through**
- **Admin remote mute**, kept separate from self-mute (Eyevinn's
  `effectiveMuted = adminMuted || selfMuted`). Today PTT/mute happens only
  in the browser, on purpose (see CLAUDE.md), so a remote mute needs a
  server-side path: FreeSWITCH conference control (ESL) or rtpengine
  blocking the member's media. Also: who may do it, and how the muted
  person is told.
- **Program / audio-feed groups**: listen-only feeds that duck while anyone
  talks in another group. Where the feed comes from (an RTP/SIP source into
  FreeSWITCH?), and whether ducking is done in the browser (simplest: the
  client already knows who's talking) or in the mix.
- **Announce-zone listen-only members** aren't dialled out yet (only
  talkers are).
- **API keys** and **WebSocket live session streaming** (instead of the
  client's 1 s polling).

**To verify on real devices**
- The iPad's home-screen icon, and its reconnect screen after the SIP realm
  change.
- A desk browser to iPad call over HTTPS (the "remote desk" case).
- Several groups joined at once alongside a direct call, PTT press/release,
  and the activity light.

**Related projects**
- Port SIP-REC recording, avatars and live transcription to Open Turret.
- Port the transcription noise and music filtering (`transcriber/src/vad.ts`,
  `pitch.ts`, `segmenter.ts`) back to CallRaven.
- External PBX lines / shared line appearances are **out of scope here**;
  they belong to Open Turret.
