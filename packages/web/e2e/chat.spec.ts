import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const TOKEN = 'e2e-token';
const auth = { authorization: `Bearer ${TOKEN}` };

async function open(page: Page) {
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.getByText('已连接 hub')).toBeVisible();
}
const conv = (page: Page, title: string) => page.getByRole('navigation').getByRole('button', { name: title, exact: true });
const box = (page: Page) => page.getByLabel('消息');
async function send(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press('Enter');
}
async function newGroup(page: Page, title: string, members: string[]) {
  await page.getByRole('button', { name: '＋ 群聊' }).click();
  const dialog = page.getByRole('dialog', { name: '新建群聊' });
  await dialog.getByLabel('群名').fill(title);
  for (const m of members) await dialog.getByLabel(m, { exact: true }).check();
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('opens with the token, wipes it from the address bar and remembers it', async ({ page }) => {
  await open(page);
  expect(page.url()).not.toContain('token');
  await expect(conv(page, 'Alpha')).toBeVisible();
  await expect(conv(page, 'Beta')).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('已连接 hub')).toBeVisible();
});

test('private chat: typing indicator, then the reply', async ({ page }) => {
  await open(page);
  await conv(page, 'Alpha').click();
  await send(page, 'SLOW 你好-1');
  await expect(page.getByLabel('Alpha 正在输入')).toBeVisible();
  await expect(page.getByText('reply from Alpha: SLOW 你好-1', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByLabel('Alpha 正在输入')).toHaveCount(0);
});

test('new group with an @mention: only the mentioned agent answers', async ({ page }) => {
  await open(page);
  await newGroup(page, 'e2e 群', ['Alpha', 'Beta']);
  await box(page).fill('看看这个 @Be');
  await page.getByRole('option', { name: '@Beta' }).click();
  await box(page).press('Enter');
  await expect(page.getByText('reply from Beta: 看看这个 @Beta', { exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByText(/reply from Alpha: 看看这个/)).toHaveCount(0);
});

test('pausing a group holds the question until it is resumed', async ({ page }) => {
  await open(page);
  await newGroup(page, 'e2e 暂停群', ['Alpha']);
  await page.getByRole('button', { name: '⏸ 暂停本群' }).click();
  await expect(page.getByRole('button', { name: '▶ 恢复本群' })).toBeVisible();
  await send(page, '@Alpha 暂停中-1');
  await page.waitForTimeout(1500);
  await expect(page.getByText('reply from Alpha: @Alpha 暂停中-1')).toHaveCount(0);
  await page.getByRole('button', { name: '▶ 恢复本群' }).click();
  await expect(page.getByText('reply from Alpha: @Alpha 暂停中-1', { exact: true })).toBeVisible({ timeout: 10000 });
});

test('stop all interrupts a reply in progress; resume answers the question again', async ({ page }) => {
  await open(page);
  await conv(page, 'Beta').click();
  await send(page, 'SLOW 停止-1');
  await expect(page.getByLabel('Beta 正在输入')).toBeVisible();
  await page.getByRole('button', { name: '■ 全部停止' }).click();
  await expect(page.getByRole('button', { name: '▶ 恢复', exact: true })).toBeVisible();
  await expect(page.getByLabel('Beta 正在输入')).toHaveCount(0);
  await page.getByRole('button', { name: '▶ 恢复', exact: true }).click();
  await expect(page.getByText('reply from Beta: SLOW 停止-1', { exact: true })).toBeVisible({ timeout: 10000 });
});

test('an ask between agents shows up, and the human can join in', async ({ page, request }) => {
  await open(page);
  const r = await request.post('/api/ask', { headers: auth, data: { as: 'fake-b', to: 'Alpha', question: 'ask 问题-1' } });
  expect(r.ok()).toBeTruthy();
  await conv(page, 'Beta → Alpha').click();
  await expect(page.getByText('reply from Alpha: ask 问题-1', { exact: true })).toBeVisible();
  await send(page, '插话-1');
  await expect(page.getByText('reply from Alpha: 插话-1', { exact: true })).toBeVisible();
});

test('after the connection drops, the page reconnects and catches up', async ({ page, request }) => {
  let first: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer();
    first ??= ws;
  });
  await open(page);
  await conv(page, 'Alpha').click();
  await first!.close();
  await expect(page.getByText('连接中断，正在重连…')).toBeVisible();
  const state = await (await request.get('/api/state', { headers: auth })).json();
  const dm = state.conversations.find((c: { kind: string; title: string }) => c.kind === 'dm' && c.title === 'Alpha');
  await request.post(`/api/conversations/${dm.id}/messages`, { headers: auth, data: { body: '断线时-1' } });
  await expect(page.getByText('reply from Alpha: 断线时-1', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('已连接 hub')).toBeVisible();
});
