import * as vscode from 'vscode';
import { currentScope, notFound, ok } from '../response';
import { Tool } from '../types';
import { searchWorkspaceSymbols } from '../utils/symbolProvider';

/**
 * Find similar symbol names for suggestions (simple Levenshtein distance)
 */
function findSimilarNames(target: string, symbols: string[], maxDistance: number = 3): string[] {
  function levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  return symbols
    .map((s) => ({ name: s, distance: levenshtein(target.toLowerCase(), s.toLowerCase()) }))
    .filter((s) => s.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .map((s) => s.name)
    .slice(0, 5);
}

export const refactor_renameTool: Tool = {
  name: 'refactor_rename',
  description:
    'Rename a symbol across all files in the workspace. Refactor safely - automatically updates all references, imports, and type usages',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Symbol name to rename (e.g., "calculateTotal", "UserService.login")',
      },
      newName: {
        type: 'string',
        description: 'The new name for the symbol',
      },
      uri: {
        type: 'string',
        description: 'Optional: File URI to disambiguate if multiple symbols exist',
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
    required: ['symbol', 'newName'],
  },
  handler: async (args: any) => {
    const { symbol, newName, uri: providedUri, format = 'compact' } = args;

    try {
      // Search for the symbol across workspace
      const searchResult = await searchWorkspaceSymbols(symbol);

      if (!searchResult || searchResult.length === 0) {
        // Find similar symbols for suggestions
        const allSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          ''
        );

        const symbolNames = Array.from(new Set(allSymbols?.map((s) => s.name) || []));
        const suggestions = findSimilarNames(symbol, symbolNames);

        return {
          ...notFound(symbol, `No symbol named '${symbol}' in ${currentScope()}; nothing renamed`),
          results: suggestions.map((name) => {
            const sym = allSymbols?.find((s) => s.name === name);
            return {
              name,
              kind: sym?.kind ? vscode.SymbolKind[sym.kind] : 'unknown',
            };
          }),
        };
      }

      // Filter by provided URI if specified
      let matches = searchResult;
      if (providedUri) {
        const targetUri = vscode.Uri.parse(providedUri);
        matches = searchResult.filter((s) => s.location.uri.toString() === targetUri.toString());

        if (matches.length === 0) {
          return {
            ...notFound(
              symbol,
              `'${symbol}' exists in ${currentScope()} but not in ${providedUri}; nothing renamed. ` +
                'Drop the uri parameter to rename across all files.'
            ),
            results: searchResult.map((s) => vscode.workspace.asRelativePath(s.location.uri)),
          };
        }
      }

      // Handle multiple matches
      if (matches.length > 1) {
        // Try to find exact match (not container prefix)
        const exactMatches = matches.filter((m) => {
          const parts = m.name.split('.');
          return parts[parts.length - 1] === symbol;
        });

        if (exactMatches.length === 1) {
          matches = exactMatches;
        } else {
          // This tool writes to disk, so an ambiguous name must stop it dead.
          // Refusing was already the behaviour, but it was reported as a
          // successful result -- a caller skimming for an error saw none and
          // could reasonably conclude the rename had happened.
          const candidates = matches
            .slice(0, 10)
            .map(
              (m) =>
                `  ${m.containerName ? `${m.containerName}.` : ''}${m.name} ` +
                `[${vscode.SymbolKind[m.kind]}] ${vscode.workspace.asRelativePath(m.location.uri)}:` +
                `${m.location.range.start.line + 1}`
            )
            .join('\n');
          throw new Error(
            `Refusing to rename: '${symbol}' matches ${matches.length} symbols in ` +
              `${currentScope()}, and renaming the wrong one would edit files silently.\n` +
              `${candidates}\n` +
              'Disambiguate with a qualified name (e.g. "Class.method") or the uri parameter.'
          );
        }
      }

      // We have a single match - perform rename
      const match = matches[0];
      const fileUri = match.location.uri;
      const position = match.location.range.start;

      // Open the document to ensure it's loaded
      await vscode.workspace.openTextDocument(fileUri);

      // Execute rename using VS Code's rename provider
      const renameEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider',
        fileUri,
        position,
        newName
      );

      if (!renameEdit) {
        throw new Error(
          `No rename provider handled '${match.name}' ` +
            `[${vscode.SymbolKind[match.kind]}] in ${vscode.workspace.asRelativePath(fileUri)}; ` +
            'nothing was changed. It may be an external library symbol, which cannot be renamed.'
        );
      }

      // Preview the changes
      const editEntries = Array.from(renameEdit.entries());
      const changes = editEntries.map(([uri, edits]) => ({
        file: vscode.workspace.asRelativePath(uri),
        edits: edits.map((edit) => ({
          startLine: edit.range.start.line + 1,
          startChar: edit.range.start.character,
          endLine: edit.range.end.line + 1,
          endChar: edit.range.end.character,
          newText: edit.newText,
        })),
      }));

      // Apply the rename
      const success = await vscode.workspace.applyEdit(renameEdit);

      if (!success) {
        // A failed write must not read as a result. Files may be partially
        // edited at this point, which the caller needs to know unambiguously.
        throw new Error(
          `Rename of '${symbol}' to '${newName}' failed while applying ${changes.length} ` +
            'file edit(s); the workspace may be partly modified. Save all files and retry.'
        );
      }

      // Save all affected documents
      await vscode.workspace.saveAll(false);

      const renamed = {
        oldName: match.name,
        newName,
        ...(format === 'compact'
          ? {}
          : {
              kind: vscode.SymbolKind[match.kind],
              location: {
                file: vscode.workspace.asRelativePath(fileUri),
                line: position.line + 1,
                character: position.character,
              },
            }),
      };

      return ok(
        format === 'compact'
          ? {
              renamed,
              filesChanged: changes.length,
              totalEdits: changes.reduce((sum, file) => sum + file.edits.length, 0),
            }
          : { renamed, changes },
        {
          subject: {
            requested: symbol,
            resolved: [
              {
                name: match.name,
                kind: vscode.SymbolKind[match.kind],
                file: vscode.workspace.asRelativePath(fileUri),
                line: position.line + 1,
              },
            ],
          },
        }
      );
    } catch (error: any) {
      // Rethrow: a mutating tool reporting failure as a successful payload is
      // how a caller ends up believing files were changed when they were not.
      throw error instanceof Error
        ? error
        : new Error(error?.message || 'Unknown error during rename operation');
    }
  },
};
