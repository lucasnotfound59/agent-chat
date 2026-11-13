// Hub for the Playwright tests: two fake agents, a fixed test token, a temp data dir. It never touches
// the keychain, a real agent CLI or the user's data, and never opens a browser.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterError, FakeAdapter } from '@agent-chat/adapters';
import type { InvokeRequest, InvokeResult } from '@agent-chat/adapters';
import { AskService } from '../src/ask';
import { AvailabilityMonitor } from '../src/availability';
import { seed } from '../src/bootstrap';
import { ConfigStore } from '../src/config';
import { Scheduler } from '../src/scheduler';
import { Bus, buildServer } from '../src/server';
import { Store } from '../src/store';

const port = Number(process.env.E2E_PORT ?? 4399);
const TOKEN = 'e2e-token';
const dataDir = mkdtempSync(join(tmpdir(), 'agentchat-e2e-'));

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      fail(new AdapterError('aborted', 'aborted'));
    }, { once: true });
  });

/** Answers "reply from <name>: <last message>" after 300 ms, or 4 s when the message contains SLOW. */
function fake(name: string, displayName: string): FakeAdapter {
  const a = new FakeAdapter(name, displayName);
  a.handler = async (req: InvokeRequest): Promise<InvokeResult> => {
    const last = req.newMessages.at(-1)?.body ?? '';
    await wait(last.includes('SLOW') ? 4000 : 300, req.signal);
    return { kind: 'reply', body: `reply from ${displayName}: ${last}`, harnessSessionId: `${name}-session` };
  };
  return a;
}

const adapters = [fake('fake-a', 'Alpha'), fake('fake-b', 'Beta')];
const store = new Store(join(dataDir, 'agentchat.db'));
seed(store, adapters);
const bus = new Bus();
const monitor = new AvailabilityMonitor(adapters, (e) => bus.emit(e));
await monitor.refresh();
const isAvailable = (n: string) => monitor.map.get(n)?.ok ?? false;
const scheduler = new Scheduler({
  store,
  adapters: new Map(adapters.map((a) => [a.name, a])),
  triage: () => null,
  emit: (e) => bus.emit(e),
  dataDir,
  isAvailable,
});
const ask = new AskService({ store, scheduler, isAvailable, availabilityReason: (n) => monitor.map.get(n)?.reason, emit: (e) => bus.emit(e) });
const app = buildServer({
  store,
  scheduler,
  config: new ConfigStore(dataDir),
  token: () => TOKEN,
  bus,
  availability: monitor.map,
  ask,
  refreshAvailability: () => monitor.refresh(),
  webRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e hub listening on http://127.0.0.1:${port}`);
