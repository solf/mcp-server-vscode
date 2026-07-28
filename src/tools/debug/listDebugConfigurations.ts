import * as vscode from 'vscode';
import { ok } from '../response';
import { Tool } from '../types';

export const debug_listConfigurationsTool: Tool = {
  name: 'debug_listConfigurations',
  description: 'List available debug configurations from launch.json',
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

    const configs = vscode.workspace.getConfiguration('launch').get<any[]>('configurations') || [];

    // Enumeration of what launch.json declares. Empty is a real answer, and
    // `scope` says whose launch.json was read -- which matters once each window
    // serves its own workspace.
    return ok(
      format === 'compact'
        ? { configs: configs.map((c) => [c.name, c.type]) }
        : {
            configurations: configs.map((c) => ({
              name: c.name,
              type: c.type,
              request: c.request,
              program: c.program,
            })),
          },
      {
        subject: { requested: '(launch.json configurations)' },
        format: format === 'compact' ? '[name, type]' : undefined,
      }
    );
  },
};
