import * as vscode from 'vscode';
import { currentScope, IndeterminateError } from '../response';
import { Tool } from '../types';

export const debug_continueExecutionTool: Tool = {
  name: 'debug_continueExecution',
  description: 'Continue execution from the current breakpoint or paused state',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: {
        type: 'number',
        description: 'Thread ID to continue (optional, defaults to all threads)',
      },
      allThreads: {
        type: 'boolean',
        description: 'Continue all threads simultaneously (default: true)',
        default: true,
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
    const { threadId, allThreads = true, format = 'compact' } = args;

    const session = vscode.debug.activeDebugSession;
    if (!session) {
      throw new IndeterminateError(
        'No active debug session, so there is nothing to act on. Start one with debug_startSession.'
      );
    }

    try {
      if (threadId !== undefined) {
        // Continue specific thread
        await session.customRequest('continue', {
          threadId,
          allThreadsContinued: allThreads,
        });

        if (format === 'compact') {
          return { scope: currentScope(), continued: true, thread: threadId };
        }
        return {
          scope: currentScope(),
          status: 'Continued execution',
          threadId,
          allThreadsContinued: allThreads,
        };
      } else {
        // Get all threads and continue them
        const threadsResponse = await session.customRequest('threads');
        const threads = threadsResponse.threads || [];

        if (threads.length > 0) {
          // Continue from first thread with allThreadsContinued flag
          await session.customRequest('continue', {
            threadId: threads[0].id,
            allThreadsContinued: true,
          });
        }

        if (format === 'compact') {
          return { scope: currentScope(), continued: true, threads: threads.length };
        }
        return {
          scope: currentScope(),
          status: 'Continued execution',
          continuedThreads: threads.map((t: any) => ({ id: t.id, name: t.name })),
        };
      }
    } catch (error: any) {
      // An IndeterminateError from inside the try is a precondition failure, not a
      // fault -- rethrow it so it stays distinguishable instead of being flattened.
      if (error instanceof IndeterminateError) {
        throw error;
      }
      throw new Error(`Failed to continue execution: ${error?.message ?? String(error)}`);
    }
  },
};
