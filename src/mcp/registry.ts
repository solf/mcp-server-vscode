/**
 * Discovery registry for running bridges.
 *
 * Each VS Code / Cursor window runs its own extension host, so each gets its own
 * bridge on its own port. A stdio client therefore cannot assume a fixed port --
 * it has to work out which window it belongs to. This module is the published
 * half of that: every live bridge drops a JSON file here describing itself, and
 * the client picks the matching one.
 *
 * Files are keyed by extension-host pid, which is also the routing key: an MCP
 * client spawned from a window is a descendant of that window's extension host,
 * so walking its parent chain and looking for a pid present here identifies the
 * window exactly -- no path comparison, no naming convention.
 *
 * @author Sergey Olefir
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** One live bridge, as published for clients to discover. */
export interface RegistryEntry {
  /** Extension-host pid. Also the routing key -- see the module comment. */
  pid: number;
  /** Port the bridge is listening on (loopback only). */
  port: number;
  /** Shared secret; clients must present it on every request. */
  token: string;
  /** First workspace folder, used as the fallback routing key. Null when no folder is open. */
  primaryFolder: string | null;
  /** Every workspace folder, for diagnostics and error messages. */
  allFolders: string[];
  /** Human-readable workspace name, for error messages only -- never routed on. */
  workspaceName: string | null;
  /** When this bridge began listening. */
  startedAt: string;
  version: string;
  buildTime: string;
}

/** Directory holding one JSON file per live bridge. */
export function registryDir(): string {
  return path.join(os.homedir(), '.vscode-mcp', 'instances');
}

function entryPath(pid: number): string {
  return path.join(registryDir(), `${pid}.json`);
}

/** Generates a fresh per-start secret. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Is a process still running? Signal 0 performs the permission/existence check
 * without actually signalling. EPERM means it exists but belongs to someone
 * else, which still counts as alive.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Publishes a bridge. Written to a temporary file and renamed so a client
 * reading concurrently never sees a half-written entry.
 *
 * The entry is supplied whole rather than assembled here, so this module stays
 * free of `vscode` imports -- the stdio client runs outside the extension host
 * and must be able to read the registry using this same code.
 *
 * @throws Error if the entry cannot be written -- callers should surface this,
 *   since an unpublished bridge is invisible to clients
 */
export function publish(entry: RegistryEntry): void {
  fs.mkdirSync(registryDir(), { recursive: true });
  const target = entryPath(entry.pid);
  const temp = `${target}.${entry.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(entry, null, 2), 'utf8');
  fs.renameSync(temp, target);
}

/**
 * Every entry currently published, newest first.
 *
 * A file that is unreadable or malformed is skipped rather than failing the
 * whole read: one bad entry must not hide every healthy window from a client.
 */
export function readAll(): RegistryEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return []; // no registry yet
  }

  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(registryDir(), name), 'utf8'));
      if (
        typeof parsed?.pid === 'number' &&
        typeof parsed?.port === 'number' &&
        typeof parsed?.token === 'string'
      ) {
        entries.push(parsed as RegistryEntry);
      }
    } catch {
      // Malformed or vanished mid-read; ignore it.
    }
  }
  entries.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return entries;
}

/** Removes a specific entry, e.g. one a client found to be unreachable. */
export function removeEntry(pid: number): void {
  try {
    fs.unlinkSync(entryPath(pid));
  } catch {
    // Already gone, or not ours to delete.
  }
}

/** Removes this bridge's entry. Best-effort: a missing entry is not an error. */
export function withdraw(): void {
  try {
    fs.unlinkSync(entryPath(process.pid));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to remove MCP registry entry:', err);
    }
  }
}

/**
 * Drops entries whose extension host is gone -- windows that crashed, or were
 * killed without deactivate() running. Best-effort; a registry we cannot tidy
 * is still usable, because clients health-check before trusting an entry.
 *
 * @return number of stale entries removed
 */
export function pruneStale(): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return 0; // no registry yet
  }

  for (const name of names) {
    // .tmp is included because publish() can die between writing and renaming;
    // such a file never becomes .json, so skipping it would leak forever.
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) {
      continue;
    }
    // Leading digits are the owning pid in both shapes -- "<pid>.json" and
    // "<pid>.json.<pid>.tmp".
    const pid = Number.parseInt(name, 10);
    // An unparseable name is junk we did not write; leave it alone rather than
    // deleting files in a shared directory on a guess.
    if (!Number.isInteger(pid) || pid === process.pid || isAlive(pid)) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(registryDir(), name));
      removed++;
    } catch (err) {
      console.error(`Failed to prune stale MCP registry entry ${name}:`, err);
    }
  }
  return removed;
}
