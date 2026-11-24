// src/services/archiveTransfer.ts
// Sending an archive file to its destination: a folder under
// LOCAL_ARCHIVE_DIR (a volume, so it survives restarts) or a remote host by
// SCP. Shared by the Backups archive (routes/admin.ts) and the transcript
// and chat archive (retentionService.ts, #28).
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

// 'local' writes wherever the client's JSON says -sandboxed to this one
// directory so a request can't overwrite arbitrary files in the container.
export const LOCAL_ARCHIVE_DIR = process.env.LOCAL_ARCHIVE_DIR || path.join(os.tmpdir(), 'parley-archives');

export interface Transfer {
  type: 'scp' | 'sftp' | 'ftp' | 'local';
  host?: string; port?: number; user?: string; path: string; key_path?: string;
}

/** Sends tmpFile as `name` (into the transfer's folder when path ends in "/"
 * or for a folder-style path). Returns a description of where it went;
 * throws if it couldn't be sent. */
export async function sendArchive(tmpFile: string, name: string, transfer: Transfer, folder = false): Promise<string> {
  const base = transfer.path;
  const dest = folder || base.endsWith('/') ? `${base.replace(/\/?$/, '/')}${name}` : base;
  if (transfer.type === 'local') {
    // Resolve as a subpath of LOCAL_ARCHIVE_DIR only, however many "../"
    // segments the path tries to smuggle in.
    const resolved = path.resolve(LOCAL_ARCHIVE_DIR, `.${path.sep}${dest}`);
    if (resolved !== LOCAL_ARCHIVE_DIR && !resolved.startsWith(LOCAL_ARCHIVE_DIR + path.sep)) {
      throw new Error('local transfer path must stay within the local archive directory');
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.copyFileSync(tmpFile, resolved);
    return `Copied to ${resolved}`;
  }
  if (transfer.type === 'scp') {
    if (!transfer.host || !transfer.user) throw new Error('scp transfer requires host and user');
    const port = Number(transfer.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('scp transfer port must be an integer between 1 and 65535');
    // execFile, not exec: no client-supplied field can be read as shell syntax.
    const sshOpts = [
      ...(transfer.key_path ? ['-i', transfer.key_path] : ['-o', 'PubkeyAuthentication=no']),
      // Never prompt for a password (there's nobody to answer), and give up
      // on an unreachable host quickly.
      '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    ];
    await execFileAsync('scp', ['-P', String(port), ...sshOpts, tmpFile, `${transfer.user}@${transfer.host}:${dest}`], { timeout: 120_000 });
    return `Transferred via SCP to ${transfer.host}:${dest}`;
  }
  throw new Error(`Transfer type "${transfer.type}" not yet implemented`);
}
