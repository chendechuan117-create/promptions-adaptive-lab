import { test, expect, type Page } from '@playwright/test';

// These are local parent-bridge simulations, not evidence of ChatGPT compatibility.
const widget = (page: Page) => page.frameLocator('iframe');
async function open(page: Page, query = '') {
  await page.goto('/' + query);
  await expect(widget(page).getByRole('button', { name: /通勤是否顺畅/ })).toBeEnabled();
}
async function messages(page: Page) { return page.evaluate(() => (window as any).probeHost.messages); }

test('initializes standard JSON-RPC and renders four notification-supplied directions', async ({ page }) => {
  await open(page);
  const log = await messages(page);
  expect(log[0]).toMatchObject({ jsonrpc: '2.0', method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'ThoughtScout probe' }, appCapabilities: { availableDisplayModes: ['inline'] } } });
  expect(log.some(m => m.method === 'ui/notifications/initialized')).toBeTruthy();
  expect(log.some(m => m.method === 'tools/call')).toBeFalsy();
  await expect(widget(page).locator('#cards button')).toHaveCount(4);
  await expect(widget(page).getByText('接入演示 · 固定示例，不调用 DeepSeek')).toBeVisible();
  await expect(widget(page).getByText(/不是已确认事实/)).toBeVisible();
});

test('one click expands; previous choices and current unsaved note are handed off in order', async ({ page }) => {
  await open(page);
  const frame = widget(page);
  await frame.getByRole('button', { name: /通勤是否顺畅/ }).click();
  await expect(frame.getByRole('button', { name: /通勤时长/ })).toBeVisible();
  await frame.getByRole('button', { name: /通勤时长/ }).click();
  await frame.getByRole('button', { name: /返回四个方向/ }).click();
  await frame.getByRole('button', { name: /能否安心休息/ }).click();
  await frame.getByRole('button', { name: /夜间噪声/ }).click();
  const note = '刚输入但尚未单独提交：夜间安静 <b>很重要</b>';
  await frame.getByRole('textbox', { name: /补充想法/ }).fill(note);
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expect(frame.getByRole('button', { name: '已交给 ChatGPT' })).toBeDisabled();
  const log = await messages(page);
  const relevant = log.filter(m => ['tools/call', 'ui/update-model-context', 'ui/message'].includes(m.method));
  expect(relevant.map(m => m.method)).toEqual(['tools/call', 'tools/call', 'tools/call', 'ui/update-model-context', 'ui/message']);
  expect(relevant[0].params).toEqual({ name: 'expand_prethink_probe', arguments: { focus: 'commute' } });
  expect(relevant[2].params).toEqual({ name: 'prepare_probe_handoff', arguments: { selected_ids: ['commute', 'commute-time', 'rest', 'rest-noise'], note } });
  expect(relevant[3].params.structuredContent.note).toBe(note);
  expect(relevant[3].params.content[0].text).toContain(note);
  expect(relevant[4].params).toMatchObject({ role: 'user', content: [{ type: 'text' }] });
  expect(relevant[4].params.content[0].text).toContain(note);
  expect(relevant[4].params.content[0].text).toContain('不是已确认事实');
});

for (const failure of ['context', 'context-result', 'prepare']) {
  test(`${failure} failure prevents sending and permits an explicit corrected retry`, async ({ page }) => {
    await open(page, '?failure=' + failure);
    const frame = widget(page);
    await frame.getByRole('textbox').fill('保留这段当前补充');
    await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
    await expect(frame.getByRole('status')).toContainText('尚未发送');
    expect((await messages(page)).filter(m => m.method === 'ui/message')).toHaveLength(0);
    await expect(frame.getByRole('textbox')).toHaveValue('保留这段当前补充');
    await page.evaluate(() => { (window as any).probeHost.failure = null; });
    await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
    await expect(frame.getByRole('status')).toContainText('宿主已接受消息');
    expect((await messages(page)).filter(m => m.method === 'ui/message')).toHaveLength(1);
  });
}

test('expansion error preserves selection and recovers with a single new click', async ({ page }) => {
  await open(page, '?failure=expand');
  const frame = widget(page);
  await frame.getByRole('button', { name: /通勤是否顺畅/ }).click();
  await expect(frame.getByRole('status')).toContainText('已保留选择');
  await expect(frame.getByRole('button', { name: '移除 通勤是否顺畅' })).toBeEnabled();
  await page.evaluate(() => { (window as any).probeHost.failure = null; });
  await frame.locator('#cards button').filter({ hasText: '通勤是否顺畅' }).click();
  await expect(frame.getByRole('button', { name: /通勤时长/ })).toBeVisible();
});

test('unknown message delivery times out without offering blind resend', async ({ page }) => {
  await page.clock.install();
  await open(page, '?failure=message-timeout');
  const frame = widget(page);
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expect(frame.getByRole('status')).toContainText('正在交给 ChatGPT');
  await page.clock.fastForward(13000);
  await expect(frame.getByRole('status')).toContainText('发送结果未确认');
  await expect(frame.getByRole('button', { name: '交给 ChatGPT 回答' })).toBeDisabled();
  expect((await messages(page)).filter(m => m.method === 'ui/message')).toHaveLength(1);
});

test('late initial notification cannot release a manual reload or replace its view', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?failure=initial-delay');
  const frame = widget(page);
  await expect(frame.getByRole('status')).toContainText('等待初始工具结果');
  await page.clock.fastForward(13000);
  await frame.getByRole('button', { name: '重新加载示例' }).click();
  await expect.poll(async () => (await messages(page)).filter(m => m.method === 'tools/call').length).toBe(1);
  await page.evaluate(() => {
    const fixture = (window as any).probeHost;
    document.querySelector('iframe')!.contentWindow!.postMessage(fixture.notifications[0], location.origin);
  });
  await expect(frame.getByRole('status')).toContainText('正在加载固定示例');
  await expect(frame.locator('#cards button')).toHaveCount(0);
  await expect(frame.getByRole('button', { name: '交给 ChatGPT 回答' })).toBeDisabled();
  await page.evaluate(() => (window as any).probeHost.finishLoad());
  await frame.getByRole('button', { name: /通勤是否顺畅/ }).click();
  await expect(frame.getByRole('button', { name: /通勤时长/ })).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).probeHost;
    document.querySelector('iframe')!.contentWindow!.postMessage(fixture.notifications[0], location.origin);
  });
  await expect(frame.getByRole('button', { name: /通勤时长/ })).toBeVisible();
});

test('375px viewport fits, text is escaped, and note has a 400-character boundary', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?escape=1');
  const frame = widget(page);
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('<img src=x onerror="window.injected=true">');
  await expect(frame.getByRole('button', { name: /<script>/ })).toBeEnabled();
  await expect(frame.locator('img')).toHaveCount(0);
  expect(await page.frames()[1].evaluate(() => (window as any).injected)).toBeUndefined();
  expect(await frame.getByRole('textbox').getAttribute('maxlength')).toBe('400');
  const widths = await page.frames()[1].evaluate(() => ({ actual: document.documentElement.scrollWidth, available: window.innerWidth }));
  expect(widths.actual).toBeLessThanOrEqual(widths.available);
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).focus();
  await expect(frame.getByRole('button', { name: '交给 ChatGPT 回答' })).toBeFocused();
});

test('text-only context host receives no unadvertised structured content', async ({ page }) => {
  await open(page, '?failure=text-only');
  const frame = widget(page);
  await frame.getByRole('textbox').fill('纯文本宿主也保留补充');
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expect(frame.getByRole('status')).toContainText('宿主已接受消息');
  const context = (await messages(page)).find(m => m.method === 'ui/update-model-context');
  expect(context.params.structuredContent).toBeUndefined();
  expect(context.params.content[0].text).toContain('纯文本宿主也保留补充');
});

test('image-only host is rejected before offering text handoff', async ({ page }) => {
  await page.goto('/?failure=image-only');
  const frame = widget(page);
  await expect(frame.getByRole('status')).toContainText('宿主未声明文本消息');
  await expect(frame.getByRole('button', { name: '交给 ChatGPT 回答' })).toBeDisabled();
  expect((await messages(page)).some(m => m.method === 'ui/notifications/initialized')).toBeFalsy();
});

test('selection boundary remains 12 across all four directions', async ({ page }) => {
  await open(page);
  const frame = widget(page);
  for (const label of ['通勤是否顺畅', '能否安心休息', '日常生活便利']) {
    await frame.locator('#cards button').filter({ hasText: label }).click();
    const cards = frame.locator('#cards button');
    await expect(cards).toHaveCount(3);
    for (let i = 0; i < 3; i++) await cards.nth(i).click();
    await frame.getByRole('button', { name: /返回四个方向/ }).click();
  }
  await expect(frame.locator('#selected button')).toHaveCount(12);
  await frame.locator('#cards button').filter({ hasText: '费用与取舍' }).click();
  await expect(frame.getByRole('status')).toContainText('最多保留 12 个方向');
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expect(frame.getByRole('status')).toContainText('宿主已接受消息');
  const handoff = (await messages(page)).find(m => m.params?.name === 'prepare_probe_handoff');
  expect(handoff.params.arguments.selected_ids).toHaveLength(12);
});
