import * as vscode from 'vscode';
import { currentScope, IndeterminateError } from '../response';
import { Tool } from '../types';

export const debug_pauseExecutionTool: Tool = {
  name: 'debug_pauseExecution',
  description: 'Pause the running debug session at the current execution point',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: {
        type: 'number',
        description: 'Thread ID to pause (optional, defaults to all threads)',
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
        'No active debug session, so there is nothing to pause. Start one with debug_startSession.'
      );
    }

    try {
      // If no threadId specified, get all threads and pause them
      if (threadId === undefined) {
        const threadsResponse = await session.customRequest('threads');
        const threads = threadsResponse.threads || [];

        // Pause all threads
        for (const thread of threads) {
          await session.customRequest('pause', { threadId: thread.id });
        }

        if (format === 'compact') {
          return { scope: currentScope(), paused: true, threads: threads.length };
        }
        return {
          scope: currentScope(),
          status: 'Paused execution',
          pausedThreads: threads.map((t: any) => ({ id: t.id, name: t.name })),
        };
      } else {
        // Pause specific thread
        await session.customRequest('pause', { threadId });

        if (format === 'compact') {
          return { scope: currentScope(), paused: true, thread: threadId };
        }
        return {
          scope: currentScope(),
          status: 'Paused execution',
          threadId,
        };
      }
    } catch (error: any) {
      // An IndeterminateError from inside the try is a precondition failure, not a
      // fault -- rethrow it so it stays distinguishable instead of being flattened.
      if (error instanceof IndeterminateError) {
        throw error;
      }
      throw new Error(`Failed to pause execution: ${error?.message ?? String(error)}`);
    }
  },
};
