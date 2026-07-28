import * as vscode from 'vscode';
import { Tool } from './types';
import { IndeterminateError, currentScope, ok } from './response';
import { anyLanguageInitialized, searchWorkspaceSymbols } from './utils/symbolProvider';

export const symbolSearchTool: Tool = {
  name: 'symbolSearch',
  description:
    'Search for symbols (classes, functions, variables) across the workspace. Instant semantic search - finds exact matches unlike text-based grep',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Symbol name to search for' },
      kind: {
        type: 'string',
        enum: [
          'all',
          'class',
          'function',
          'variable',
          'interface',
          'namespace',
          'property',
          'method',
        ],
        description: 'Type of symbol to search for (default: all)',
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const { query, kind = 'all', format = 'compact' } = args;

    // Search for symbols (with cold start handling)
    const symbols = await searchWorkspaceSymbols(query);

    // A query is a predicate, not a lookup: matching nothing is a legitimate
    // answer, so there is no not-found here. But an empty result from a language
    // server that has never answered is not an answer at all -- that is the case
    // that used to read as "this symbol does not exist in this project".
    if ((!symbols || symbols.length === 0) && !anyLanguageInitialized()) {
      throw new IndeterminateError(
        `No language server has answered in ${currentScope()} yet, so an empty result for ` +
          `'${query}' would mean nothing. Wait for indexing to finish and retry.`
      );
    }

    // Filter by kind if specified
    let filteredSymbols = symbols ?? [];
    if (kind !== 'all') {
      const kindMap: Record<string, vscode.SymbolKind> = {
        class: vscode.SymbolKind.Class,
        function: vscode.SymbolKind.Function,
        variable: vscode.SymbolKind.Variable,
        interface: vscode.SymbolKind.Interface,
        namespace: vscode.SymbolKind.Namespace,
        property: vscode.SymbolKind.Property,
        method: vscode.SymbolKind.Method,
      };

      const targetKind = kindMap[kind];
      if (targetKind !== undefined) {
        filteredSymbols = symbols.filter((sym) => sym.kind === targetKind);
      }
    }

    return ok(
      format === 'compact'
        ? filteredSymbols.map((sym) => [
              sym.name,
              vscode.SymbolKind[sym.kind].toLowerCase(),
              sym.location.uri.toString(),
              sym.location.range.start.line + 1,
              sym.containerName || '',
            ])
          : filteredSymbols.map((sym) => ({
              name: sym.name,
              kind: vscode.SymbolKind[sym.kind],
              containerName: sym.containerName,
              location: {
                uri: sym.location.uri.toString(),
                range: {
                  start: {
                    line: sym.location.range.start.line + 1,
                    character: sym.location.range.start.character,
                  },
                  end: {
                    line: sym.location.range.end.line + 1,
                    character: sym.location.range.end.character,
                  },
                },
              },
            })),
      {
        subject: { requested: kind === 'all' ? query : `${query} (kind=${kind})` },
        format:
          format === 'compact' && filteredSymbols.length > 0
            ? '[name, kind, uri, line, containerName]'
            : undefined,
      }
    );
  },
};
