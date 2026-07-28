import * as vscode from 'vscode';
import { IndeterminateError, currentScope, notFound, ok } from './response';
import { Tool } from './types';

export const diagnosticsTool: Tool = {
  name: 'diagnostics',
  description:
    'Get diagnostics (errors, warnings, info) for a file or entire workspace. Instantly see all problems without running builds - includes type errors, linting issues, and more',
  inputSchema: {
    type: 'object',
    properties: {
      uri: {
        type: 'string',
        description: 'File URI (optional - if not provided, returns all workspace diagnostics)',
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
    required: [],
  },
  handler: async (args) => {
    const { uri, format = 'compact' } = args;

    if (uri) {
      // Uri.parse accepts anything, and getDiagnostics returns [] for a file it
      // has never heard of -- so without these checks "no problems" and "no such
      // file" and "never analysed" are one indistinguishable answer.
      let fileUri: vscode.Uri;
      try {
        fileUri = vscode.Uri.parse(uri, true);
      } catch {
        return notFound(uri, `Not a valid URI: ${uri}`);
      }

      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        return notFound(uri, `No such file in ${currentScope()}: ${fileUri.fsPath}`);
      }

      // The file exists, but diagnostics are only meaningful once something has
      // actually analysed it. Reporting zero problems for a file no language
      // server has opened is a fabricated answer, not an empty one.
      const known = vscode.workspace.textDocuments.some(
        (doc) => doc.uri.toString() === fileUri.toString()
      );
      const diagnostics = vscode.languages.getDiagnostics(fileUri);
      if (!known && diagnostics.length === 0) {
        throw new IndeterminateError(
          `${fileUri.fsPath} has not been analysed by any language server, so "no problems" ` +
            'cannot be distinguished from "not looked at". Open the file, or wait for the ' +
            'language server to index it, then retry.'
        );
      }

      const results =
          format === 'compact'
            ? diagnostics.map((diag) => [
                vscode.DiagnosticSeverity[diag.severity].toLowerCase(),
                diag.message,
                diag.range.start.line + 1,
                diag.range.start.character,
                diag.range.end.line + 1,
                diag.range.end.character,
                diag.source || '',
                diag.code || '',
              ])
            : diagnostics.map((diag) => ({
                severity: vscode.DiagnosticSeverity[diag.severity],
                message: diag.message,
                range: {
                  start: { line: diag.range.start.line + 1, character: diag.range.start.character },
                  end: { line: diag.range.end.line + 1, character: diag.range.end.character },
                },
                source: diag.source,
                code: diag.code,
              }));

      return ok(results, {
        subject: { requested: uri, resolved: [fileUri.fsPath] },
        format:
          format === 'compact' && results.length > 0
            ? '[severity, message, startLine, startColumn, endLine, endColumn, source, code]'
            : undefined,
      });
    } else {
      // Get all workspace diagnostics
      const allDiagnostics = vscode.languages.getDiagnostics();
      const result: any = {};

      for (const [uri, diagnostics] of allDiagnostics) {
        if (diagnostics.length > 0) {
          result[uri.toString()] =
            format === 'compact'
              ? diagnostics.map((diag) => [
                  vscode.DiagnosticSeverity[diag.severity].toLowerCase(),
                  diag.message,
                  diag.range.start.line + 1,
                  diag.range.start.character,
                  diag.range.end.line + 1,
                  diag.range.end.character,
                  diag.source || '',
                  diag.code || '',
                ])
              : diagnostics.map((diag) => ({
                  severity: vscode.DiagnosticSeverity[diag.severity],
                  message: diag.message,
                  range: {
                    start: {
                      line: diag.range.start.line + 1,
                      character: diag.range.start.character,
                    },
                    end: { line: diag.range.end.line + 1, character: diag.range.end.character },
                  },
                  source: diag.source,
                  code: diag.code,
                }));
        }
      }

      // Workspace-wide is a predicate, not a lookup: nothing can be "not found",
      // so an empty result is honest. It is not necessarily complete, though --
      // only files a language server has actually opened contribute, and there
      // is no way from here to know which ones those are.
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        throw new IndeterminateError(
          'No folder is open in this window, so there is nothing to report diagnostics for.'
        );
      }

      return ok(result, {
        subject: { requested: '(entire workspace)' },
        complete: false,
        reason:
          'covers only files already analysed by a language server; files never opened ' +
          'contribute nothing and are indistinguishable from clean ones',
        format:
          format === 'compact' && Object.keys(result).length > 0
            ? '[severity, message, startLine, startColumn, endLine, endColumn, source, code]'
            : undefined,
      });
    }
  },
};
