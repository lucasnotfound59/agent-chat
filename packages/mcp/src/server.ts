import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HubUnreachableError, type HubClient } from './hubClient';

const HUB_DOWN = 'Agent Chat hub is not running. Ask the user to start it (npm run hub), then try again.';

const ASK_DESCRIPTION = [
  'Ask another agent in Agent Chat a question and wait for its answer.',
  'Use this when you are stuck, or when you want a second opinion or a review from a different model.',
  'The other agent cannot see your workspace or this conversation, so include all the background it needs in the question itself (relevant code, error messages, what you already tried).',
  'A call may take one to two minutes to return.',
  'Call list_members first to see who you can ask.',
].join(' ');

const LIST_DESCRIPTION =
  'List the agents you can ask with the ask tool: one line per member with name, bio and availability (with the reason when unavailable). Call this before ask.';

function fail(err: unknown) {
  const text = err instanceof HubUnreachableError ? HUB_DOWN : err instanceof Error ? err.message : String(err);
  return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

export function buildMcpServer(opts: { as: string; client: HubClient; invokedByHub: boolean }): McpServer {
  const server = new McpServer({ name: 'agent-chat', version: '0.1.0' });

  const listMembers = server.registerTool('list_members', { description: LIST_DESCRIPTION }, async () => {
    try {
      const all = await opts.client.listMembers();
      const lines = all
        .filter((m) => m.kind !== 'human' && m.name !== opts.as && m.adapter !== opts.as)
        .map((m) => {
          const status = m.available ? 'available' : `unavailable: ${m.reason || 'unknown reason'}`;
          return `${m.name} - ${m.bio} [${status}]`;
        });
      return { content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') : 'No other agents are available.' }] };
    } catch (err) {
      return fail(err);
    }
  });

  const ask = server.registerTool(
    'ask',
    {
      description: ASK_DESCRIPTION,
      inputSchema: {
        to: z.string().describe('Name of the member to ask, as shown by list_members'),
        question: z.string().describe('The question, with all the background the other agent needs'),
      },
    },
    async ({ to, question }, extra) => {
      try {
        const reply = await opts.client.ask(to, question, extra.signal);
        return { content: [{ type: 'text' as const, text: reply }] };
      } catch (err) {
        return fail(err);
      }
    },
  );

  // An agent run by the hub itself must not be able to ask further agents. The tools are registered
  // and then disabled (rather than skipped) so the server still answers tools/list, with an empty list.
  if (opts.invokedByHub) {
    listMembers.disable();
    ask.disable();
  }

  return server;
}
