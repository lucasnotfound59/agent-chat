import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, CodexAdapter, DshAdapter, OpenCodeAdapter, dshModelPatch } from '@agent-chat/adapters';
import type { AgentAdapter, Availability } from '@agent-chat/adapters';
import { seed } from './bootstrap';
import { ConfigStore } from './config';
import { Scheduler } from './scheduler';
import { Bus, buildServer } from './server';
import { Store } from './store';
import { OpenAITriage } from './triage';

const dataDir = process.env.AGENTCHAT_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'AgentChat');
const port = Number(process.env.AGENTCHAT_PORT ?? 4317);

mkdirSync(dataDir, { recursive: true });
const config = new ConfigStore(dataDir);
const store = new Store(join(dataDir, 'agentchat.db'));
const bus = new Bus();

const dshPatchFile = join(dataDir, 'dsh-model.patch.yml');
const dshPatchPath = (): string | null => {
  const dsh = config.get().dsh;
  if (!dsh) return null;
  writeFileSync(dshPatchFile, dshModelPatch(dsh.provider, dsh.model));
  return dshPatchFile;
};

const adapterList: AgentAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new OpenCodeAdapter(),
  new DshAdapter({ patchPath: dshPatchPath }),
];
const adapters = new Map(adapterList.map((a) => [a.name, a]));
const availability = new Map<string, Availability>();

async function refreshAvailability(): Promise<void> {
  await Promise.all(
    adapterList.map(async (a) => {
      availability.set(a.name, await a.check().catch(() => ({ ok: false, reason: '检查失败' })));
    }),
  );
}

seed(store, adapterList);
const interrupted = store.markUnfinishedInterrupted();

const scheduler = new Scheduler({
  store,
  adapters,
  triage: () => {
    const t = config.get().triage;
    return t && t.apiKey ? new OpenAITriage(t) : null;
  },
  emit: (e) => bus.emit(e),
  dataDir,
  isAvailable: (name) => availability.get(name)?.ok ?? false,
});

const app = buildServer({ store, scheduler, config, bus, availability });

await refreshAvailability();
setInterval(() => void refreshAvailability(), 60000).unref();
await app.listen({ port, host: '127.0.0.1' });

console.log(`Agent Chat hub: http://127.0.0.1:${port}`);
console.log(`数据目录: ${dataDir}`);
console.log(`令牌保存在: ${join(dataDir, 'config.json')}`);
if (interrupted > 0) console.log(`上次有 ${interrupted} 次唤起未完成，已标记为中断。`);
for (const a of adapterList) {
  const s = availability.get(a.name)!;
  console.log(`  ${a.displayName}: ${s.ok ? '可用' : `不可用（${s.reason}）`}`);
}

const shutdown = async () => {
  scheduler.stopAll();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
