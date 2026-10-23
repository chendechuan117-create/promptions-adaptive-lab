import { test, expect, type Page } from '@playwright/test';

// Local MCP Apps parent simulation. Passing tests establish UI/bridge behavior,
// not ChatGPT compatibility, model quality, or live DeepSeek availability.
const widget = (page: Page) => page.frameLocator('iframe');
const calls = (page: Page) => page.evaluate(() => (window as any).liveHost.toolCalls as { name: string; args: any }[]);
const messages = (page: Page) => page.evaluate(() => (window as any).liveHost.messages as any[]);
async function generations(page: Page) { return (await calls(page)).filter(call => call.name === 'generate_prethink_cues'); }
async function open(page: Page, goal: string, extra: Record<string, string> = {}) {
  await page.goto('/?' + new URLSearchParams({ goal, ...extra }));
  await expect(widget(page).getByTestId('cue-option')).toHaveCount(4);
}

for (const goal of ['为社区图书角组织一次旧书交换', '修好自行车后安排首次试骑']) {
  test(`arbitrary goal follows two immediate clicks into three rounds: ${goal}`, async ({ page }) => {
    await open(page, goal);
    const frame = widget(page);
    const firstLabel = await frame.getByTestId('cue-option').first().getAttribute('aria-label');
    await frame.getByTestId('cue-option').first().click();
    await expect.poll(async () => (await generations(page)).length).toBe(2);
    await expect(frame.getByTestId('cue-option').first()).toBeEnabled();
    const secondLabel = await frame.getByTestId('cue-option').first().getAttribute('aria-label');
    await frame.getByTestId('cue-option').first().click();
    await expect.poll(async () => (await generations(page)).length).toBe(3);
    await expect(frame.getByTestId('cue-option').first()).toBeEnabled();
    const generated = await generations(page);
    expect(generated.every(call => call.args.goal === goal && call.args.mode === 'cues')).toBeTruthy();
    expect(generated.map(call => call.args.parentRequestId)).toEqual([null, generated[0].args.requestId, generated[1].args.requestId]);
    expect(generated.map(call => call.args.selected.map(option => option.label))).toEqual([[], [firstLabel], [secondLabel]]);
    expect(generated.map(call => call.args.note)).toEqual(['', '', '']);
    expect(generated.every(call => !('rounds' in call.args))).toBeTruthy();
    expect(new Set(generated.map(call => call.args.requestId)).size).toBe(3);
    expect(generated[0].args.clientId).toBe(generated[2].args.clientId);
    expect(generated[0].args.version).toBeLessThan(generated[2].args.version);
    await frame.locator('.history summary').click();
    await expect(frame.locator('.history')).toContainText(firstLabel!);
    await expect(frame.locator('.history')).toContainText(secondLabel!);
    expect((await calls(page)).some(call => call.args.mode === 'answer')).toBeFalsy();
  });
}

test('blank initial goal waits for user input and never inserts the fixed accommodation demo', async ({ page }) => {
  await page.goto('/');
  const frame = widget(page);
  await expect(frame.getByLabel('你的问题', { exact: true })).toHaveValue('');
  await expect(frame.getByRole('button', { name: '生成联想线索' })).toBeDisabled();
  expect(await generations(page)).toHaveLength(0);
  await frame.getByLabel('你的问题', { exact: true }).fill('给家里阳台安排一个小型菜园');
  await frame.getByRole('button', { name: '生成联想线索' }).click();
  await expect(frame.getByTestId('cue-option')).toHaveCount(4);
  expect((await generations(page))[0].args.goal).toBe('给家里阳台安排一个小型菜园');
  await expect(frame.getByText('挑选住宿，兼顾通勤与日常生活')).toHaveCount(0);
});

test('multiselect and notes affect the next request, history and awaited handoff', async ({ page }) => {
  const goal = '为社区图书角组织一次旧书交换';
  await open(page, goal, { holdContext: '1' });
  const frame = widget(page);
  await frame.getByRole('button', { name: '开启多选' }).click();
  await frame.getByTestId('cue-option').nth(0).click();
  await frame.getByTestId('cue-option').nth(1).click();
  const note = '有老人和儿童参加，雨天移到室内';
  await frame.getByLabel('当前补充').fill(note);
  await frame.getByRole('button', { name: '沿所选方向继续' }).click();
  await expect.poll(async () => (await generations(page)).length).toBe(2);
  await expect(frame.getByTestId('cue-option').first()).toBeEnabled();
  const generated = await generations(page);
  expect(generated[1].args.selected.map(option => option.label)).toEqual(['参与人群', '交换规则']);
  expect(generated[1].args.note).toBe(note);
  expect(generated[1].args.parentRequestId).toBe(generated[0].args.requestId);
  expect(generated.every(call => !('rounds' in call.args))).toBeTruthy();
  await expect(frame.getByTestId('cue-option').first()).toContainText(note);
  await frame.locator('.history summary').click();
  await expect(frame.locator('.history')).toContainText(note);
  const unsentNote = '刚输入的新补充：每人最多换三本 <b>并非网页代码</b>';
  await frame.getByLabel('当前补充').fill(unsentNote);
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expect.poll(async () => (await messages(page)).filter(message => message.method === 'ui/update-model-context').length).toBe(1);
  expect((await messages(page)).filter(message => message.method === 'ui/message')).toHaveLength(0);
  const prepared = (await calls(page)).find(call => call.name === 'prepare_prethink_handoff')!;
  expect(prepared.args.goal).toBe(goal);
  expect(prepared.args.clientId).toBe(generated[1].args.clientId);
  expect(prepared.args.parentRequestId).toBe(generated[1].args.requestId);
  expect(prepared.args.selected).toEqual([]);
  expect(prepared.args.note).toBe(unsentNote);
  expect(prepared.args).not.toHaveProperty('rounds');
  const restored = await page.evaluate(() => (window as any).liveHost.handoffs[0]);
  expect(restored.rounds[0].selected).toHaveLength(2);
  expect(restored.rounds.map(round => round.note)).toEqual([note, unsentNote]);
  await page.evaluate(() => (window as any).liveHost.releaseContext());
  await expect(frame.locator('.status-region')).toContainText('已交给 ChatGPT');
  await expect(frame.getByRole('button', { name: '已交给 ChatGPT' })).toBeDisabled();
  const relevant = (await messages(page)).filter(message => message.method === 'ui/update-model-context' || message.method === 'ui/message');
  expect(relevant.map(message => message.method)).toEqual(['ui/update-model-context', 'ui/message']);
  expect(JSON.stringify(relevant[0].params)).toContain(unsentNote);
  expect(relevant[1].params).toMatchObject({ role: 'user', content: [{ type: 'text' }] });
  expect(JSON.stringify(relevant[1].params)).toContain(goal);
});

test('cancel targets the original request; a late old response cannot replace a new goal', async ({ page }) => {
  await page.goto('/?' + new URLSearchParams({ goal: '为社区图书角组织一次旧书交换', holdFirst: '1' }));
  const frame = widget(page);
  await expect.poll(async () => (await generations(page)).length).toBe(1);
  await frame.getByRole('button', { name: '取消生成' }).click();
  await expect.poll(async () => (await calls(page)).filter(call => call.name === 'cancel_prethink').length).toBe(1);
  const original = (await generations(page))[0].args;
  const cancellation = (await calls(page)).find(call => call.name === 'cancel_prethink')!.args;
  expect(cancellation).toMatchObject({ clientId: original.clientId, requestId: original.requestId, version: original.version });
  await frame.getByRole('button', { name: '修改问题' }).click();
  const newGoal = '修好自行车后安排首次试骑';
  await frame.getByLabel('你的问题', { exact: true }).fill(newGoal);
  await frame.getByRole('button', { name: '生成联想线索' }).click();
  await expect(frame.getByTestId('cue-option').first()).toHaveAttribute('aria-label', '制动安全');
  expect((await generations(page))[1].args.parentRequestId).toBeNull();
  expect((await generations(page))[1].args.selected).toEqual([]);
  expect((await generations(page))[1].args.note).toBe('');
  await page.evaluate(() => (window as any).liveHost.releaseFirst());
  await expect(frame.locator('.journey-goal .value')).toHaveText(newGoal);
  await expect(frame.getByTestId('cue-option').first()).toHaveAttribute('aria-label', '制动安全');
  await expect(frame.getByRole('button', { name: '参与人群', exact: true })).toHaveCount(0);
});

test('375px retains two cue columns and long tokens wrap without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const goal = '策划亲子自然观察：' + 'unbroken_goal_token_'.repeat(15);
  await open(page, goal, { mobile: '1', long: '1' });
  const frame = widget(page);
  const childFrame = page.frames()[1];
  await childFrame.evaluate(() => { document.documentElement.style.fontFamily = 'monospace'; });
  await frame.getByLabel('当前补充').fill('unbroken_note_token_'.repeat(20));
  const sizes = await childFrame.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="cue-option"]')).map(card => card.getBoundingClientRect());
    return {
      actual: document.documentElement.scrollWidth, viewport: innerWidth,
      columns: getComputedStyle(document.querySelector('.cue-grid')!).gridTemplateColumns.split(' ').length,
      first: { x: cards[0].x, y: cards[0].y, width: cards[0].width },
      second: { x: cards[1].x, y: cards[1].y, width: cards[1].width },
    };
  });
  expect(sizes.actual).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.columns).toBe(2);
  expect(sizes.first.y).toBe(sizes.second.y);
  expect(sizes.second.x).toBeGreaterThan(sizes.first.x + sizes.first.width);
  await expect(frame.getByLabel('当前补充')).toBeVisible();
});

test('context rejection preserves current note and prevents any ui/message', async ({ page }) => {
  await open(page, '安排每周两次的力量训练', { contextFail: '1' });
  const frame = widget(page);
  await frame.getByLabel('当前补充').fill('本周右肩不适，先咨询专业人士');
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expect(frame.getByRole('alert')).toContainText('未接受这次请求');
  await expect(frame.locator('.status-region')).toContainText('尚未完成交接');
  expect((await messages(page)).filter(message => message.method === 'ui/message')).toHaveLength(0);
  await expect(frame.getByLabel('当前补充')).toHaveValue('本周右肩不适，先咨询专业人士');
});

test('message timeout keeps delivery uncertain and never offers blind resend', async ({ page }) => {
  await page.clock.install();
  await open(page, '安排一次朋友聚餐', { messageTimeout: '1' });
  const frame = widget(page);
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expect.poll(async () => (await messages(page)).filter(message => message.method === 'ui/message').length).toBe(1);
  await page.clock.fastForward(46000);
  await expect(frame.locator('.status-region')).toContainText('发送结果尚未确认');
  await expect(frame.getByRole('button', { name: '请先查看聊天正文' })).toBeDisabled();
  await expect(frame.getByRole('button', { name: '重新开始' })).toBeDisabled();
  expect((await messages(page)).filter(message => message.method === 'ui/message')).toHaveLength(1);
});

test('embedded bundle uses the parent tool bridge without direct HTTP or external requests', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', request => urls.push(request.url()));
  await open(page, '给第一次公开演讲准备一份练习计划');
  await widget(page).getByTestId('cue-option').first().click();
  await expect.poll(async () => (await generations(page)).length).toBe(2);
  expect(urls.every(url => new URL(url).origin === new URL(page.url()).origin)).toBeTruthy();
  expect(urls.some(url => /\/api\//.test(url))).toBeFalsy();
  expect(urls.filter(url => new URL(url).pathname !== '/' && new URL(url).pathname !== '/widget.html')).toEqual([]);
});

test('malformed child result never advances the displayed parent; retry resends its original delta', async ({ page }) => {
  await open(page, '为社区图书角组织一次旧书交换', { malformedChild: '1' });
  const frame = widget(page);
  const note = '雨天需要室内备用场地';
  await frame.getByLabel('当前补充').fill(note);
  await frame.getByRole('button', { name: '参与人群', exact: true }).click();
  await expect(frame.getByRole('alert')).toContainText('没有收到可显示的联想线索');
  await expect(frame.getByRole('button', { name: '参与人群', exact: true })).toBeEnabled();
  await expect(frame.getByLabel('当前补充')).toHaveValue(note);
  await frame.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(async () => (await generations(page)).length).toBe(3);
  await expect(frame.getByRole('button', { name: '雨天备选·第2轮', exact: true })).toBeEnabled();
  const generated = await generations(page);
  expect(generated[1].args.parentRequestId).toBe(generated[0].args.requestId);
  expect(generated[2].args.parentRequestId).toBe(generated[0].args.requestId);
  expect(generated[2].args.parentRequestId).not.toBe(generated[1].args.requestId);
  expect(generated[2].args.selected).toEqual(generated[1].args.selected);
  expect(generated[2].args.note).toBe(note);
  expect(generated[2].args).not.toHaveProperty('rounds');
  await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expect(frame.getByRole('button', { name: '已交给 ChatGPT' })).toBeDisabled();
  const prepared = (await calls(page)).find(call => call.name === 'prepare_prethink_handoff')!;
  expect(prepared.args.parentRequestId).toBe(generated[2].args.requestId);
  const restored = await page.evaluate(() => (window as any).liveHost.handoffs[0]);
  expect(restored.rounds).toHaveLength(1);
  expect(restored.rounds[0].note).toBe(note);
});

for (const failure of ['messageTeardown', 'messageMalformed']) {
  test(`${failure} after message dispatch keeps delivery uncertain and prevents resend`, async ({ page }) => {
    await open(page, '安排一次朋友聚餐', { [failure]: '1' });
    const frame = widget(page);
    await frame.getByLabel('当前补充').fill('有人不吃辣，保留这条当前补充');
    await frame.getByRole('button', { name: '交给 ChatGPT 回答' }).click();
    await expect(frame.locator('.status-region')).toContainText('发送结果尚未确认');
    await expect(frame.getByRole('button', { name: '请先查看聊天正文' })).toBeDisabled();
    await expect(frame.getByRole('button', { name: '重新开始' })).toBeDisabled();
    await expect(frame.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    await expect(frame.getByLabel('当前补充')).toHaveValue('有人不吃辣，保留这条当前补充');
    expect((await messages(page)).filter(message => message.method === 'ui/message')).toHaveLength(1);
  });
}
