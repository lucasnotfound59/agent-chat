import type { AgentAdapter, Availability } from '@agent-chat/adapters';
import type { HubEvent } from './types';

/** Holds each adapter's availability; `refresh()` re-checks all and emits one event per change. */
export class AvailabilityMonitor {
  readonly map = new Map<string, Availability>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly adapters: AgentAdapter[],
    private readonly emit: (e: HubEvent) => void,
  ) {}

  /** Concurrent callers share one round of checks. */
  refresh(): Promise<void> {
    this.running ??= this.checkAll().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async checkAll(): Promise<void> {
    await Promise.all(
      this.adapters.map(async (a) => {
        const next = await a.check().catch((): Availability => ({ ok: false, reason: '检查失败' }));
        const prev = this.map.get(a.name);
        this.map.set(a.name, next);
        if (!prev || prev.ok !== next.ok || (prev.reason ?? '') !== (next.reason ?? '')) {
          this.emit({ type: 'availability', adapter: a.name, availability: next });
        }
      }),
    );
  }
}
