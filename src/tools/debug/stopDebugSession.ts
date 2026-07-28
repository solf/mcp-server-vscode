import * as vscode from 'vscode';
import { currentScope, IndeterminateError } from '../response';
import { Tool } from '../types';

export const debug_stopSessionTool: Tool = {
  name: 'debug_stopSession',
  description: 'Stop the current debug session',
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

    const session = vscode.debug.activeDebugSession;
    if (!session) {
      throw new IndeterminateError(
        'No active debug session, so there is nothing to stop.'
      );
    }

    await vscode.debug.stopDebugging();

    if (format === 'compact') {
      return { scope: currentScope(), stopped: true };
    }
    return { scope: currentScope(), status: 'Debug session stopped', sessionName: session.name };
  },
};
