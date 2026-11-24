// src/services/encryption.ts
// Backups and archives encrypted at rest (#33). When Settings has a backup
// public key (an age recipient, "age1…"), every database backup, Backups
// archive and transcript/chat archive is encrypted to it before it's
// downloaded or written anywhere. The server only ever has the public key,
// so it can make these files but can't read them back: whoever takes over
// the server, or copies the files, gets nothing readable. Decrypt with the
// matching private key, kept off the server: `age -d -i key.txt file.age`.
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { createError } from '../middleware/errorHandler';

const execFileAsync = promisify(execFile);

/** age's X25519 recipients: "age1" + 58 bech32 characters. */
const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

export function checkRecipient(r: string): void {
  if (!RECIPIENT.test(r)) throw createError('That isn\'t an age public key (it starts with age1 and is 62 characters)', 400);
  try { execFileSync('age', ['-r', r], { input: 'test', stdio: ['pipe', 'ignore', 'pipe'] }); }
  catch (e) { throw createError(`age refused that key: ${String((e as { stderr?: Buffer }).stderr ?? '').trim() || (e as Error).message}`, 400); }
}

/** Encrypts `file` to `recipient` as `file.age`, removes the plaintext and
 * returns the new path; with no recipient, returns `file` unchanged. */
export async function encryptFile(file: string, recipient: string | null): Promise<string> {
  if (!recipient) return file;
  const out = `${file}.age`;
  try {
    await execFileAsync('age', ['-r', recipient, '-o', out, file], { timeout: 300_000 });
  } finally {
    fs.rmSync(file, { force: true });
  }
  return out;
}
