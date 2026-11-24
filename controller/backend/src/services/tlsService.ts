// src/services/tlsService.ts
// Your own HTTPS certificate (#32). An admin uploads a certificate (with its
// chain) and private key in Settings; they're checked here and written to
// the parley-tls-custom volume, which controller-frontend reads: its
// entrypoint serves them instead of the local CA's certificate and reloads
// nginx within about 10 seconds. Removing them goes back to the local CA's.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import { createError } from '../middleware/errorHandler';

const DIR = process.env.TLS_CUSTOM_DIR || '/var/lib/parley/tls-custom';
const FRONTEND = process.env.TLS_FRONTEND_HOST || 'controller-frontend';

export interface CertInfo {
  subject: string; issuer: string; names: string[];
  valid_from: string; valid_to: string; fingerprint256: string; self_issued: boolean;
}

/** "CN=a\nO=b" as "CN=a, O=b", without Node's escaping of commas. */
const dn = (d: string) => d.split('\n').map((p) => p.replace(/\\(.)/g, '$1')).join(', ');

function info(c: crypto.X509Certificate): CertInfo {
  return {
    subject: dn(c.subject), issuer: dn(c.issuer),
    names: (c.subjectAltName ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    valid_from: new Date(c.validFrom).toISOString(), valid_to: new Date(c.validTo).toISOString(),
    fingerprint256: c.fingerprint256, self_issued: c.subject === c.issuer,
  };
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Checks the pair and returns the leaf's details; throws a 400 explaining
 * what's wrong. */
export function checkPair(certPem: string, keyPem: string): { leaf: CertInfo; chain: number; cert: string; key: string } {
  const certs = (certPem ?? '').match(PEM_CERT) ?? [];
  if (!certs.length) throw createError('That isn\'t a PEM certificate (it should start with -----BEGIN CERTIFICATE-----)', 400);
  let leaf: crypto.X509Certificate;
  try { leaf = new crypto.X509Certificate(certs[0]!); } catch { throw createError('The certificate can\'t be read', 400); }
  if (/ENCRYPTED/.test(keyPem ?? '')) throw createError('The private key has a passphrase; nginx needs it without one', 400);
  let key: crypto.KeyObject;
  try { key = crypto.createPrivateKey(keyPem ?? ''); } catch { throw createError('That isn\'t a PEM private key', 400); }
  if (!leaf.checkPrivateKey(key)) {
    const later = certs.slice(1).some((c) => { try { return new crypto.X509Certificate(c).checkPrivateKey(key); } catch { return false; } });
    throw createError(later ? 'The server certificate has to come first in the file, then its chain'
      : 'The private key doesn\'t belong to this certificate', 400);
  }
  const now = Date.now();
  if (new Date(leaf.validFrom).getTime() > now) throw createError(`The certificate isn't valid until ${leaf.validFrom}`, 400);
  if (new Date(leaf.validTo).getTime() <= now) throw createError(`The certificate expired on ${leaf.validTo}`, 400);
  if (leaf.ca) throw createError('That\'s a CA certificate; upload the server certificate first, then its chain', 400);
  // Intermediates must each be signed by the next one, starting from the leaf.
  for (let i = 1; i < certs.length; i++) {
    let c: crypto.X509Certificate;
    try { c = new crypto.X509Certificate(certs[i]!); } catch { throw createError(`Certificate ${i + 1} in the chain can't be read`, 400); }
    const prev = new crypto.X509Certificate(certs[i - 1]!);
    if (!prev.checkIssued(c) || !prev.verify(c.publicKey)) throw createError(`Certificate ${i + 1} in the chain didn't issue certificate ${i}; put them in order, server certificate first`, 400);
  }
  return { leaf: info(leaf), chain: certs.length - 1, cert: certs.join('\n') + '\n', key: key.export({ type: 'pkcs8', format: 'pem' }) as string };
}

function writeAtomic(file: string, data: string, mode: number) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function install(certPem: string, keyPem: string): CertInfo {
  const p = checkPair(certPem, keyPem);
  fs.mkdirSync(DIR, { recursive: true });
  // Key first: the frontend only switches once both are there and match.
  writeAtomic(path.join(DIR, 'key.pem'), p.key, 0o600);
  writeAtomic(path.join(DIR, 'cert.pem'), p.cert, 0o644);
  return p.leaf;
}

export function remove(): void {
  for (const f of ['cert.pem', 'key.pem']) fs.rmSync(path.join(DIR, f), { force: true });
}

/** The uploaded certificate, if there is one. */
export function uploaded(): CertInfo | null {
  try { return info(new crypto.X509Certificate(fs.readFileSync(path.join(DIR, 'cert.pem')))); } catch { return null; }
}

/** The certificate nginx is serving right now, read over TLS. */
export function serving(): Promise<CertInfo | null> {
  return new Promise((resolve) => {
    const s = tls.connect({ host: FRONTEND, port: 443, servername: 'localhost', rejectUnauthorized: false, timeout: 5000 }, () => {
      const raw = s.getPeerX509Certificate();
      s.end();
      resolve(raw ? info(raw) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}
