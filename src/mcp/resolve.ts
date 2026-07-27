/**
 * Works out which window's bridge this client belongs to.
 *
 * Every VS Code / Cursor window runs its own extension host and therefore its
 * own bridge, so a client that simply connects to a fixed port reaches whichever
 * window happened to claim it -- answering from the wrong workspace with no
 * error, which is worse than failing. This module decides deliberately.
 *
 * Resolution order, most authoritative first:
 *
 *   1. VSCODE_BRIDGE_PORT   explicit override; the operator has decided
 *   2. process ancestry     an MCP client is spawned by the window that wants
 *                           it, so a registered pid among our ancestors names
 *                           that window exactly -- no paths, no naming rules
 *   3. working directory    cwd equals the window's first workspace folder;
 *                           covers clients started outside any IDE, e.g. from
 *                           a terminal, where there is no ancestry to walk
 *
 * If none match, or two match equally, we fail loudly and name the live windows.
 * Guessing here is how you get silently wrong answers.
 *
 * @author Sergey Olefir
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RegistryEntry, readAll } from './registry';

/** How the winning entry was chosen, for logging and error messages. */
export type ResolutionMethod = 'env-override' | 'process-ancestry' | 'working-directory';

export interface Resolution {
  entry: RegistryEntry;
  method: ResolutionMethod;
  /** Human-readable justification, e.g. the matched pid or folder. */
  detail: string;
}

/**
 * Raised when no bridge can be chosen. The message lists every live window so
 * the reader can see what was available and why none of it matched.
 */
export class ResolutionError extends Error {
  constructor(problem: string, entries: RegistryEntry[]) {
    super(`${problem}\n${describeCandidates(entries)}`);
    this.name = 'ResolutionError';
  }
}

function describeCandidates(entries: RegistryEntry[]): string {
  if (entries.length === 0) {
    return (
      'No VS Code / Cursor window is currently publishing an MCP bridge.\n' +
      'Open a window with the extension installed, or check that the MCP server is running ' +
      '(status bar, or the "Start MCP Server" command).'
    );
  }
  const lines = entries.map(
    (e) =>
      `  pid ${e.pid} port ${e.port}  ${e.workspaceName ?? '(no workspace)'}` +
      `  ${e.primaryFolder ?? '(no folder)'}`
  );
  return `Live windows:\n${lines.join('\n')}`;
}

/**
 * Normalises a filesystem path for comparison: case-insensitive on Windows and
 * macOS, consistent separators, no trailing one. Deliberately does NOT resolve
 * symlinks or junctions -- comparison is exact equality against a window's
 * declared folder, so there is nothing to canonicalise against.
 */
function normalizePath(p: string): string {
  let out = p.replace(/[\\/]+/g, path.sep);
  while (out.length > 1 && out.endsWith(path.sep)) {
    out = out.slice(0, -1);
  }
  return process.platform === 'linux' ? out : out.toLowerCase();
}

/**
 * Maps every process to its parent, in a single OS call.
 *
 * Node exposes only `process.ppid`, so walking further needs the OS. This runs
 * once per client start and is cached by the caller, so one spawn is acceptable
 * where a per-request cost would not be.
 *
 * @return child pid -> parent pid, empty when the platform lookup fails
 */
function readParentMap(): Map<number, number> {
  const parents = new Map<number, number>();
  try {
    if (process.platform === 'win32') {
      const csv = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }',
        ],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }
      );
      for (const line of csv.split(/\r?\n/)) {
        const [child, parent] = line.split(',');
        if (child && parent) {
          parents.set(Number.parseInt(child, 10), Number.parseInt(parent, 10));
        }
      }
    } else if (process.platform === 'linux') {
      for (const name of fs.readdirSync('/proc')) {
        const pid = Number.parseInt(name, 10);
        if (!Number.isInteger(pid)) {
          continue;
        }
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          // Field 4 is ppid, but the comm field (2) may contain spaces or
          // brackets, so start parsing after the closing parenthesis.
          const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          parents.set(pid, Number.parseInt(after[1], 10));
        } catch {
          // Process exited while we were reading; skip it.
        }
      }
    } else {
      const out = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 15000 });
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) {
          parents.set(Number.parseInt(m[1], 10), Number.parseInt(m[2], 10));
        }
      }
    }
  } catch {
    // No ancestry available; the caller falls through to the cwd rule.
  }
  return parents;
}

/**
 * Walks up from this process, returning the first ancestor that is publishing a
 * bridge. Nearest ancestor wins, which is correct for nested cases: a client
 * inside window B inside window A belongs to B.
 */
function matchByAncestry(entries: RegistryEntry[]): Resolution | undefined {
  const byPid = new Map(entries.map((e) => [e.pid, e]));
  const parents = readParentMap();

  let current = process.pid;
  // Bounded to avoid spinning on a cycle in a malformed process table.
  for (let hop = 0; hop < 32; hop++) {
    const entry = byPid.get(current);
    if (entry && current !== process.pid) {
      return {
        entry,
        method: 'process-ancestry',
        detail: `ancestor pid ${current} is publishing a bridge`,
      };
    }
    const parent = parents.get(current) ?? (current === process.pid ? process.ppid : undefined);
    if (parent === undefined || parent === 0 || parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

/**
 * Matches this client's working directory against each window's first workspace
 * folder, walking up parent directories so a client started in a subdirectory
 * still resolves. Exact equality at each level -- never a prefix test, which
 * would match `C:\foo` against `C:\foobar`.
 */
function matchByWorkingDirectory(entries: RegistryEntry[]): Resolution | Error | undefined {
  const withFolder = entries.filter((e) => e.primaryFolder);
  if (withFolder.length === 0) {
    return undefined;
  }

  let dir = normalizePath(process.cwd());
  for (;;) {
    const hits = withFolder.filter((e) => normalizePath(e.primaryFolder as string) === dir);
    if (hits.length === 1) {
      return {
        entry: hits[0],
        method: 'working-directory',
        detail: `cwd resolves to workspace folder ${hits[0].primaryFolder}`,
      };
    }
    if (hits.length > 1) {
      // Two windows on the same folder: refuse rather than pick. Set
      // VSCODE_BRIDGE_PORT to say which one is meant.
      return new Error(
        `${hits.length} windows share the workspace folder ${hits[0].primaryFolder}; ` +
          'cannot tell which one is meant. Set VSCODE_BRIDGE_PORT to choose.'
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Chooses the bridge this client should talk to.
 *
 * @param overridePort value of VSCODE_BRIDGE_PORT, if set
 * @throws ResolutionError when no single bridge can be identified
 */
export function resolveBridge(overridePort?: number): Resolution {
  const entries = readAll();

  if (overridePort !== undefined) {
    const entry = entries.find((e) => e.port === overridePort);
    if (!entry) {
      // The port is forced but we still need that window's token, which only
      // the registry carries -- so an unpublished port cannot be used.
      throw new ResolutionError(
        `VSCODE_BRIDGE_PORT=${overridePort} but no window is publishing that port, ` +
          'so its access token is unknown.',
        entries
      );
    }
    return { entry, method: 'env-override', detail: `VSCODE_BRIDGE_PORT=${overridePort}` };
  }

  const byAncestry = matchByAncestry(entries);
  if (byAncestry) {
    return byAncestry;
  }

  const byCwd = matchByWorkingDirectory(entries);
  if (byCwd instanceof Error) {
    throw new ResolutionError(byCwd.message, entries);
  }
  if (byCwd) {
    return byCwd;
  }

  throw new ResolutionError(
    `No bridge matches this client (pid ${process.pid}, cwd ${process.cwd()}). ` +
      'It is not a descendant of any window running a bridge, and its working directory ' +
      'is not a workspace folder of one.',
    entries
  );
}
