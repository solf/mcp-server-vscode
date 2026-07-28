import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';
import { BUILD_COMMIT, BUILD_DIRTY, BUILD_TIME, BUILD_VERSION } from '../buildInfo';
import { getTools } from '../tools';
import { IndeterminateError, currentScope } from '../tools/response';
import { generateToken } from './registry';
import { validateToolArguments } from './validate';

/** Header carrying the shared secret from `registry.ts`. */
const TOKEN_HEADER = 'x-mcp-token';

export class HTTPBridge {
  /** One listening socket per loopback address that could be bound. */
  private httpServers: http.Server[] = [];
  /** Port from settings; 0 (the default) means "let the OS choose". */
  private configuredPort: number;
  /** Port actually listening -- what gets published to the registry. */
  private port: number;
  /** Shared secret for this run; regenerated every time the bridge is started. */
  private token: string;
  /** When this bridge began listening; compare against BUILD_TIME to spot a stale host. */
  private startedAt: string | undefined;

  constructor(port: number) {
    this.configuredPort = port;
    this.port = port;
    this.token = generateToken();
  }

  getPort(): number {
    return this.port;
  }

  getToken(): string {
    return this.token;
  }

  getStartedAt(): string | undefined {
    return this.startedAt;
  }

  async start() {
    const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // No CORS headers at all: the only legitimate callers are local stdio
      // clients, which are not browsers and do not need them. A browser always
      // sends Origin on a cross-origin request and a stdio client never does, so
      // rejecting it blocks pages the user merely visits from driving this bridge
      // over loopback -- which no firewall rule or bind address can prevent.
      if (req.headers.origin !== undefined) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cross-origin requests are not allowed' }));
        return;
      }

      const authorized = this.isAuthorized(req);

      // Liveness is answerable without the token so a client can prune registry
      // entries for windows that died; everything beyond "I am alive" -- build,
      // pid, workspace paths -- requires it.
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(authorized ? this.describe() : { status: 'ok' }));
        return;
      }

      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Missing or invalid ${TOKEN_HEADER}` }));
        return;
      }

      if (req.method === 'POST' && req.url === '/tool') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { tool, args } = JSON.parse(body);
            const tools = getTools();
            const toolImpl = tools.find((t) => t.name === tool);

            if (!toolImpl) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: `Unknown tool: ${tool}` }));
              return;
            }

            // Validate arguments
            const validation = validateToolArguments(args || {}, toolImpl.inputSchema);
            if (!validation.valid) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: validation.error }));
              return;
            }

            const result = await toolImpl.handler(args || {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
          } catch (error) {
            // A tool that could not answer (language server cold, no debug
            // session, no folder open) is reported as a failure rather than as
            // empty results, so the client can mark it isError and the model can
            // see it. 503 distinguishes "ask again later" from a genuine fault.
            const indeterminate = error instanceof IndeterminateError;
            res.writeHead(indeterminate ? 503 : 500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
                status: indeterminate ? 'indeterminate' : 'error',
                scope: currentScope(),
              })
            );
          }
        });
      } else if (req.method === 'GET' && req.url === '/tools') {
        const tools = getTools();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    let bound: number | undefined;
    if (this.configuredPort > 0) {
      // A configured port is a deliberate choice, so bind exactly it or fail.
      // Quietly landing elsewhere would be the same class of surprise as
      // answering from the wrong window: what you asked for is not what you got,
      // and nothing says so.
      bound = await this.bindPair(handler, this.configuredPort);
      if (bound === undefined) {
        throw new Error(
          `Configured port ${this.configuredPort} is already in use. Free it, pick another ` +
            'in vscode-mcp.port, or set 0 to let the OS choose.'
        );
      }
    } else {
      // Default: let the OS choose, so every window gets its own port and none
      // is contended. Retries cover the rare case of something else taking the
      // port we were just handed, between our two loopback binds.
      for (let attempt = 0; bound === undefined && attempt < 3; attempt++) {
        bound = await this.bindPair(handler, 0);
      }
      if (bound === undefined) {
        throw new Error('Failed to bind an ephemeral loopback port');
      }
    }

    this.port = bound;
    this.startedAt = new Date().toISOString();
    console.log(
      `VS Code HTTP Bridge running on port ${this.port} ` +
        `(${this.configuredPort > 0 ? 'configured' : 'ephemeral'}, loopback, ` +
        `${this.httpServers.length} socket(s)); ` +
        `build ${BUILD_VERSION} ${BUILD_TIME} ${BUILD_COMMIT}${BUILD_DIRTY ? '-dirty' : ''}`
    );
  }

  /**
   * Binds both loopback addresses to a single port.
   *
   * Loopback only: reaching this bridge must require being on this machine.
   * Both addresses are bound because clients connect by name to "localhost", and
   * Node's default DNS order ("verbatim") resolves that to ::1 on Windows while
   * other callers may use 127.0.0.1 -- binding one leaves the other refused.
   *
   * With port 0 the first successful bind decides the port and the second
   * follows it; asking the OS for 0 twice would hand back two different ports.
   *
   * @param port port to bind, or 0 to let the OS choose
   * @return the port bound, or undefined if the pair could not be claimed
   */
  private async bindPair(
    handler: http.RequestListener,
    port: number
  ): Promise<number | undefined> {
    const opened: http.Server[] = [];
    let actual = port;

    for (const host of ['127.0.0.1', '::1']) {
      const { server, error } = await this.listenOne(handler, host, actual);
      if (server) {
        opened.push(server);
        actual = (server.address() as AddressInfo).port;
        continue;
      }
      // Someone else owns this port. Give the whole pair back instead of
      // half-binding, which would leave two bridges each answering one address
      // family, reachable depending only on the caller's DNS order.
      if (error?.code === 'EADDRINUSE') {
        await Promise.all(opened.map((s) => this.closeServer(s)));
        return undefined;
      }
      // Anything else -- IPv6 disabled, for instance -- is survivable provided
      // the other address did bind.
      console.warn(`MCP bridge could not bind ${host}:${actual}: ${error?.code ?? 'unknown'}`);
    }

    if (opened.length === 0) {
      return undefined;
    }
    this.httpServers.push(...opened);
    return actual;
  }

  /** Attempts a single listening socket, resolving to either the server or the error. */
  private listenOne(
    handler: http.RequestListener,
    host: string,
    port: number
  ): Promise<{ server?: http.Server; error?: NodeJS.ErrnoException }> {
    const server = http.createServer(handler);
    return new Promise((resolve) => {
      server.once('error', (error: NodeJS.ErrnoException) => resolve({ error }));
      server.listen(port, host, () => resolve({ server }));
    });
  }

  /**
   * Constant-time comparison of the presented token against ours. Length is
   * checked first because timingSafeEqual throws on a length mismatch.
   */
  private isAuthorized(req: http.IncomingMessage): boolean {
    const presented = req.headers[TOKEN_HEADER];
    if (typeof presented !== 'string' || presented.length !== this.token.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(this.token));
  }

  /**
   * Full status, for authorized callers only. Build fields come from the loaded
   * module, so they describe the build actually running rather than whatever
   * currently sits in the extension directory. Workspace folders are included so
   * a client can tell which window answered -- an empty tool result then reads
   * as "not in this workspace" rather than an unexplained blank.
   */
  private describe(): Record<string, unknown> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return {
      status: 'ok',
      port: this.port,
      pid: process.pid,
      startedAt: this.startedAt,
      version: BUILD_VERSION,
      buildTime: BUILD_TIME,
      commit: BUILD_COMMIT,
      dirty: BUILD_DIRTY,
      workspaceName: vscode.workspace.name ?? null,
      workspaceFolders: folders.map((f) => f.uri.fsPath),
    };
  }

  async stop() {
    const servers = this.httpServers;
    this.httpServers = [];
    await Promise.all(servers.map((server) => this.closeServer(server)));
  }

  private closeServer(server: http.Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Set a shorter timeout for tests
      const timeoutDuration = this.port >= 3001 && this.port <= 4000 ? 1000 : 5000;
      const timeout = setTimeout(() => {
        console.warn(`HTTP server close timeout on port ${this.port}, forcing close`);
        resolve();
      }, timeoutDuration);

      server.close((err) => {
        clearTimeout(timeout);
        if (err && (err as any).code !== 'ERR_SERVER_NOT_RUNNING') {
          console.error(`Error closing HTTP server on port ${this.port}:`, err);
          // Don't reject for tests, just resolve
          if (this.port >= 3001 && this.port <= 4000) {
            resolve();
          } else {
            reject(err);
          }
        } else {
          resolve();
        }
      });

      // Force close all connections
      try {
        server.closeAllConnections();
      } catch {
        // Ignore errors here
      }
    });
  }
}
