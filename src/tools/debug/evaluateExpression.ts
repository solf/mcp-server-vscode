import * as vscode from 'vscode';
import { IndeterminateError, ok } from '../response';
import { Tool } from '../types';

export const debug_evaluateExpressionTool: Tool = {
  name: 'debug_evaluateExpression',
  description:
    'Evaluate an expression in the current debug context (REPL/watch functionality). Test hypotheses instantly - execute any expression without modifying code',
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Expression to evaluate (e.g., "myVariable", "array.length", "func()")',
      },
      threadId: {
        type: 'number',
        description: 'Thread ID (optional, uses current stopped thread)',
      },
      frameId: {
        type: 'number',
        description: 'Stack frame ID for context (optional, uses top frame)',
      },
      context: {
        type: 'string',
        enum: ['watch', 'repl', 'hover', 'clipboard'],
        description: 'Evaluation context (default: repl)',
        default: 'repl',
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
    required: ['expression'],
  },
  handler: async (args) => {
    const { expression, threadId, frameId, context = 'repl', format = 'compact' } = args;

    if (!expression) {
      throw new Error('An expression is required.');
    }

    const session = vscode.debug.activeDebugSession;
    if (!session) {
      throw new IndeterminateError(
        'No active debug session, so there is nothing to evaluate against. Start one with debug_startSession.'
      );
    }

    try {
      let targetFrameId = frameId;

      // If no frameId specified, we need to get it from the current thread
      if (targetFrameId === undefined) {
        let targetThreadId = threadId;

        // If no threadId specified, get the current thread
        if (targetThreadId === undefined) {
          const threadsResponse = await session.customRequest('threads');
          const threads = threadsResponse.threads || [];

          if (threads.length > 0) {
            targetThreadId = threads[0].id;
          } else {
            throw new IndeterminateError(
              'The debug session reports no threads, so there is no frame to evaluate in. ' +
                'This usually means it has not started or is not paused.'
            );
          }
        }

        // Get the top frame
        const stackResponse = await session.customRequest('stackTrace', {
          threadId: targetThreadId,
          startFrame: 0,
          levels: 1,
        });

        if (stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
          targetFrameId = stackResponse.stackFrames[0].id;
        }
      }

      // Evaluate the expression
      const evalResponse = await session.customRequest('evaluate', {
        expression,
        frameId: targetFrameId,
        context,
      });

      // The expression is the subject, so it is echoed back: a bare value with
      // no record of what produced it is hard to trust in a transcript.
      return ok(
        format === 'compact'
          ? {
              result: evalResponse.result,
              type: evalResponse.type || 'unknown',
              variablesReference: evalResponse.variablesReference || 0,
            }
          : {
              result: evalResponse.result,
              type: evalResponse.type,
              presentationHint: evalResponse.presentationHint,
              variablesReference: evalResponse.variablesReference,
              namedVariables: evalResponse.namedVariables,
              indexedVariables: evalResponse.indexedVariables,
              memoryReference: evalResponse.memoryReference,
              context,
              frameId: targetFrameId,
            },
        { subject: { requested: expression, resolved: [`frame ${targetFrameId}`] } }
      );
    } catch (error: any) {
      if (error instanceof IndeterminateError) {
        throw error;
      }
      // Both branches used to return successfully, so a failed evaluation and a
      // real value were the same kind of answer to the caller.
      throw new Error(
        `Could not evaluate '${expression}': ${error?.message ?? String(error)}. ` +
          'Check the debugger is paused and the expression is valid in this frame.'
      );
    }
  },
};
