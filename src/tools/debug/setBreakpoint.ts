import * as vscode from 'vscode';
import { currentScope, notFound, ok } from '../response';
import { Tool } from '../types';
import { findSymbolInWorkspace } from '../utils/symbolProvider';

export const debug_setBreakpointTool: Tool = {
  name: 'debug_setBreakpoint',
  description:
    'Set a breakpoint by symbol name or file/line with optional conditions. Debug smarter - set breakpoints instantly without clicking through files',
  inputSchema: {
    type: 'object',
    properties: {
      // Symbol-based approach (preferred)
      symbol: {
        type: 'string',
        description: 'Symbol name (e.g., "functionName", "ClassName.methodName")',
      },
      // File/line approach (alternative)
      file: {
        type: 'string',
        description: 'File name or path (e.g., "app.ts", "src/app.ts")',
      },
      line: {
        type: 'number',
        description: 'Line number (1-based)',
      },
      // Optional conditions
      condition: {
        type: 'string',
        description: 'Conditional expression (e.g., "x > 100")',
      },
      hitCondition: {
        type: 'string',
        description: 'Hit count expression (e.g., ">5", "==10")',
      },
      logMessage: {
        type: 'string',
        description: 'Log message to output instead of breaking',
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
    const { symbol, file, line, condition, hitCondition, logMessage, format = 'compact' } = args;

    // Validate input
    if (!symbol && (!file || line === undefined)) {
      throw new Error('Provide either a symbol name, or a file together with a line number.');
    }

    let targetUri: vscode.Uri | undefined;
    let targetLine: number | undefined;
    let symbolInfo: any = null;

    // Find location by symbol
    if (symbol) {
      const symbols = await findSymbolInWorkspace(symbol);

      if (symbols.length === 0) {
        // Try to find similar symbols for suggestions
        const allSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          ''
        );
        const suggestions = allSymbols
          ?.filter((s) => s.name.toLowerCase().includes(symbol.toLowerCase()))
          .slice(0, 5)
          .map((s) => ({
            name: s.name,
            kind: vscode.SymbolKind[s.kind],
            file: vscode.workspace.asRelativePath(s.location.uri),
          }));

        // No breakpoint was set. The near-misses go in `results` so the caller
        // can correct the name rather than conclude the symbol does not exist.
        return {
          ...notFound(
            symbol,
            `No symbol named '${symbol}' in ${currentScope()}; no breakpoint was set`
          ),
          results: suggestions ?? [],
        };
      }

      // Ambiguous: no breakpoint was set. Like rename, this used to come back as
      // a successful-looking payload, so a caller could believe a breakpoint had
      // been placed when none had.
      if (symbols.length > 1) {
        const candidates = symbols
          .map(
            (s) =>
              `  ${s.containerName ? `${s.containerName}.` : ''}${s.name} ` +
              `[${vscode.SymbolKind[s.kind]}] ${vscode.workspace.asRelativePath(s.location.uri)}:` +
              `${s.location.range.start.line + 1}`
          )
          .join('\n');
        throw new Error(
          `'${symbol}' matches ${symbols.length} symbols in ${currentScope()}, so no breakpoint ` +
            `was set.\n${candidates}\n` +
            'Use a qualified name (e.g. "Class.method"), or file and line instead.'
        );
      }

      const match = symbols[0];
      targetUri = match.location.uri;
      targetLine = match.location.range.start.line;
      symbolInfo = {
        name: match.name,
        kind: vscode.SymbolKind[match.kind],
        container: match.containerName,
      };
    }
    // Find location by file/line
    else if (file && line !== undefined) {
      // Convert from 1-based (user input) to 0-based (VS Code)
      targetLine = line - 1;

      // Find the file in workspace
      const files = await vscode.workspace.findFiles(`**/${file}`);
      if (files.length === 0) {
        return notFound(
          file,
          `No file matching '${file}' in ${currentScope()}; no breakpoint was set`
        );
      }
      targetUri = files[0];
      // targetLine already set above after conversion
    }

    // Create breakpoint
    const location = new vscode.Location(targetUri!, new vscode.Position(targetLine!, 0));
    const bp = new vscode.SourceBreakpoint(location, true, condition, hitCondition, logMessage);
    vscode.debug.addBreakpoints([bp]);

    const breakpointInfo = {
      file: vscode.workspace.asRelativePath(targetUri!),
      line: targetLine! + 1, // Convert to 1-based for output
      enabled: true,
      condition,
      hitCondition,
      logMessage,
      symbol: symbol || undefined,
      ...(symbolInfo && { kind: symbolInfo.kind, container: symbolInfo.container }),
    };

    // Enveloped like the not-found path above: this tool answered both ways in
    // different shapes, so a caller checking `status` got 'not-found' sometimes
    // and undefined otherwise.
    return ok(
      format === 'compact'
        ? { bp: [breakpointInfo.file, breakpointInfo.line + 1, breakpointInfo.enabled] }
        : { breakpoint: breakpointInfo },
      {
        subject: {
          requested: symbol ?? `${file}:${line}`,
          resolved: [`${breakpointInfo.file}:${breakpointInfo.line}`],
        },
        format: format === 'compact' ? '[file, line, enabled]' : undefined,
      }
    );
  },
};
