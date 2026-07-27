import * as vscode from 'vscode';
import { BUILD_TIME, BUILD_VERSION } from './buildInfo';
import { HTTPBridge } from './mcp/http-bridge';
import { publish, pruneStale, withdraw } from './mcp/registry';
import { debugOutputTracker } from './services/debugOutputTracker';

let httpBridge: HTTPBridge | undefined;
let mcpServerStatusBar: vscode.StatusBarItem | undefined;

function updateMcpServerStatusBar() {
  if (!mcpServerStatusBar) {
    return;
  }

  if (httpBridge) {
    // The port actually bound, not the configured preference. With the default
    // (ephemeral) those are never the same, and reading the setting made every
    // window claim the same number regardless of what it was really serving.
    const port = httpBridge.getPort();
    mcpServerStatusBar.text = `$(server) VS Code MCP: ${port}`;
    mcpServerStatusBar.tooltip = `VS Code MCP Server is running on port ${port}\nClick to stop`;
    mcpServerStatusBar.backgroundColor = undefined;
  } else {
    mcpServerStatusBar.text = '$(server) VS Code MCP: Stopped';
    mcpServerStatusBar.tooltip = 'VS Code MCP Server is stopped\nClick to start';
    mcpServerStatusBar.backgroundColor = undefined;
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('VS Code MCP Server extension activated');

  // Initialize debug output tracker
  debugOutputTracker.initialize();

  const startServerCommand = vscode.commands.registerCommand('vscode-mcp.startServer', async () => {
    if (httpBridge) {
      return;
    }

    const config = vscode.workspace.getConfiguration('vscode-mcp');
    // 0 means "let the OS choose", which is the default: every window then gets
    // its own port with nothing contended, and clients locate it via the registry.
    const port = config.get<number>('port', 0);

    try {
      // Clear out entries left by windows that died without deactivating, so a
      // client is not offered a bridge that no longer exists.
      pruneStale();

      // Start HTTP bridge for VS Code API access
      httpBridge = new HTTPBridge(port);
      await httpBridge.start();

      // Publishing is what makes this window findable. If it fails the bridge is
      // still usable by anything that knows the port, so keep serving -- but say
      // so loudly, because clients relying on discovery will not find us.
      try {
        const folders = vscode.workspace.workspaceFolders ?? [];
        publish({
          pid: process.pid,
          port: httpBridge.getPort(),
          token: httpBridge.getToken(),
          primaryFolder: folders.length > 0 ? folders[0].uri.fsPath : null,
          allFolders: folders.map((f) => f.uri.fsPath),
          workspaceName: vscode.workspace.name ?? null,
          startedAt: httpBridge.getStartedAt() ?? new Date().toISOString(),
          version: BUILD_VERSION,
          buildTime: BUILD_TIME,
        });
      } catch (error) {
        vscode.window.showErrorMessage(
          `MCP Server started on port ${httpBridge.getPort()} but could not publish itself ` +
            `for discovery; clients may not find this window: ${error}`
        );
      }

      updateMcpServerStatusBar();
    } catch (error) {
      httpBridge = undefined;
      vscode.window.showErrorMessage(`Failed to start MCP Server: ${error}`);
    }
  });

  const stopServerCommand = vscode.commands.registerCommand('vscode-mcp.stopServer', async () => {
    if (!httpBridge) {
      return;
    }

    try {
      withdraw();
      await httpBridge.stop();
      httpBridge = undefined;
      updateMcpServerStatusBar();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to stop MCP Server: ${error}`);
    }
  });

  const toggleServerCommand = vscode.commands.registerCommand(
    'vscode-mcp.toggleServer',
    async () => {
      if (httpBridge) {
        await vscode.commands.executeCommand('vscode-mcp.stopServer');
      } else {
        await vscode.commands.executeCommand('vscode-mcp.startServer');
      }
    }
  );

  // Create MCP server status bar item
  mcpServerStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  mcpServerStatusBar.command = 'vscode-mcp.toggleServer';
  updateMcpServerStatusBar();
  mcpServerStatusBar.show();

  context.subscriptions.push(
    startServerCommand,
    stopServerCommand,
    toggleServerCommand,
    mcpServerStatusBar
  );

  // Auto-start on activation. Discovery only works for windows that are actually
  // serving, so without this a window stays invisible to clients until somebody
  // clicks the status bar -- which is exactly the failure the registry exists to
  // remove.
  if (vscode.workspace.getConfiguration('vscode-mcp').get<boolean>('autoStart', true)) {
    vscode.commands.executeCommand('vscode-mcp.startServer');
  }
}

export function deactivate() {
  // Dispose debug output tracker
  debugOutputTracker.dispose();

  // Withdraw first, and synchronously: VS Code does not wait for promises here,
  // so an awaited cleanup may never run. Removing the registry entry matters more
  // than closing sockets cleanly -- the process is about to exit either way, but
  // a leftover entry would advertise a bridge that no longer exists.
  withdraw();

  if (httpBridge) {
    httpBridge.stop();
  }
}
