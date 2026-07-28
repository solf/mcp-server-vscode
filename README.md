# MCP Server for VS Code

A VS Code extension that provides a Model Context Protocol (MCP) server, enabling AI assistants to interact with your VS Code environment for language intelligence, debugging, and code execution.

> Fork of [malvex/mcp-server-vscode](https://github.com/malvex/mcp-server-vscode), which is no longer maintained. Published under the `solf` publisher ID so marketplace updates can never overwrite it. See [What this fork changes](#what-this-fork-changes).

## Features

- **Language Intelligence**: Access VS Code's language server features including:

  - Go to definition
  - Find references
  - Diagnostics (errors and warnings)
  - Symbol search
  - Call hierarchy

- **Debugging Support**: Control VS Code's debugger programmatically:

  - Start/stop debug sessions
  - Set and manage breakpoints
  - Step through code (into/over/out)
  - Inspect variables and call stacks
  - Evaluate expressions in debug context

- **Multiple windows at once**: Every window runs its own server on its own port and is discoverable, so several projects can be open and each AI session talks to the right one.

## What this fork changes

- **Per-window routing.** Upstream used one fixed port (8991), so the first window to start claimed it and every client reached that window regardless of which project it was launched from — silently returning correct-looking answers about the wrong codebase. Each window now binds an ephemeral port and publishes itself to a discovery registry; the client resolves the right one, or fails loudly listing what is available.
- **Loopback-only, token-authenticated bridge.** The HTTP API previously listened with wildcard CORS, so any web page you visited could drive your editor. It now binds loopback only, requires a per-start 256-bit token, and rejects any request carrying an `Origin` header.
- **A response contract.** Every tool answers in one envelope (`subject`, `scope`, `status`, `complete`, `reason`, `format`, `results`). An empty result no longer conflates "nothing matched" with "nothing could answer" — the latter is raised as an error instead of returned as data. See [docs/response-contract.md](docs/response-contract.md).
- **No auto-opened editor tabs.** Cold start used to force three arbitrary workspace files open as permanent tabs.

## Installation

Two pieces, and they are separate on purpose: the **extension** runs inside VS Code, and the **client** is a small stdio server your AI tool launches. They talk over a private HTTP API on loopback.

### Step 1: Install the extension

Download `mcp-server-vscode-0.3.0.vsix` from [Releases](https://github.com/solf/mcp-server-vscode/releases), then:

```bash
code --install-extension mcp-server-vscode-0.3.0.vsix
# Cursor:
cursor --install-extension mcp-server-vscode-0.3.0.vsix
```

Or in the UI: Extensions → `...` menu → Install from VSIX.

**Reload the window afterwards.** An installed vsix does not take effect until the extension host restarts, so a freshly installed build is not the one running until you reload. Once loaded, the status bar (bottom right) shows the port it bound.

### Step 2: Configure the client

Pick one of the two forms below. Both run the same client; they differ in what happens when the repo moves on.

```bash
# Pinned to a release -- recommended
npx --yes github:solf/mcp-server-vscode#v0.3.0

# Latest master
npx --yes github:solf/mcp-server-vscode
```

**Prefer the pinned form.** The client and the extension speak a private HTTP API with no compatibility guarantee across versions. Pinning the client to the same tag as your installed vsix keeps the two in step; tracking master means an unrelated push can change the client under a vsix you installed weeks ago.

First run compiles from source, so expect it to take a while; later runs are cached.

#### Claude Desktop

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "vscode": {
      "command": "npx",
      "args": ["--yes", "github:solf/mcp-server-vscode#v0.3.0"]
    }
  }
}
```

Restart Claude Desktop afterwards.

#### Claude Code (CLI)

```bash
claude mcp add-json vscode '{"type":"stdio","command":"npx","args":["--yes","github:solf/mcp-server-vscode#v0.3.0"]}' -s user
```

#### Cursor

In `~/.cursor/mcp.json` (or a project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "vscode": {
      "command": "npx",
      "args": ["--yes", "github:solf/mcp-server-vscode#v0.3.0"]
    }
  }
}
```

### Alternative: a local runner directory

If you would rather not hit the network on every start — or you are developing the fork — deploy the client to a standalone directory and point configs at that:

```bash
mkdir /path/to/runner && cd /path/to/runner
npm install @modelcontextprotocol/sdk

# from a clone of this repo:
npm run compile
npm run deploy:client -- /path/to/runner
```

```json
{
  "mcpServers": {
    "vscode": {
      "command": "node",
      "args": ["/path/to/runner/standalone-server.js"]
    }
  }
}
```

This deliberately copies rather than pointing at the repo's `out/`: otherwise a half-finished refactor, an older checkout, or an `npm ci` (which deletes `node_modules`) would take MCP down in every open window.

### Optional environment variables

| Variable | Effect |
|---|---|
| `VSCODE_BRIDGE_PORT` | Force the client at one specific window, bypassing discovery. |
| `VSCODE_TOOL_ALLOW` | Comma-separated allowlist of tool names; everything else is hidden and refused. |

## Usage

The server starts automatically when a window opens (`vscode-mcp.autoStart`, default on) and shows its status in the VS Code status bar (bottom right).

The status bar indicates:
- **VS Code MCP: 51877** - running, on the port it bound
- **VS Code MCP: Stopped** - not running

Click the status bar item to toggle the server on/off.

Each window binds its **own** port, chosen by the OS. Set `vscode-mcp.port` to a fixed number only if you need one — startup then fails outright if that port is taken, rather than quietly moving to another and answering for the wrong window.

### How It Works

```
┌─────────────┐     stdio      ┌──────────────────┐     HTTP       ┌─────────────┐
│   Claude /  │ ◄────────────► │  MCP Standalone  │ ◄────────────► │   VS Code   │
│   Cursor    │                │  Server (client) │  127.0.0.1     │  Extension  │
└─────────────┘                └────────┬─────────┘  ephemeral     └──────┬──────┘
                                        │              + token            │
                                        │                                 │
                                        │   ~/.vscode-mcp/instances/*.json│
                                        └────────────◄────────────────────┘
                                              discovery registry
```

1. **The extension** binds a loopback port per window and publishes `{pid, port, token, folders, version}` to the registry.
2. **The client** resolves which window it belongs to — `VSCODE_BRIDGE_PORT`, else the VS Code process that launched it, else a workspace-folder match — and fails loudly, listing live windows, if it cannot tell.
3. **Your AI tool** talks to the client over stdio.

Every tool response carries a `scope` field naming the window that answered, so a misroute is visible rather than silent.

### Troubleshooting

If your AI tool can't connect to VS Code:

1. **Check the extension is running** — the status bar should show a port, not "Stopped".
2. **Check which window answered** — the `scope` field in any tool response names it. If it's the wrong project, the client resolved to another window; set `VSCODE_BRIDGE_PORT` to the port shown in the intended window's status bar.
3. **Test the client directly**: run `npx --yes github:solf/mcp-server-vscode` in a terminal. It prints which window it connected to and the build timestamp, then waits on stdio.
4. **Check the build actually loaded** — installing a vsix does not load it. Reload the window and compare the build time the client prints against what you packaged.
5. **Start it manually** if autostart is off: Cmd/Ctrl+Shift+P → "Start MCP Server".

Empty results are not a connection problem: a tool that cannot answer now says so as an error. An empty `results` with `status: "ok"` means the language server genuinely found nothing.

### Available Tools

The extension provides 25 tools organized into three main categories:

#### Language Intelligence Tools (7 tools)

| Tool | Description | Main Parameters | Example |
|------|-------------|-----------------|---------|
| **hover** | Get hover information (type info, documentation) for a symbol by name | `symbol` (required), `uri` (optional), `format` (optional) | `hover({ symbol: "calculateSum" })` |
| **definition** | Find where a symbol is defined. Instantly jumps to declarations | `symbol` (required), `format` (optional) | `definition({ symbol: "Calculator" })` |
| **references** | Find all references to a symbol. Superior to grep - finds semantic references | `symbol` (required), `includeDeclaration` (optional), `format` (optional) | `references({ symbol: "process" })` |
| **callHierarchy** | Analyze what calls a function or what a function calls | `symbol` (required), `direction` (required: 'incoming'\|'outgoing'\|'both'), `uri` (optional), `format` (optional) | `callHierarchy({ symbol: "initialize", direction: "incoming" })` |
| **symbolSearch** | Search for symbols (classes, functions, variables) across the workspace | `query` (required), `kind` (optional), `format` (optional) | `symbolSearch({ query: "Controller", kind: "class" })` |
| **workspaceSymbols** | Get a complete map of all symbols in the workspace | `includeDetails` (optional), `filePattern` (optional), `maxFiles` (optional), `format` (optional) | `workspaceSymbols({ filePattern: "**/*.ts" })` |
| **diagnostics** | Get all errors and warnings for a file or workspace | `uri` (optional), `format` (optional) | `diagnostics({})` |

#### Refactoring Tools (1 tool)

| Tool | Description | Main Parameters | Example |
|------|-------------|-----------------|---------|
| **refactor_rename** | Rename a symbol across all files. Automatically updates all references and imports | `symbol` (required), `newName` (required), `uri` (optional), `format` (optional) | `refactor_rename({ symbol: "OldName", newName: "NewName" })` |

#### Debug Tools (17 tools)

##### Breakpoint Management

| Tool | Description | Main Parameters | Example |
|------|-------------|-----------------|---------|
| **debug_setBreakpoint** | Set breakpoints by symbol name or file/line with optional conditions | `symbol` OR (`file` AND `line`), `condition` (optional), `hitCondition` (optional), `logMessage` (optional), `format` (optional) | `debug_setBreakpoint({ symbol: "processData", condition: "items.length > 100" })` |
| **debug_toggleBreakpoint** | Toggle a breakpoint on/off at a specific location | `symbol` OR (`file` AND `line`), `format` (optional) | `debug_toggleBreakpoint({ file: "app.js", line: 25 })` |
| **debug_listBreakpoints** | List all breakpoints in the workspace | `format` (optional) | `debug_listBreakpoints({})` |
| **debug_clearBreakpoints** | Clear all breakpoints from the workspace | `format` (optional) | `debug_clearBreakpoints({})` |

##### Session Management

| Tool | Description | Main Parameters | Example |
|------|-------------|-----------------|---------|
| **debug_status** | Get current debug session status and active threads | `format` (optional) | `debug_status({})` |
| **debug_listConfigurations** | List available debug configurations from launch.json | `format` (optional) | `debug_listConfigurations({})` |
| **debug_startSession** | Start a debug session using a configuration | `configuration` (optional), `format` (optional) | `debug_startSession({ configuration: "Launch Program" })` |
| **debug_stopSession** | Stop the active debug session | `format` (optional) | `debug_stopSession({})` |

##### Runtime Control

| Tool | Description | Main Parameters | Example |
|------|-------------|-----------------|---------|
| **debug_pauseExecution** | Pause the running program | `threadId` (optional), `format` (optional) | `debug_pauseExecution({})` |
| **debug_continueExecution** | Continue execution from current breakpoint | `threadId` (optional), `allThreads` (optional), `format` (optional) | `debug_continueExecution({})` |
| **debug_stepOver** | Step over the current line of code | `threadId` (optional), `format` (optional) | `debug_stepOver({})` |
| **debug_stepInto** | Step into the function call at current line | `threadId` (optional), `format` (optional) | `debug_stepInto({})` |
| **debug_stepOut** | Step out of the current function | `threadId` (optional), `format` (optional) | `debug_stepOut({})` |

##### Inspection and Evaluation

| Tool | Description | Main Parameters | Example |
|------|-------------|-----------------|---------|
| **debug_getCallStack** | Get the current call stack with source locations | `threadId` (optional), `startFrame` (optional), `levels` (optional), `format` (optional) | `debug_getCallStack({ levels: 10 })` |
| **debug_inspectVariables** | Inspect variables in the current scope during debugging | `threadId` (optional), `frameId` (optional), `scope` (optional: 'all'\|'locals'\|'globals'\|'closure'), `filter` (optional), `format` (optional) | `debug_inspectVariables({ scope: "locals" })` |
| **debug_evaluateExpression** | Evaluate an expression in the debug context | `expression` (required), `frameId` (optional), `context` (optional), `format` (optional) | `debug_evaluateExpression({ expression: "user.permissions" })` |
| **debug_getOutput** | Get debug console output | `category` (optional), `filter` (optional), `limit` (optional), `format` (optional) | `debug_getOutput({})` |

### Tool Features

All tools support:

- **Compact format** - Optimized for AI token efficiency
- **Detailed format** - Full data for complex analysis
- **Symbol-based navigation** - Work with names instead of file/line numbers
- **Workspace-wide operations** - Not limited to single files
- **Language server integration** - Accurate semantic understanding

### Usage Examples for AI Assistants

When connected via MCP, AI assistants can use these tools to help users with development tasks:

#### Finding and Understanding Code

```
User: "What does the handleRequest function do?"
AI uses: hover({ symbol: "handleRequest" })
→ Gets type signature and documentation without reading entire files

User: "Where is the DatabaseConnection class defined?"
AI uses: definition({ symbol: "DatabaseConnection" })
→ Instantly finds the file and line where it's declared

User: "Show me all places where processPayment is called"
AI uses: callHierarchy({ symbol: "processPayment", direction: "incoming" })
→ Gets complete list of callers with their locations
```

#### Refactoring

```
User: "Rename the oldMethodName method to newMethodName everywhere"
AI uses: refactor_rename({ symbol: "oldMethodName", newName: "newMethodName" })
→ Safely renames across all files, updating imports and references
```

#### Debugging

```
User: "Help me debug why the server crashes"
AI uses: debug_listConfigurations({})
→ Shows available debug configurations

AI uses: debug_startSession({ configuration: "Debug Server" })
→ Starts the debug session

User: "Set a breakpoint where errors are handled"
AI uses: debug_setBreakpoint({ symbol: "handleError" })
→ Sets breakpoint on the function

User: "What's the value of the user object here?"
AI uses: debug_inspectVariables({ scope: "locals", filter: "user" })
→ Shows current value of user variable in debug context

User: "Why is this condition true?"
AI uses: debug_evaluateExpression({ expression: "users.length > 0 && isActive" })
→ Evaluates the expression in current debug scope
```

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/solf/mcp-server-vscode.git
cd mcp-server-vscode

# Install dependencies
npm install

# Compile, then package the extension
npm run compile
npm run package        # -> mcp-server-vscode-<version>.vsix
```

`npm run package` passes `--no-dependencies`, which keeps `node_modules` out of the vsix (~79 KB instead of ~5.7 MB). `.vscodeignore` cannot exclude `node_modules` — only that flag can. The client is deployed separately, so the extension never needs them bundled.

Run the tests with `npm test`. This downloads and launches a real VS Code via `@vscode/test-electron`, so it needs a machine that can run one.

### Testing Local Changes

To test your local development version:

1. **VS Code Extension**: Press F5 in VS Code to launch Extension Development Host
2. **MCP Server**: Update Claude config to use local path:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "node",
      "args": ["/path/to/mcp-server-vscode/out/mcp/standalone-server.js"]
    }
  }
}
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
