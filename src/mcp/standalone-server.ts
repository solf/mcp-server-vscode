#!/usr/bin/env node
/*
 * Stdio MCP client: speaks MCP to Claude / Cursor over stdin+stdout and relays
 * to the HTTP bridge inside the VS Code / Cursor window this client belongs to.
 *
 * Which window that is comes from ./resolve -- see the reasoning there. The
 * short version: every window runs its own bridge, so connecting to a fixed port
 * answers from an arbitrary workspace without ever saying so.
 *
 * Environment:
 *   VSCODE_BRIDGE_PORT  force a specific window's port; its token still comes
 *                       from the registry, so that window must be publishing
 *   VSCODE_TOOL_ALLOW   comma-separated allowlist; unset or empty exposes every
 *                       tool the bridge offers
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');
import { removeEntry } from './registry';
import { Resolution, ResolutionError, resolveBridge } from './resolve';

const TOKEN_HEADER = 'x-mcp-token';

const overridePort = process.env.VSCODE_BRIDGE_PORT
  ? Number.parseInt(process.env.VSCODE_BRIDGE_PORT, 10)
  : undefined;

const allowedTools = new Set(
  (process.env.VSCODE_TOOL_ALLOW || '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
);

const server = new Server(
  { name: 'vscode-mcp-server', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

/**
 * The window we are currently talking to. Cached because resolving costs a
 * process-table read; dropped on connection failure, so closing and reopening a
 * window heals without restarting this client.
 */
let current: Resolution | undefined;

/** Resolves the target window, reusing the cached answer when there is one. */
function target(): Resolution {
  if (!current) {
    current = resolveBridge(overridePort);
    console.error(
      `Bridge: pid ${current.entry.pid} port ${current.entry.port} ` +
        `(${current.entry.workspaceName ?? 'no workspace'}) ` +
        `via ${current.method} -- ${current.detail}`
    );
  }
  return current;
}

function request(
  entry: { port: number; token: string },
  endpoint: string,
  method: string,
  body?: unknown
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: entry.port,
        path: endpoint,
        method,
        headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: entry.token },
      },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(`Bridge rejected this client (HTTP ${res.statusCode}): ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }
    );
    req.on('error', (error: any) => reject(error));
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Calls the bridge, re-resolving once if it proves unreachable. A window that
 * was closed and reopened has a new pid and port, so the stale entry is dropped
 * before retrying rather than being chosen again.
 */
async function callBridge(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const resolution = target();
    try {
      return await request(resolution.entry, endpoint, method, body);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const unreachable =
        code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH';
      if (!unreachable || attempt >= 1) {
        throw error;
      }
      // Nothing is listening there any more, so that window is gone.
      removeEntry(resolution.entry.pid);
      current = undefined;
    }
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const response = await callBridge('/tools');
  const tools = response?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`Bridge returned no tool list: ${JSON.stringify(response)}`);
  }
  if (allowedTools.size === 0) {
    return { tools };
  }
  // An allowlist entry the bridge does not offer is almost certainly a typo;
  // without this it would silently just yield fewer tools.
  const offered = new Set(tools.map((tool: any) => tool.name));
  const unknown = [...allowedTools].filter((name) => !offered.has(name));
  if (unknown.length > 0) {
    console.error(`Warning: VSCODE_TOOL_ALLOW names unknown tool(s): ${unknown.join(', ')}`);
  }
  return { tools: tools.filter((tool: any) => allowedTools.has(tool.name)) };
});

server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
  const { name, arguments: args } = req.params;

  // Enforced here as well as in the tool list: advertising fewer tools does not
  // stop a client asking for one by name.
  if (allowedTools.size > 0 && !allowedTools.has(name)) {
    return { content: [{ type: 'text', text: `Error: tool '${name}' is not enabled` }] };
  }

  try {
    const response = await callBridge('/tool', 'POST', { tool: name, args });
    if (response.error) {
      return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(response.result, null, 2) }] };
  } catch (error) {
    return {
      content: [
        { type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` },
      ],
    };
  }
});

async function main() {
  // Resolve up front so a misconfiguration is reported at startup, in full,
  // rather than surfacing later as an unexplained tool failure.
  try {
    const resolution = target();
    const health = await callBridge('/health');
    console.error(
      `Connected to ${health.workspaceName ?? 'window'} on port ${resolution.entry.port} ` +
        `(build ${health.buildTime ?? 'unknown'})`
    );
  } catch (error) {
    if (error instanceof ResolutionError) {
      console.error(`Cannot determine which window to use:\n${error.message}`);
    } else {
      console.error(
        `VS Code bridge not reachable: ${error instanceof Error ? error.message : error}`
      );
    }
    console.error('Tools will fail until this is resolved; the server will keep running.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('VS Code MCP Server started (stdio transport)');
}

main().catch(console.error);
