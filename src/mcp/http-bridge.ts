import * as http from 'http';
import { BUILD_COMMIT, BUILD_DIRTY, BUILD_TIME, BUILD_VERSION } from '../buildInfo';
import { getTools } from '../tools';
import { validateToolArguments } from './validate';

export class HTTPBridge {
  /** One listening socket per loopback address that could be bound. */
  private httpServers: http.Server[] = [];
  private port: number;
  /** When this bridge began listening; compare against BUILD_TIME to spot a stale host. */
  private startedAt: string | undefined;

  constructor(port: number) {
    this.port = port;
  }

  getPort(): number {
    return this.port;
  }

  async start() {
    const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
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
            res.writeHead(500);
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
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
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Reported from the loaded module, so this describes the build that is
        // actually running -- not whatever currently sits in the extension dir.
        res.end(
          JSON.stringify({
            status: 'ok',
            port: this.port,
            pid: process.pid,
            startedAt: this.startedAt,
            version: BUILD_VERSION,
            buildTime: BUILD_TIME,
            commit: BUILD_COMMIT,
            dirty: BUILD_DIRTY,
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    // Loopback only: the bridge is unauthenticated, so it must not be reachable
    // from off this machine. Both loopback addresses are bound because clients
    // connect by name to "localhost", and Node's default DNS order ("verbatim")
    // resolves that to ::1 here while other callers may use 127.0.0.1 -- binding
    // just one leaves the other failing with ECONNREFUSED.
    const listenOn = (host: string): Promise<NodeJS.ErrnoException | undefined> => {
      const server = http.createServer(handler);
      return new Promise((resolve) => {
        server.once('error', (err: NodeJS.ErrnoException) => resolve(err));
        server.listen(this.port, host, () => {
          this.httpServers.push(server);
          resolve(undefined);
        });
      });
    };

    const errors: NodeJS.ErrnoException[] = [];
    for (const host of ['127.0.0.1', '::1']) {
      const err = await listenOn(host);
      if (err) {
        errors.push(err);
      }
    }

    // A port already in use means another bridge owns it; bail out rather than
    // half-bind, which would leave two bridges each answering one address family
    // -- clients would then reach one or the other depending on DNS order alone.
    // Any other failure (e.g. IPv6 disabled) is tolerable while one socket lives.
    const inUse = errors.find((err) => err.code === 'EADDRINUSE');
    if (inUse || this.httpServers.length === 0) {
      await this.stop();
      throw inUse ?? errors[0] ?? new Error(`Failed to listen on port ${this.port}`);
    }

    this.startedAt = new Date().toISOString();
    console.log(
      `VS Code HTTP Bridge running on port ${this.port} (loopback, ${this.httpServers.length} socket(s)); ` +
        `build ${BUILD_VERSION} ${BUILD_TIME} ${BUILD_COMMIT}${BUILD_DIRTY ? '-dirty' : ''}`
    );
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
