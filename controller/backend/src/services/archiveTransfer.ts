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

// SCP servers' host keys, pinned the first time Parley connects to each
// (#30) and checked every time after. On the archives volume so pins survive
// a rebuild; local archives can't write into this folder.
const SSH_DIR = path.join(LOCAL_ARCHIVE_DIR, '.ssh');
export const KNOWN_HOSTS = path.join(SSH_DIR, 'known_hosts');

/** How OpenSSH names a host in known_hosts. */
const hostName = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`);

/** The pinned key fingerprints for host:port ([] if not pinned yet). */
export async function pinnedHostKeys(host: string, port = 22): Promise<string[]> {
  if (!fs.existsSync(KNOWN_HOSTS)) return [];
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-l', '-F', hostName(host, port), '-f', KNOWN_HOSTS]);
    return stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.trim().split(/\s+/).slice(1).join(' '));
  } catch { return []; } // exit 1 = not found
}

/** Forgets host:port's pinned key, so the next transfer pins whatever it finds. */
export async function forgetHostKey(host: string, port = 22): Promise<void> {
  if (!fs.existsSync(KNOWN_HOSTS)) return;
  await execFileAsync('ssh-keygen', ['-R', hostName(host, port), '-f', KNOWN_HOSTS]);
  fs.rmSync(`${KNOWN_HOSTS}.old`, { force: true });
}

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
    if (resolved === SSH_DIR || resolved.startsWith(SSH_DIR + path.sep)) {
      throw new Error('local transfer path can\'t be the .ssh folder');
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
    fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
    const sshOpts = [
      ...(transfer.key_path ? ['-i', transfer.key_path] : ['-o', 'PubkeyAuthentication=no']),
      // Pin the host key on first contact, refuse a different one after.
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HashKnownHosts=no',
      // Never prompt for a password (there's nobody to answer), and give up
      // on an unreachable host quickly.
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    ];
    try {
      await execFileAsync('scp', ['-P', String(port), ...sshOpts, tmpFile, `${transfer.user}@${transfer.host}:${dest}`], { timeout: 120_000 });
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(msg)) {
        throw new Error(`${transfer.host}'s host key isn't the one Parley pinned, so nothing was sent. If the server really was rebuilt, forget its key in Settings.`);
      }
      throw new Error(msg.trim().split('\n').pop() || (e as Error).message);
    }
    return `Transferred via SCP to ${transfer.host}:${dest}`;
  }
  throw new Error(`Transfer type "${transfer.type}" not yet implemented`);
}
