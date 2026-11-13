import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHubClient, resolveBaseUrl } from './hubClient';
import { buildMcpServer } from './server';

// stdout carries the MCP protocol; every diagnostic goes to stderr.
function parseAs(argv: string[]): string | null {
  const i = argv.indexOf('--as');
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : null;
}

/** Starts the stdio MCP server. Exits 2 on a usage or AGENTCHAT_PORT error. `getToken` is the only source of the hub token. */
export async function startMcp(argv: string[], env: NodeJS.ProcessEnv, getToken: () => string | null): Promise<void> {
  const as = parseAs(argv);
  if (!as) {
    process.stderr.write('usage: main.ts --as <adapter-name>\n');
    process.exit(2);
  }
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(env.AGENTCHAT_PORT);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }
  const invokedByHub = env.AGENTCHAT_INVOCATION === '1';
  const server = buildMcpServer({ as, client: createHubClient({ baseUrl, as, getToken }), invokedByHub });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`agent-chat mcp ready (as ${as}${invokedByHub ? ', no tools: invoked by hub' : ''})\n`);
}
