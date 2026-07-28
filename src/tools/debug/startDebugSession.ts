import * as vscode from 'vscode';
import { currentScope, notFound, ok } from '../response';
import { Tool } from '../types';

export const debug_startSessionTool: Tool = {
  name: 'debug_startSession',
  description:
    'Start a debug session using a configuration from launch.json. Launch debugging instantly - no need to navigate to the debug panel',
  inputSchema: {
    type: 'object',
    properties: {
      configuration: {
        type: 'string',
        description: 'Name of debug configuration to use (optional, uses first if not specified)',
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
    const { configuration, format = 'compact' } = args;

    const configs = vscode.workspace.getConfiguration('launch').get<any[]>('configurations') || [];

    if (configs.length === 0) {
      return notFound(
        configuration ?? '(any)',
        `No debug configurations exist in launch.json for ${currentScope()}; nothing was started`
      );
    }

    let configToUse = configs[0];
    if (configuration) {
      const found = configs.find((c) => c.name === configuration);
      if (!found) {
        return {
          ...notFound(
            configuration,
            `No debug configuration named '${configuration}' in ${currentScope()}; nothing was started`
          ),
          results: configs.map((c) => c.name),
        };
      }
      configToUse = found;
    }

    const started = await vscode.debug.startDebugging(undefined, configToUse);

    // Enveloped to match the not-found path above. Note `started` is kept in the
    // payload: VS Code can decline to start a configuration without throwing, so
    // "the tool ran" and "the session started" are different facts.
    return ok(
      format === 'compact'
        ? { started, config: configToUse.name }
        : { started, session: { name: configToUse.name, type: configToUse.type } },
      {
        subject: { requested: configuration ?? '(first configuration)', resolved: [configToUse.name] },
        ...(started ? {} : { reason: 'VS Code did not start the configuration' }),
      }
    );
  },
};
