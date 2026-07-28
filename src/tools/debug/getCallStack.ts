import * as vscode from 'vscode';
import { IndeterminateError, ok } from '../response';
import { Tool } from '../types';

export const debug_getCallStackTool: Tool = {
  name: 'debug_getCallStack',
  description:
    'Get the current call stack/stack trace from the paused debug session. Understand execution flow instantly - see the complete call chain at a glance',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: {
        type: 'number',
        description: 'Thread ID to get stack for (optional, uses current stopped thread)',
      },
      startFrame: {
        type: 'number',
        description: 'Starting frame index (0-based, default: 0)',
        default: 0,
      },
      levels: {
        type: 'number',
        description: 'Number of frames to retrieve (default: 20, use 0 for all)',
        default: 20,
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
    const { threadId, startFrame = 0, levels = 20, format = 'compact' } = args;

    const session = vscode.debug.activeDebugSession;
    if (!session) {
      throw new IndeterminateError(
        'No active debug session, so there is no call stack. Start one with debug_startSession.'
      );
    }

    try {
      let targetThreadId = threadId;

      // If no threadId specified, try to find the stopped thread
      if (targetThreadId === undefined) {
        const threadsResponse = await session.customRequest('threads');
        const threads = threadsResponse.threads || [];

        if (threads.length > 0) {
          targetThreadId = threads[0].id;
        } else {
          throw new IndeterminateError(
        'The debug session reports no threads, so there is no call stack to read. ' +
          'This usually means it has not started or is not paused.'
      );
        }
      }

      // Get stack trace
      const stackResponse = await session.customRequest('stackTrace', {
        threadId: targetThreadId,
        startFrame,
        levels: levels === 0 ? undefined : levels,
      });

      const frames = stackResponse.stackFrames || [];

      if (format === 'compact') {
        // Return compact format: [[name, file, line, column], ...]
        return ok(
          {
            stack: frames.map((frame: any) => [
              frame.name,
              frame.source?.path ? vscode.workspace.asRelativePath(frame.source.path) : 'unknown',
              frame.line, // DAP is already 1-based
              frame.column, // DAP is already 1-based
            ]),
            totalFrames: stackResponse.totalFrames || frames.length,
          },
          {
            subject: { requested: `thread ${targetThreadId}` },
            format: '[name, file, line, column]',
          }
        );
      }

      // Detailed format
      return ok(
        {
          callStack: frames.map((frame: any) => ({
            id: frame.id,
            name: frame.name,
            source: frame.source
              ? {
                  path: vscode.workspace.asRelativePath(frame.source.path),
                  name: frame.source.name,
                  line: frame.line, // DAP is already 1-based
                  column: frame.column, // DAP is already 1-based
                }
              : null,
            presentationHint: frame.presentationHint,
          })),
          totalFrames: stackResponse.totalFrames || frames.length,
          threadId: targetThreadId,
        },
        { subject: { requested: `thread ${targetThreadId}` } }
      );
    } catch (error: any) {
      // An IndeterminateError from inside the try is a precondition failure, not a
      // fault -- rethrow it so it stays distinguishable instead of being flattened.
      if (error instanceof IndeterminateError) {
        throw error;
      }
      throw new Error(`Failed to read the call stack: ${error?.message ?? String(error)}`);
    }
  },
};
