// src/digestAuth.ts -SIP digest auth (RFC 2617/3261) for REGISTER and
// INVITE. Closes two real holes: without this, anyone reachable on pbx-
// core's SIP ports could REGISTER as any extension (no credential check at
// all), and separately, an INVITE's `From` header was never checked against
// anything -a caller could claim to be any extension regardless of whether
// they'd ever authenticated. See CLAUDE.md's status entry for how both were
// found and why REGISTER-only auth isn't enough on its own.
//
// In-dialog requests (re-INVITE, BYE) are deliberately NOT re-challenged
// here -that's normal SIP behaviour (see reinvite.ts): once a dialog is
// established via an authenticated initial transaction, subsequent requests
// within it are authorised implicitly by knowing the dialog's own tags/
// Call-ID, not by re-proving identity every time. Only REGISTER and initial
// INVITE go through requireDigestAuth.
import crypto from 'crypto';
import { config } from './config';
import { getHa1 } from './db';

const REALM = config.sipRealm;
const NONCE_TTL_MS = 5 * 60 * 1000; // comfortably longer than a REGISTER refresh cycle

interface NonceEntry { createdAt: number; lastNc: number; }
const nonces = new Map<string, NonceEntry>();

function sweepNonces(): void {
  const now = Date.now();
  for (const [n, e] of nonces) if (now - e.createdAt > NONCE_TTL_MS) nonces.delete(n);
}

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

/** Parses a `Digest key1="val1", key2=val2, ...` header value (quoted or
 * bare tokens -algorithm/qop/nc are conventionally sent unquoted). */
function parseDigestHeader(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = value.replace(/^Digest\s+/i, '');
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

interface ChallengeOpts {
  status: 401 | 407;
  headerName: 'WWW-Authenticate' | 'Proxy-Authenticate';
  stale?: boolean;
}

function sendChallenge(res: any, opts: ChallengeOpts): void {
  sweepNonces();
  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.set(nonce, { createdAt: Date.now(), lastNc: 0 });
  const staleParam = opts.stale ? ', stale=true' : '';
  res.send(opts.status, {
    headers: {
      [opts.headerName]: `Digest realm="${REALM}", nonce="${nonce}", algorithm=MD5, qop="auth"${staleParam}`,
    },
  });
}

/**
 * Challenges and verifies SIP digest auth for one request. `mode` picks the
 * RFC-correct challenge type: REGISTER uses 401/WWW-Authenticate against
 * the `Authorization` header (this UA's own credentials); anything else
 * (INVITE) uses 407/Proxy-Authenticate against `Proxy-Authorization` (a
 * downstream/proxied request) -same distinction JsSIP itself expects and
 * handles automatically without any special config on the client side.
 *
 * Returns the authenticated extension (lowercased) on success. On failure
 * it has already sent the appropriate response (401/407 challenge, or 403
 * on a bad/replayed/unknown credential) -callers should just `return`.
 */
export async function requireDigestAuth(req: any, res: any, mode: 'REGISTER' | 'INVITE'): Promise<string | null> {
  const isRegister = mode === 'REGISTER';
  const reqHeader = isRegister ? 'Authorization' : 'Proxy-Authorization';
  const challenge: ChallengeOpts = isRegister
    ? { status: 401, headerName: 'WWW-Authenticate' }
    : { status: 407, headerName: 'Proxy-Authenticate' };

  const raw = req.get(reqHeader);
  if (!raw) { sendChallenge(res, challenge); return null; }

  const p = parseDigestHeader(raw);
  const { username, realm, nonce, uri, response, qop, nc, cnonce } = p;
  if (!username || !nonce || !response || !uri || qop !== 'auth' || !nc || !cnonce) {
    res.send(403, 'Malformed Authorization header');
    return null;
  }
  if (realm !== REALM) { res.send(403, 'Unknown realm'); return null; }

  const entry = nonces.get(nonce);
  if (!entry) { sendChallenge(res, { ...challenge, stale: true }); return null; } // expired/unknown -silently retryable by the client, no re-prompt for credentials
  const ncNum = parseInt(nc, 16);
  if (!Number.isFinite(ncNum) || ncNum <= entry.lastNc) {
    nonces.delete(nonce); // replay attempt (or garbage nc) -burn the nonce rather than allow retrying it
    res.send(403, 'Invalid nonce count');
    return null;
  }

  const extension = username.toLowerCase();
  const ha1 = await getHa1(extension);
  if (!ha1) { res.send(403, 'Forbidden'); return null; } // unknown/disabled extension or no SIP credential set -same response as a bad password, to avoid distinguishing "exists" from "doesn't"

  const ha2 = md5(`${req.method}:${uri}`);
  const expected = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  if (expected !== response.toLowerCase()) { res.send(403, 'Forbidden'); return null; }

  entry.lastNc = ncNum; // accept, and require strictly-increasing nc on this nonce's next use
  return extension;
}
