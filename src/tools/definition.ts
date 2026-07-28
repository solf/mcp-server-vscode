import * as vscode from 'vscode';
import { IndeterminateError, currentScope, notFound, ok } from './response';
import { Tool } from './types';
import { anyLanguageInitialized } from './utils/symbolProvider';
import {
  searchWorkspaceSymbols,
  getDocumentSymbols,
  findSymbolByName,
} from './utils/symbolProvider';

export const definitionTool: Tool = {
  name: 'definition',
  description:
    'Find the definition of a symbol by name. More efficient than searching files - instantly jumps to where a function/class/variable is defined',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description:
          'Symbol name to find definition for (e.g., "functionName", "ClassName", "ClassName.methodName")',
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
    required: ['symbol'],
  },
  handler: async (args) => {
    const { symbol, format = 'compact' } = args;
    return await findDefinitionBySymbol(symbol, format);
  },
};

// Helper function for symbol-based lookup
async function findDefinitionBySymbol(
  symbolName: string,
  format: 'compact' | 'detailed'
): Promise<any> {
  // Parse symbol name (e.g., "ClassName.methodName" or just "functionName")
  const parts = symbolName.split('.');
  const primarySymbol = parts[0];
  const memberSymbol = parts[1];

  // Search for the symbol in the workspace
  const symbols = await searchWorkspaceSymbols(primarySymbol);

  if (!symbols || symbols.length === 0) {
    // "No such symbol" and "nothing can answer yet" both arrive as an empty list;
    // only the first is an answer.
    if (!anyLanguageInitialized()) {
      throw new IndeterminateError(
        `No language server has answered in ${currentScope()} yet, so '${symbolName}' cannot ` +
          'be looked up. Wait for indexing to finish and retry.'
      );
    }
    return notFound(symbolName, `No symbol named '${symbolName}' in ${currentScope()}`);
  }

  // Filter to find exact matches (not partial)
  // Note: VS Code may append () to function names, so we need to handle that
  const exactMatches = symbols.filter((sym) => {
    const baseName = sym.name.replace(/\(\)$/, ''); // Remove trailing ()
    return baseName === primarySymbol;
  });
  const matchesToUse = exactMatches.length > 0 ? exactMatches : symbols;

  const allDefinitions: any[] = [];

  for (const sym of matchesToUse) {
    try {
      // If looking for a member (e.g., ClassName.methodName)
      if (memberSymbol) {
        // For class members, we need to find the member within the class
        const document = await vscode.workspace.openTextDocument(sym.location.uri);

        // Get document symbols to find the member
        const docSymbols = await getDocumentSymbols(document);

        if (docSymbols) {
          // Find the class/container
          const container = findSymbolByName(docSymbols, primarySymbol);
          if (container && container.children) {
            // Find the member within the container
            const member = findSymbolByName(container.children, memberSymbol);
            if (member) {
              if (format === 'compact') {
                allDefinitions.push({
                  symbol: [
                    member.name,
                    vscode.SymbolKind[member.kind].toLowerCase(),
                    sym.location.uri.fsPath,
                    member.range.start.line + 1,
                  ],
                  uri: sym.location.uri.toString(),
                  range: [
                    member.range.start.line + 1,
                    member.range.start.character,
                    member.range.end.line + 1,
                    member.range.end.character,
                  ],
                });
              } else {
                allDefinitions.push({
                  symbol: {
                    name: member.name,
                    kind: vscode.SymbolKind[member.kind],
                    container: container.name,
                    file: sym.location.uri.fsPath,
                    line: member.range.start.line + 1,
                  },
                  uri: sym.location.uri.toString(),
                  range: {
                    start: {
                      line: member.range.start.line + 1,
                      character: member.range.start.character,
                    },
                    end: {
                      line: member.range.end.line + 1,
                      character: member.range.end.character,
                    },
                  },
                });
              }
            }
          }
        }
      } else {
        // For standalone symbols, use the symbol location directly
        if (format === 'compact') {
          allDefinitions.push({
            symbol: [
              sym.name,
              vscode.SymbolKind[sym.kind].toLowerCase(),
              sym.location.uri.fsPath,
              sym.location.range.start.line + 1,
            ],
            uri: sym.location.uri.toString(),
            range: [
              sym.location.range.start.line + 1,
              sym.location.range.start.character,
              sym.location.range.end.line + 1,
              sym.location.range.end.character,
            ],
          });
        } else {
          allDefinitions.push({
            symbol: {
              name: sym.name,
              kind: vscode.SymbolKind[sym.kind],
              container: sym.containerName,
              file: sym.location.uri.fsPath,
              line: sym.location.range.start.line + 1,
            },
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
          });
        }
      }
    } catch (error) {
      // Skip symbols that can't be processed
      console.error(`Error processing symbol ${sym.name}:`, error);
    }
  }

  // What the name resolved to. Length carries the ambiguity that
  // `multipleDefinitions` used to flag only in the plural branch.
  const resolved = matchesToUse.map((sym) => ({
    name: sym.name,
    container: sym.containerName || undefined,
    file: vscode.workspace.asRelativePath(sym.location.uri),
    line: sym.location.range.start.line + 1,
  }));

  if (allDefinitions.length === 0) {
    // The name resolved, but no definition came back for it -- e.g. a member
    // that does not exist on the container that was found. Distinct from the
    // symbol itself being absent, so `resolved` stays populated.
    return {
      ...ok([], {
        subject: { requested: symbolName, resolved },
        reason: memberSymbol
          ? `'${primarySymbol}' was found but has no member '${memberSymbol}'`
          : `'${symbolName}' was found but no definition provider returned a location`,
      }),
    };
  }

  return ok(allDefinitions, {
    subject: { requested: symbolName, resolved },
    format:
      format === 'compact'
        ? 'symbol [name, kind, filePath, line]; range [startLine, startColumn, endLine, endColumn]'
        : undefined,
  });
}
