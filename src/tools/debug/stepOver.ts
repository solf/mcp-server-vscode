import * as vscode from 'vscode';
import { currentScope, IndeterminateError } from '../response';
import { Tool } from '../types';

export const debug_stepOverTool: Tool = {
  name: 'debug_stepOver',
  description:
    'Step over the current line of code (execute current line without entering functions)',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: {
        type: 'number',
        description: 'Thread ID to step (optional, uses current stopped thread)',
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
    const { threadId, format = 'compact' } = args;

    const session = vscode.debug.activeDebugSession;
    if (!session) {
      throw new IndeterminateError(
        'No active debug session, so there is nothing to step. Start one with debug_startSession.'
      );
    }

    try {
      let targetThreadId = threadId;

      // If no threadId specified, try to find the stopped thread
      if (targetThreadId === undefined) {
        const threadsResponse = await session.customRequest('threads');
        const threads = threadsResponse.threads || [];

        // Try to find a stopped thread (this is a simplification)
        // In practice, we might need to track which thread hit the breakpoint
        if (threads.length > 0) {
          targetThreadId = threads[0].id;
        } else {
          throw new IndeterminateError(
        'The debug session reports no threads, so there is nothing to step. ' +
          'This usually means it has not started or is not paused.'
      );
        }
      }

      // Execute step over (next)
      await session.customRequest('next', { threadId: targetThreadId });

      if (format === 'compact') {
        return { scope: currentScope(), stepped: true, thread: targetThreadId };
      }
      return {
        scope: currentScope(),
        status: 'Stepped over',
        threadId: targetThreadId,
        action: 'next',
      };
    } catch (error: any) {
      // An IndeterminateError from inside the try is a precondition failure, not a
      // fault -- rethrow it so it stays distinguishable instead of being flattened.
      if (error instanceof IndeterminateError) {
        throw error;
      }
      throw new Error(`Failed to step over: ${error?.message ?? String(error)}`);
    }
  },
};
