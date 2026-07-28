import * as vscode from 'vscode';
import { ok } from '../response';
import { Tool } from '../types';

export const debug_listBreakpointsTool: Tool = {
  name: 'debug_listBreakpoints',
  description:
    'List all current breakpoints in the workspace. See all breakpoints at once - perfect for debugging complex flows',
  inputSchema: {
    type: 'object',
    properties: {
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
    const { format = 'compact' } = args;

    const breakpoints = vscode.debug.breakpoints
      .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
      .map((bp) => {
        const location = bp.location;
        return {
          file: vscode.workspace.asRelativePath(location.uri),
          line: location.range.start.line + 1,
          enabled: bp.enabled,
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
        };
      });

    // An enumeration: nothing can be "not found", so an empty list is a real
    // answer -- but only once `scope` says which window has no breakpoints.
    const compact = breakpoints.map((bp) => {
      const row: any[] = [bp.file, bp.line, bp.enabled];
      // Only add condition info if it exists
      if (bp.condition || bp.hitCondition || bp.logMessage) {
        row.push({
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
        });
      }
      return row;
    });

    return ok(format === 'compact' ? { bps: compact } : { breakpoints }, {
      subject: { requested: '(all breakpoints)' },
      format: format === 'compact' ? '[file, line, enabled, condition?]' : undefined,
    });
  },
};
