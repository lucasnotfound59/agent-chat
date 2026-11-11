import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, CodexAdapter, DshAdapter, OpenCodeAdapter, dshModelPatch } from '@agent-chat/adapters';
import type { AgentAdapter, InvokeRequest } from '@agent-chat/adapters';

const which = process.argv[2];
const usage = 'usage: npm run smoke -- <claude|codex|opencode|dsh>   (dsh: optional DSH_SMOKE_MODEL="provider|model")';
if (!['claude', 'codex', 'opencode', 'dsh'].includes(which ?? '')) {
  console.error(usage);
  process.exit(2);
}
const smokeModel = process.env.DSH_SMOKE_MODEL;
if (which === 'dsh' && smokeModel && !smokeModel.includes('|')) {
  console.error('DSH_SMOKE_MODEL must look like "provider|model" (missing "|").');
  process.exit(2);
}
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
      if (!smokeModel) return new DshAdapter();
      const bar = smokeModel.indexOf('|');
      const provider = smokeModel.slice(0, bar);
      const model = smokeModel.slice(bar + 1);
      const patch = join(workdir, 'dsh-model.patch.yml');
      writeFileSync(patch, dshModelPatch(provider, model));
      return new DshAdapter({ patchPath: () => patch });
    }
    default:
      console.error(usage);
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

/** One write-attempt step: the call must return a reply, and the file must not exist afterwards. */
async function readOnlyStep(label: string, sessionId: string | null, prompt: string, fileName: string): Promise<string | null> {
  let result;
  try {
    result = await adapter.invoke(request(sessionId, prompt));
  } catch (e) {
    report(false, `${label}（调用失败）`, (e as Error).message);
    return sessionId;
  }
  if (result.kind !== 'reply') {
    report(false, `${label}（调用失败）`, `结果类型为 ${result.kind}，不是 reply`);
    return result.harnessSessionId ?? sessionId;
  }
  console.log(`      回复前 200 字: ${result.body.slice(0, 200).replace(/\s+/g, ' ')}`);
  const created = existsSync(join(workdir, fileName));
  report(!created, label, created ? `${fileName} 被创建了` : `${fileName} 不存在`);
  return result.harnessSessionId ?? sessionId;
}

try {
  const first = await adapter.invoke(request(null, '请记住这个暗号：蓝色河马。只回复"记住了"。'));
  const firstOk = first.kind === 'reply' && first.body.trim().length > 0;
  report(firstOk, '首次回复', first.kind === 'reply' ? first.body.slice(0, 60) : `结果类型 ${first.kind}`);

  const second = await adapter.invoke(request(first.harnessSessionId, '我刚才让你记住的暗号是什么？'));
  const remembered = second.kind === 'reply' && second.body.includes('蓝色河马');
  report(remembered, '续接会话后记得上文', second.kind === 'reply' ? second.body.slice(0, 60) : '');

  const sid = await readOnlyStep(
    '只读(1)：请求创建文件',
    second.harnessSessionId,
    '请在当前目录创建文件 SHOULD_NOT_EXIST.txt，内容为 x。',
    'SHOULD_NOT_EXIST.txt',
  );
  await readOnlyStep(
    '只读(2)：显式要求用 shell 工具 touch',
    sid,
    '请使用你的 shell 或命令执行工具，在当前目录运行 `touch SHOULD_NOT_EXIST_2.txt`，然后告诉我是否成功。',
    'SHOULD_NOT_EXIST_2.txt',
  );
} catch (e) {
  report(false, '调用出错', (e as Error).message);
}

console.log(`工作目录: ${workdir}`);
process.exit(failed ? 1 : 0);
