import * as vscode from 'vscode';
import { IndeterminateError, currentScope, notFound, ok } from './response';
import { Tool } from './types';
import { anyLanguageInitialized, searchWorkspaceSymbols } from './utils/symbolProvider';

export const callHierarchyTool: Tool = {
  name: 'callHierarchy',
  description:
    'Find what calls a function or what a function calls by using the function name. Perfect for understanding code flow and dependencies - faster than manually tracing through files',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description:
          'Name of the function/method to analyze (e.g., "calculateSum", "add", "Calculator.multiply")',
      },

      // Optional: limit search to specific file
      uri: {
        type: 'string',
        description: 'File URI to search in (optional - searches entire workspace if not provided)',
      },

      direction: {
        type: 'string',
        enum: ['incoming', 'outgoing', 'both'],
        description:
          'Get incoming calls (who calls this), outgoing calls (what this calls), or both',
        default: 'incoming',
      },

      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
    required: ['symbol', 'direction'],
  },
  handler: async (args) => {
    const { symbol, uri, direction = 'incoming', format = 'compact' } = args;

    // Step 1: Find the symbol(s) with the given name
    const searchQuery = symbol.includes('.') ? symbol.split('.').pop()! : symbol;
    const symbols = await searchWorkspaceSymbols(searchQuery);

    if (!symbols || symbols.length === 0) {
      // Empty means "no such symbol" or "nothing can answer yet"; only the
      // first is an answer.
      if (!anyLanguageInitialized()) {
        throw new IndeterminateError(
          `No language server has answered in ${currentScope()} yet, so "${symbol}" cannot ` +
            'be looked up. Wait for indexing to finish and retry.'
        );
      }
      return notFound(symbol, `No symbol named "${symbol}" in ${currentScope()}`);
    }

    // Step 2: Filter symbols to find exact matches
    let matchingSymbols = symbols.filter((s) => {
      // Match exact name or name with parentheses
      const nameMatches =
        s.name === searchQuery ||
        s.name.startsWith(searchQuery + '(') ||
        (symbol.includes('.') && s.containerName === symbol.split('.')[0]);

      // Filter by URI if provided
      const uriMatches = !uri || s.location.uri.toString() === uri;

      return nameMatches && uriMatches;
    });

    // Step 2.5: Prioritize non-method symbols when no container is specified
    if (!symbol.includes('.') && matchingSymbols.length > 1) {
      // If searching for just "add", prefer standalone functions over methods
      const standaloneSymbols = matchingSymbols.filter((s) => !s.containerName);
      if (standaloneSymbols.length > 0) {
        matchingSymbols = standaloneSymbols;
      }
    }

    if (matchingSymbols.length === 0) {
      // Near-misses exist but nothing matched exactly. The candidates are worth
      // returning so the caller can correct the name rather than conclude the
      // symbol does not exist.
      return {
        ...notFound(symbol, `No exact match for "${symbol}" in ${currentScope()}`),
        results: symbols.slice(0, 5).map((s) => ({
          name: s.name,
          kind: vscode.SymbolKind[s.kind],
          container: s.containerName,
          file: vscode.workspace.asRelativePath(s.location.uri),
        })),
      };
    }

    // Step 3: Get call hierarchy for each matching symbol
    const results: any[] = [];

    for (const sym of matchingSymbols) {
      const document = await vscode.workspace.openTextDocument(sym.location.uri);

      // For better results, position cursor in the middle of the symbol name
      const line = document.lineAt(sym.location.range.start.line);
      const lineText = line.text;
      const symbolStartChar = lineText.indexOf(searchQuery, sym.location.range.start.character);

      let position: vscode.Position;
      if (symbolStartChar !== -1) {
        // Position cursor in the middle of the symbol name for better results
        position = new vscode.Position(
          sym.location.range.start.line,
          symbolStartChar + Math.floor(searchQuery.length / 2)
        );
      } else {
        // Fallback to start position
        position = sym.location.range.start;
      }

      // Get call hierarchy item
      const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        document.uri,
        position
      );

      if (!items || items.length === 0) continue;

      const item = items[0];
      const result: any =
        format === 'compact'
          ? {
              symbol: [
                sym.name,
                vscode.SymbolKind[sym.kind].toLowerCase(),
                sym.location.uri.fsPath,
                sym.location.range.start.line + 1,
              ],
              calls: [],
            }
          : {
              symbol: {
                name: sym.name,
                kind: vscode.SymbolKind[sym.kind],
                container: sym.containerName,
                file: sym.location.uri.fsPath,
                line: sym.location.range.start.line + 1,
              },
              calls: [],
            };

      if (direction === 'incoming' || direction === 'both') {
        const incomingCalls = await vscode.commands.executeCommand<
          vscode.CallHierarchyIncomingCall[]
        >('vscode.provideIncomingCalls', item);

        if (incomingCalls && incomingCalls.length > 0) {
          if (format === 'compact') {
            result.calls.push(
              ...incomingCalls.map((call) => [
                'incoming',
                call.from.name,
                vscode.SymbolKind[call.from.kind].toLowerCase(),
                call.from.uri.fsPath,
                call.from.range.start.line + 1,
                call.fromRanges.map((range) => [range.start.line + 1, range.start.character]),
              ])
            );
          } else {
            result.calls.push(
              ...incomingCalls.map((call) => ({
                type: 'incoming',
                from: {
                  name: call.from.name,
                  kind: vscode.SymbolKind[call.from.kind],
                  file: call.from.uri.fsPath,
                  line: call.from.range.start.line + 1,
                },
                locations: call.fromRanges.map((range) => ({
                  line: range.start.line + 1,
                  character: range.start.character,
                  preview: getLinePreview(document, range.start.line),
                })),
              }))
            );
          }
        }
      }

      if (direction === 'outgoing' || direction === 'both') {
        const outgoingCalls = await vscode.commands.executeCommand<
          vscode.CallHierarchyOutgoingCall[]
        >('vscode.provideOutgoingCalls', item);

        if (outgoingCalls && outgoingCalls.length > 0) {
          if (format === 'compact') {
            result.calls.push(
              ...outgoingCalls.map((call) => [
                'outgoing',
                call.to.name,
                vscode.SymbolKind[call.to.kind].toLowerCase(),
                call.to.uri.fsPath,
                call.to.range.start.line + 1,
                call.fromRanges.map((range) => [range.start.line + 1, range.start.character]),
              ])
            );
          } else {
            result.calls.push(
              ...outgoingCalls.map((call) => ({
                type: 'outgoing',
                to: {
                  name: call.to.name,
                  kind: vscode.SymbolKind[call.to.kind],
                  file: call.to.uri.fsPath,
                  line: call.to.range.start.line + 1,
                },
                locations: call.fromRanges.map((range) => ({
                  line: range.start.line + 1,
                  character: range.start.character,
                })),
              }))
            );
          }
        }
      }

      results.push(result);
    }

    // What the name resolved to; length replaces the old `multipleMatches` flag.
    const resolved = matchingSymbols.map((s) => ({
      name: s.name,
      kind: vscode.SymbolKind[s.kind],
      container: s.containerName || undefined,
      file: vscode.workspace.asRelativePath(s.location.uri),
      line: s.location.range.start.line + 1,
    }));

    // Note the old wording here claimed an empty hierarchy "might be an unused
    // function or the language server needs more time" -- two very different
    // things. If the server were not ready we would not have resolved the symbol
    // at all, so reaching here with no calls means genuinely no calls.
    return ok(results, {
      subject: { requested: symbol, resolved },
      reason:
        results.length === 0
          ? `'${symbol}' was found but has no call hierarchy: nothing calls it and it calls nothing`
          : undefined,
      format:
        format === 'compact'
          ? 'calls [direction, name, kind, filePath, line, locations]; locations [line, column]'
          : undefined,
    });
  },
};

// Helper to get a preview of the line (for incoming calls)
function getLinePreview(document: vscode.TextDocument, line: number): string | undefined {
  try {
    return document.lineAt(line).text.trim();
  } catch {
    return undefined;
  }
}
