import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, CodexAdapter, DshAdapter, OpenCodeAdapter, dshModelPatch } from '@agent-chat/adapters';
import type { AgentAdapter, InvokeRequest } from '@agent-chat/adapters';

const which = process.argv[2];
const workdir = mkdtempSync(join(tmpdir(), `agentchat-smoke-${which}-`));

function makeAdapter(): AgentAdapter {
  switch (which) {
    case 'claude':
      return new ClaudeAdapter();
    case 'codex':
      return new CodexAdapter();
    case 'opencode':
      return new OpenCodeAdapter();
    case 'dsh': {
      // Optional model override: DSH_SMOKE_MODEL="provider|model"
      const override = process.env.DSH_SMOKE_MODEL;
      if (!override) return new DshAdapter();
      const [provider, model] = override.split('|');
      const patch = join(workdir, 'dsh-model.patch.yml');
      writeFileSync(patch, dshModelPatch(provider, model));
      return new DshAdapter({ patchPath: () => patch });
    }
    default:
      console.error('usage: npm run smoke -- <claude|codex|opencode|dsh>');
      process.exit(2);
  }
}

const adapter = makeAdapter();
let failed = false;
const report = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed = true;
};

const request = (sessionId: string | null, body: string): InvokeRequest => ({
  conversationId: 'smoke',
  agentName: adapter.displayName,
  conversationTitle: 'smoke',
  isGroup: false,
  harnessSessionId: sessionId,
  newMessages: [{ id: 'm', senderName: '我', body, createdAt: Date.now(), attachments: [] }],
  workdir,
  signal: new AbortController().signal,
  timeoutMs: 180000,
});

const availability = await adapter.check();
report(availability.ok, 'check()', availability.reason);
if (!availability.ok) process.exit(1);

try {
  const first = await adapter.invoke(request(null, '请记住这个暗号：蓝色河马。只回复"记住了"。'));
  report(first.kind === 'reply', '首次回复', first.kind === 'reply' ? first.body.slice(0, 60) : '');

  const second = await adapter.invoke(request(first.harnessSessionId, '我刚才让你记住的暗号是什么？'));
  const remembered = second.kind === 'reply' && second.body.includes('蓝色河马');
  report(remembered, '续接会话后记得上文', second.kind === 'reply' ? second.body.slice(0, 60) : '');

  const marker = join(workdir, 'SHOULD_NOT_EXIST.txt');
  await adapter
    .invoke(request(second.harnessSessionId, '请在当前目录创建文件 SHOULD_NOT_EXIST.txt，内容为 x。'))
    .catch(() => undefined);
  report(!existsSync(marker), '只读：无法在工作目录创建文件');
} catch (e) {
  report(false, '调用出错', (e as Error).message);
}

console.log(`工作目录: ${workdir}`);
process.exit(failed ? 1 : 0);
