import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHubClient, readTokenFromKeychain } from './hubClient';
import { buildMcpServer } from './server';

// stdout carries the MCP protocol; every diagnostic goes to stderr.
function parseAs(argv: string[]): string | null {
  const i = argv.indexOf('--as');
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : null;
}

const as = parseAs(process.argv.slice(2));
if (!as) {
  process.stderr.write('usage: main.ts --as <adapter-name>\n');
  process.exit(2);
}

const baseUrl = `http://127.0.0.1:${process.env.AGENTCHAT_PORT ?? 4317}`;
const invokedByHub = process.env.AGENTCHAT_INVOCATION === '1';

// TEST-ONLY: AGENTCHAT_TOKEN_FOR_TESTS replaces the keychain lookup so automated tests never touch
// the real keychain. It is not a supported way to configure the server.
const testToken = process.env.AGENTCHAT_TOKEN_FOR_TESTS;
const getToken = () => (testToken !== undefined ? testToken : readTokenFromKeychain());

const server = buildMcpServer({ as, client: createHubClient({ baseUrl, as, getToken }), invokedByHub });
await server.connect(new StdioServerTransport());
process.stderr.write(`agent-chat mcp ready (as ${as}${invokedByHub ? ', no tools: invoked by hub' : ''})\n`);
