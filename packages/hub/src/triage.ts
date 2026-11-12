import type { AgentAdapter } from '@agent-chat/adapters';

export interface TriageInput {
  transcript: { sender: string; body: string }[];
  candidates: { id: string; name: string; bio: string }[];
}

export interface Triage {
  /** Returns candidate ids in speaking order; may be empty. */
  pick(input: TriageInput): Promise<string[]>;
}

const SYSTEM = [
  'You moderate a group chat between a human and several AI agents.',
  'Given the recent messages and the agents who could speak, decide which agents should speak next and in what order.',
  'Pick an agent only if it can add something the conversation needs. Prefer few speakers.',
  'Return an empty list when nobody needs to respond, for example after a simple acknowledgement or when the topic has reached a natural end.',
  'Answer with JSON only: {"speakers": ["exact agent name", ...]}',
].join(' ');

export function parseSpeakers(content: string, candidates: TriageInput['candidates']): string[] {
  const obj = JSON.parse(content);
  const names: unknown[] = Array.isArray(obj?.speakers) ? obj.speakers : [];
  const ids: string[] = [];
  for (const name of names) {
    const c = candidates.find((x) => x.name === name);
    if (c && !ids.includes(c.id)) ids.push(c.id);
  }
  return ids;
}

export const TRIAGE_ORDER = ['dsh', 'opencode', 'codex', 'claude'] as const;

export function pickTriageAdapter(
  setting: string | null,
  adapters: Map<string, AgentAdapter>,
  isAvailable: (name: string) => boolean,
): AgentAdapter | null {
  if (setting === 'off') return null;
  if (setting !== null) {
    const a = adapters.get(setting);
    return a && isAvailable(a.name) ? a : null;
  }
  for (const name of TRIAGE_ORDER) {
    const a = adapters.get(name);
    if (a && isAvailable(name)) return a;
  }
  return null;
}

export class AgentTriage implements Triage {
  constructor(
    private readonly adapter: AgentAdapter,
    private readonly workdir: string,
    private readonly timeoutMs: number = 60000,
  ) {}

  async pick(input: TriageInput): Promise<string[]> {
    const prompt = [
      SYSTEM,
      '',
      'Agents who could speak:',
      ...input.candidates.map((c) => `- ${c.name}: ${c.bio}`),
      '',
      'Recent messages:',
      ...input.transcript.map((m) => `${m.sender}: ${m.body}`),
      '',
      'Output only the JSON object {"speakers": [...]} and nothing else.',
    ].join('\n');
    const text = await this.adapter.complete({
      prompt,
      workdir: this.workdir,
      signal: new AbortController().signal,
      timeoutMs: this.timeoutMs,
    });
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('triage reply contains no JSON object');
    return parseSpeakers(text.slice(start, end + 1), input.candidates);
  }
}
