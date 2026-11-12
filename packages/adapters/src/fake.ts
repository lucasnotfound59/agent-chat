import type { AgentAdapter, Availability, CompleteRequest, InvokeRequest, InvokeResult } from './types';

export class FakeAdapter implements AgentAdapter {
  readonly defaultBio = 'fake agent for tests';
  calls: InvokeRequest[] = [];
  availability: Availability = { ok: true };
  handler: (req: InvokeRequest) => Promise<InvokeResult>;
  completeCalls: CompleteRequest[] = [];
  completeHandler: (req: CompleteRequest) => Promise<string> = async () => '{"speakers":[]}';

  constructor(public readonly name: string, public readonly displayName: string) {
    this.handler = async () => ({
      kind: 'reply',
      body: `reply from ${displayName}`,
      harnessSessionId: `${name}-session`,
    });
  }

  async check(): Promise<Availability> {
    return this.availability;
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.calls.push(req);
    return this.handler(req);
  }

  async complete(req: CompleteRequest): Promise<string> {
    this.completeCalls.push(req);
    return this.completeHandler(req);
  }
}
