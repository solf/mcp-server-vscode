import * as vscode from 'vscode';
import { IndeterminateError, ok } from '../response';
import { Tool } from '../types';
import { debugOutputTracker } from '../../services/debugOutputTracker';

export const debug_getOutputTool: Tool = {
  name: 'debug_getOutput',
  description:
    'Get debug console output from the active debug session (Note: Only works with "console": "internalConsole" in launch.json, not with "integratedTerminal")',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['console', 'stdout', 'stderr', 'telemetry', 'all'],
        description: 'Type of output to retrieve (default: all)',
        default: 'all',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of recent messages to return (default: 100)',
        default: 100,
      },
      filter: {
        type: 'string',
        description: 'Filter messages containing this text',
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
    const { category = 'all', limit = 100, filter, format = 'compact' } = args;

    const session = vscode.debug.activeDebugSession;
    if (!session) {
      throw new IndeterminateError(
        'No active debug session, so there is no debug output. Start one with debug_startSession.'
      );
    }

    try {
      // Check if using integratedTerminal console
      const config = session.configuration;
      const consoleType = config?.console || 'internalConsole';

      // Get outputs from the tracker
      const outputs = debugOutputTracker.getOutputs(session.id, {
        category: category === 'all' ? undefined : category,
        limit,
        filter,
      });

      // With integratedTerminal the program's output goes to a separate terminal
      // that this API cannot see. Returning an empty list would assert "there was
      // no output", which is not what we know -- we know we cannot observe it.
      if (consoleType === 'integratedTerminal' && outputs.length === 0) {
        throw new IndeterminateError(
          `Session '${session.name}' uses "console": "integratedTerminal", whose output goes to a ` +
            'separate terminal and cannot be captured here, so an empty result would not mean ' +
            '"no output". Set "console": "internalConsole" in launch.json to make it readable.'
        );
      }

      if (format === 'compact') {
        // Return compact format: [[category, text], ...]
        return ok(
          {
            outputs: outputs.map((o) => [o.category, o.output.trim()]),
            total: outputs.length,
            session: session.name,
            console: consoleType,
          },
          {
            subject: { requested: `${category} output of '${session.name}'` },
            format: '[category, text]',
          }
        );
      }

      // Detailed format
      return ok(
        {
          outputs: outputs.map((o) => ({
            timestamp: new Date(o.timestamp).toISOString(),
            category: o.category,
            text: o.output,
          })),
          total: outputs.length,
          session: {
            id: session.id,
            name: session.name,
            type: session.type,
            console: consoleType,
          },
          filter: {
            category,
            limit,
            textFilter: filter,
          },
        },
        {
          subject: { requested: `${category} output of '${session.name}'` },
          // The limit is a cap: hitting it exactly means there may well be more.
          complete: outputs.length < limit,
          ...(outputs.length >= limit ? { reason: `capped at limit=${limit}` } : {}),
        }
      );
    } catch (error: any) {
      // An IndeterminateError from inside the try is a precondition failure, not a
      // fault -- rethrow it so it stays distinguishable instead of being flattened.
      if (error instanceof IndeterminateError) {
        throw error;
      }
      throw new Error(`Failed to read debug output: ${error?.message ?? String(error)}`);
    }
  },
};
