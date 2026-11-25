// A minimal MCP server (JSON-RPC 2.0, one message per line on stdin and
// stdout) with the tools that show files in Senju's viewers. Claude Code
// starts it through Senju's plugin; any agent can start it as `senju mcp`.

export interface ShowRequest {
  file?: string;
  content?: string;
  format?: string;
  name?: string;
  window?: boolean;
  id?: string;
}

/** What the daemon answers a show request with. */
export interface Shown {
  viewerId: string;
  updated?: boolean;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const formatHelp =
  'markdown, json, yaml, html, csv, tsv, image, text, or a language to highlight such as typescript, python or diff; without it the extension tells';

const common = {
  name: { type: 'string', description: 'Tab name; the file name by default' },
  format: { type: 'string', description: `How to render it: ${formatHelp}` },
  window: { type: 'boolean', description: 'Open in a window of its own instead of a tab next to the terminal' },
  id: { type: 'string', description: 'The id of a tab shown before, to update it instead of opening another' },
};

export const tools = [
  {
    name: 'show_file',
    title: 'Show a file in Senju',
    description:
      'Shows a file to the user in a Senju tab next to this terminal, rendered by its format: Markdown, JSON and YAML as collapsible trees, HTML (scripts run, nothing loads from the network), CSV as a table, images, and source code with highlighting. The tab reloads whenever the file changes, so keep writing to the same file to update what the user sees, wherever the user moved the tab; showing the file again brings its tab to the front. Use it when the user asks to see, show, open or preview a file or a result; do not open files unasked.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The file, absolute or relative to the working directory' }, ...common },
      required: ['path'],
    },
  },
  {
    name: 'show_content',
    title: 'Show content in Senju',
    description:
      'Shows text to the user in a Senju tab next to this terminal without writing a file: a report, a plan, a table, data or an HTML page, rendered by its format. Use it when the user asks to see or show a result; do not open tabs unasked. To update what you showed, call it again with the same name (or the id it returned): the tab is replaced wherever the user moved it.',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'What to show' }, ...common },
      required: ['content', 'format'],
    },
  },
];

/**
 * Answers one message; null for notifications. `show` opens the viewer and
 * resolves to what the daemon answered, or throws with the reason it could not.
 */
export async function handleMcp(message: RpcMessage, show: (request: ShowRequest) => Promise<Shown>, version: string): Promise<object | null> {
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return null;
  const result = (value: object) => ({ jsonrpc: '2.0', id, result: value });
  const error = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'senju', version },
        instructions: 'Shows files and content to the user in Senju tabs next to this terminal. Open them only when the user asks to see something.',
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools });
    case 'tools/call': {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
      const request: ShowRequest = { format: text('format'), name: text('name'), window: args.window === true, id: text('id') };
      if (params.name === 'show_file') {
        if (!text('path')) return result({ content: [{ type: 'text', text: 'path is required' }], isError: true });
        request.file = text('path');
      } else if (params.name === 'show_content') {
        if (text('content') === undefined) return result({ content: [{ type: 'text', text: 'content is required' }], isError: true });
        request.content = text('content');
      } else {
        return error(-32602, `Unknown tool ${String(params.name)}`);
      }
      try {
        const shown = await show(request);
        const what = request.file ? `${request.file} is` : 'It is';
        const line = `${what} ${shown.updated ? 'updated in its' : 'shown in a'} Senju tab, id ${shown.viewerId}.`;
        return result({ content: [{ type: 'text', text: line }] });
      } catch (err) {
        return result({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${String(method)}`);
  }
}
