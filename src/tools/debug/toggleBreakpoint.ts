import * as vscode from 'vscode';
import { currentScope, notFound, ok } from '../response';
import { Tool } from '../types';
import { findSymbolInWorkspace } from '../utils/symbolProvider';

export const debug_toggleBreakpointTool: Tool = {
  name: 'debug_toggleBreakpoint',
  description: 'Toggle a breakpoint on/off at a symbol or file/line location',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Symbol name (e.g., "functionName", "ClassName.methodName")',
      },
      file: {
        type: 'string',
        description: 'File name or path (e.g., "app.ts", "src/app.ts")',
      },
      line: {
        type: 'number',
        description: 'Line number (1-based)',
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
  },
  handler: async (args) => {
    const { symbol, file, line, format = 'compact' } = args;

    // Validate input
    if (!symbol && (!file || line === undefined)) {
      throw new Error('Provide either a symbol name, or a file together with a line number.');
    }

    let targetUri: vscode.Uri | undefined;
    let targetLine: number | undefined;

    // Find location by symbol
    if (symbol) {
      const symbols = await findSymbolInWorkspace(symbol);

      if (symbols.length === 0) {
        return notFound(
          symbol,
          `No symbol named '${symbol}' in ${currentScope()}; no breakpoint was toggled`
        );
      }

      // For toggle, just use the first match
      const match = symbols[0];
      targetUri = match.location.uri;
      targetLine = match.location.range.start.line;
    }
    // Find location by file/line
    else if (file && line !== undefined) {
      // Convert from 1-based (user input) to 0-based (VS Code)
      targetLine = line - 1;

      const files = await vscode.workspace.findFiles(`**/${file}`);
      if (files.length === 0) {
        return notFound(
          file,
          `No file matching '${file}' in ${currentScope()}; no breakpoint was toggled`
        );
      }
      targetUri = files[0];
    }

    // Check if breakpoint exists
    const existingBp = vscode.debug.breakpoints.find((bp) => {
      if (bp instanceof vscode.SourceBreakpoint) {
        return (
          bp.location.uri.toString() === targetUri!.toString() &&
          bp.location.range.start.line === targetLine
        );
      }
      return false;
    });

    // Enveloped to match the not-found path above; `action` stays in the payload
    // because "added" versus "removed" is the answer, not a status.
    const relative = vscode.workspace.asRelativePath(targetUri!);
    const bpLine = targetLine! + 1;
    const added = !existingBp;

    if (existingBp) {
      vscode.debug.removeBreakpoints([existingBp]);
    } else {
      const location = new vscode.Location(targetUri!, new vscode.Position(targetLine!, 0));
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true)]);
    }

    return ok(
      format === 'compact'
        ? { action: added ? 'added' : 'removed', bp: [relative, bpLine, added] }
        : {
            action: added ? 'added' : 'removed',
            breakpoint: {
              file: relative,
              line: bpLine,
              ...(added ? { enabled: true } : {}),
              symbol: symbol || undefined,
            },
          },
      {
        subject: { requested: symbol ?? `${file}:${line}`, resolved: [`${relative}:${bpLine}`] },
        format: format === 'compact' ? '[file, line, enabled]' : undefined,
      }
    );
  },
};
