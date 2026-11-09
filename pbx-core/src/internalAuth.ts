// Shared-secret check for the internal HTTP surfaces (pbx-core /status, the
// transcriber's /talking and /poke). They bind every interface because they
// run on host networking and controller-backend (bridged) can't reach a
// loopback bind under WSL, so a bearer token keeps them off the LAN.
// Kept in step with transcriber/src/internalAuth.ts (separate deployables).
import { timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';

export function requiredSecret(name: string, minLength: number): string {
  const v = process.env[name] || '';
  if (!v || v === 'cymru' || v.length < minLength) {
    console.error(`FATAL: ${name} must be set in .env to a random value of at least ${minLength} characters`);
    process.exit(1);
  }
  return v;
}

export function hasBearer(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
