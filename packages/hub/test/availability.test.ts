import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '@agent-chat/adapters';
import { AvailabilityMonitor } from '../src/availability';
import type { HubEvent } from '../src/types';

describe('AvailabilityMonitor', () => {
  it('fills the map and emits an availability event only when something changed', async () => {
    const a = new FakeAdapter('fake-a', 'A');
    const b = new FakeAdapter('fake-b', 'B');
    b.availability = { ok: false, reason: '未登录' };
    const events: HubEvent[] = [];
    const m = new AvailabilityMonitor([a, b], (e) => events.push(e));

    await m.refresh();
    expect(m.map.get('fake-a')).toEqual({ ok: true });
    expect(m.map.get('fake-b')).toEqual({ ok: false, reason: '未登录' });
    expect(events).toHaveLength(2);

    await m.refresh();
    expect(events).toHaveLength(2);

    b.availability = { ok: true };
    await m.refresh();
    expect(events.slice(2)).toEqual([{ type: 'availability', adapter: 'fake-b', availability: { ok: true } }]);
  });

  it('counts a failing check as unavailable', async () => {
    const a = new FakeAdapter('fake-a', 'A');
    a.check = async () => {
      throw new Error('boom');
    };
    const m = new AvailabilityMonitor([a], () => {});
    await m.refresh();
    expect(m.map.get('fake-a')).toEqual({ ok: false, reason: '检查失败' });
  });

  it('lets concurrent refreshes share one round of checks', async () => {
    const a = new FakeAdapter('fake-a', 'A');
    let checks = 0;
    a.check = async () => {
      checks++;
      return { ok: true };
    };
    const m = new AvailabilityMonitor([a], () => {});
    await Promise.all([m.refresh(), m.refresh()]);
    expect(checks).toBe(1);
  });
});
