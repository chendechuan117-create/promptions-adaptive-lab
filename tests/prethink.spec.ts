import { readFile } from 'node:fs/promises';
import { test, expect, Page } from '@playwright/test';

const base = `http://127.0.0.1:${process.env.PRETHINK_TEST_PORT || '5194'}`;
const options = (round: number) => round === 0
  ? [{ label: '时间安排', hint: '出发和用餐时段如何衔接' }, { label: '同行情况', hint: '谁会一起行动及其需要' }]
  : [{ label: '交通变化', hint: '延误或改道时的选择' }, { label: '体力负担', hint: '步行距离和休息安排' }];

async function mockPrethink(page: Page, handler?: (body: any, index: number) => Promise<void> | void) {
  const calls: any[] = [];
  await page.route('**/api/health', route => route.fulfill({ json: { provider: 'DeepSeek', model: 'deepseek-flash', dataMode: 'no_live_sources' } }));
  await page.route('**/api/prethink', async route => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (handler) return handler(body, calls.length - 1) as Promise<void>;
    const result = body.mode === 'cues'
      ? { requestId: body.requestId, version: body.version, mode: 'cues', scope: '先看看这次出行涉及的安排。', options: options(body.rounds.length), metrics: { elapsedMs: 5 } }
      : { requestId: body.requestId, version: body.version, mode: 'answer', answer: '综合考虑后的答案', usedAssociations: [], metrics: { elapsedMs: 8 } };
    await route.fulfill({ json: result });
  });
  await page.route('**/api/cancel', route => route.fulfill({ json: { ok: true } }));
  return calls;
}

async function open(page: Page, goal = '为周末安排一次轻松的出行', query = '?variant=scoped') {
  await page.goto(`${base}/prethink.html${query}`);
  await page.getByLabel('你的问题').fill(goal);
  await page.getByRole('button', { name: '生成联想线索' }).click();
}

test('先显示联想线索而不显示答案；点击单项自动展开并带上原问题和所选线索', async ({ page }) => {
  const calls = await mockPrethink(page);
  await open(page);
  await expect(page.getByTestId('cue-option')).toHaveCount(2);
  await expect(page.getByText('综合考虑后的答案')).toHaveCount(0);
  await page.getByRole('button', { name: '时间安排' }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].goal).toBe('为周末安排一次轻松的出行');
  expect(calls[1].mode).toBe('cues');
  expect(calls[1].rounds.at(-1).selected).toEqual([{ label: '时间安排', hint: '出发和用餐时段如何衔接' }]);
  await expect(page.getByTestId('cue-option').filter({ hasText: '交通变化' })).toBeVisible();
  await expect(page.getByText('综合考虑后的答案')).toHaveCount(0);
});

test('支持多选和补充，并把反馈放进最终 answer 请求', async ({ page }) => {
  const calls = await mockPrethink(page);
  await open(page);
  await page.getByRole('button', { name: '开启多选' }).click();
  await page.getByRole('button', { name: '时间安排' }).click();
  await page.getByRole('button', { name: '同行情况' }).click();
  await page.getByLabel('当前补充').fill('同行者需要少走路，中途可以休息');
  await page.getByRole('button', { name: '沿所选方向继续' }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].mode).toBe('cues');
  expect(calls[1].rounds[0].selected).toEqual([
    { label: '时间安排', hint: '出发和用餐时段如何衔接' },
    { label: '同行情况', hint: '谁会一起行动及其需要' },
  ]);
  expect(calls[1].rounds[0].note).toContain('同行者需要少走路');
  await page.getByLabel('当前补充').fill('安排低步行量的路线和休息点');
  await page.getByRole('button', { name: '整理成答案' }).click();
  await expect(page.getByText('综合考虑后的答案')).toBeVisible();
  const answerCall = calls.find(x => x.mode === 'answer');
  expect(answerCall.goal).toBe('为周末安排一次轻松的出行');
  expect(answerCall.rounds[0].selected).toHaveLength(2);
  expect(JSON.stringify(answerCall.rounds)).toContain('安排低步行量的路线和休息点');
});

test('无需穷尽选项即可直接生成答案', async ({ page }) => {
  const calls = await mockPrethink(page);
  await open(page);
  await page.getByRole('button', { name: '整理成答案' }).click();
  await expect(page.getByText('综合考虑后的答案')).toBeVisible();
  expect(calls.filter(x => x.mode === 'answer')).toHaveLength(1);
  expect(calls.at(-1).rounds).toEqual([]);
});

test('取消并换题后，迟到的旧响应不会覆盖新线索', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: any[] = [];
  await page.route('**/api/health', route => route.fulfill({ json: { provider: 'DeepSeek', model: 'deepseek-flash', dataMode: 'no_live_sources' } }));
  await page.route('**/api/cancel', route => route.fulfill({ json: { ok: true } }));
  let first = true;
  await page.route('**/api/prethink', async route => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (first) { first = false; await gate; try { await route.fulfill({ json: { requestId: body.requestId, version: body.version, mode: 'cues', scope: '先看看这次出行涉及的安排。', options: [{ label: '旧线索', hint: '旧' }], metrics: { elapsedMs: 1 } } }); } catch {} }
    else await route.fulfill({ json: { requestId: body.requestId, version: body.version, mode: 'cues', scope: '先看看这次出行涉及的安排。', options: [{ label: '新线索', hint: '新' }], metrics: { elapsedMs: 1 } } });
  });
  await page.goto(`${base}/prethink.html`);
  await page.getByLabel('你的问题').fill('旧问题');
  await page.getByRole('button', { name: '生成联想线索' }).click();
  await expect.poll(() => calls.length).toBe(1);
  await page.getByRole('button', { name: '取消生成' }).click();
  await page.getByRole('button', { name: '修改问题' }).click();
  await page.getByLabel('你的问题').fill('新问题');
  await page.getByRole('button', { name: '生成联想线索' }).click();
  await expect(page.getByRole('button', { name: '新线索' })).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: '新线索' })).toBeVisible();
  await expect(page.getByRole('button', { name: '旧线索' })).toHaveCount(0);
});

test('失败后保留原问题和补充，可重试恢复', async ({ page }) => {
  const calls: any[] = [];
  await page.route('**/api/health', route => route.fulfill({ json: { provider: 'DeepSeek', model: 'deepseek-flash', dataMode: 'no_live_sources' } }));
  await page.route('**/api/prethink', async route => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (calls.length === 1) await route.fulfill({ json: { requestId: body.requestId, version: body.version, mode: 'cues', scope: '先看看这次出行涉及的安排。', options: options(0), metrics: { elapsedMs: 4 } } });
    else if (calls.length === 2) await route.fulfill({ status: 503, json: { error: 'temporary' } });
    else await route.fulfill({ json: { requestId: body.requestId, version: body.version, mode: 'answer', answer: '恢复后的答案', usedAssociations: [], metrics: { elapsedMs: 4 } } });
  });
  await open(page, '安排一顿简单的晚餐');
  await page.getByLabel('当前补充').fill('不要太辣');
  await page.getByRole('button', { name: '整理成答案' }).click();
  await expect(page.getByRole('alert')).toContainText('刚才没接上，内容还在。');
  await expect(page.locator('.journey-goal .value')).toHaveText('安排一顿简单的晚餐');
  await expect(page.getByLabel('当前补充')).toHaveValue('不要太辣');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('恢复后的答案')).toBeVisible();
  expect(calls).toHaveLength(3);
  expect(calls[2].goal).toBe('安排一顿简单的晚餐');
  expect(JSON.stringify(calls[2].rounds)).toContain('不要太辣');
});

test('375px 宽度没有横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockPrethink(page);
  await open(page);
  await expect(page.getByTestId('cue-option')).toHaveCount(2);
  const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});


test('scoped 说明随下一层选项一起更新，失败、取消及重试保留一致的内容', async ({ page }) => {
  const calls: any[] = [];
  const pending: any[] = [];
  const cancellations: any[] = [];
  await page.route('**/api/health', route => route.fulfill({ json: { provider: 'DeepSeek', model: 'mock', dataMode: 'no_live_sources' } }));
  await page.route('**/api/cancel', route => {
    cancellations.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/prethink', async route => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (calls.length === 1) await route.fulfill({ json: { ...body, scope: '先想想谁会参与。', options: options(0) } });
    else pending.push({ route, body });
  });
  await open(page);
  await expect(page.getByTestId('cue-scope')).toHaveText('先想想谁会参与。');
  await page.getByLabel('当前补充').fill('也可能留在家里');
  await page.getByRole('button', { name: '沿所选方向继续' }).click();
  await expect.poll(() => pending.length).toBe(1);
  expect(calls[1].rounds).toEqual([{ selected: [], note: '也可能留在家里' }]);
  expect(calls[1].variant).toBe('scoped');
  expect(calls[1]).not.toHaveProperty('scope');
  await expect(page.getByTestId('cue-scope')).toHaveText('先想想谁会参与。');
  await expect(page.getByRole('button', { name: '时间安排' })).toBeVisible();
  await pending[0].route.fulfill({ status: 503, json: { error: 'temporary' } });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('cue-scope')).toHaveText('先想想谁会参与。');
  await page.getByRole('button', { name: '重试' }).click();
  await expect.poll(() => pending.length).toBe(2);
  expect(calls[2].variant).toBe('scoped');
  await pending[1].route.fulfill({ json: { ...pending[1].body, scope: '再想想临时变化。', options: options(1) } });
  await expect(page.getByTestId('cue-scope')).toHaveText('再想想临时变化。');
  await expect(page.getByRole('button', { name: '交通变化' })).toBeVisible();
  await expect(page.getByRole('button', { name: '时间安排' })).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前试用 JSON' }).click();
  const download = await downloadPromise;
  const trial = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(trial.variant).toBe('scoped');
  expect(trial.results.at(-1).scope).toBe('再想想临时变化。');
  expect(trial.rounds).toEqual([{ selected: [], note: '也可能留在家里' }]);
  await page.getByLabel('当前补充').fill('不确定是否下雨');
  await page.getByRole('button', { name: '沿所选方向继续' }).click();
  await expect.poll(() => pending.length).toBe(3);
  await page.getByRole('button', { name: '取消生成' }).click();
  await expect(page.getByTestId('cue-scope')).toHaveText('再想想临时变化。');
  await expect(page.getByLabel('当前补充')).toHaveValue('不确定是否下雨');
  await expect.poll(() => cancellations.length).toBe(1);
  expect(cancellations[0].variant).toBe('scoped');
  await pending[2].route.fulfill({ json: { ...pending[2].body, scope: '迟到的说明', options: options(0) } }).catch(() => {});
  await expect(page.getByTestId('cue-scope')).toHaveText('再想想临时变化。');
  await expect(page.getByRole('button', { name: '交通变化' })).toBeVisible();
  await page.getByRole('button', { name: '修改问题' }).click();
  await page.getByLabel('你的问题').fill('另一个问题');
  await page.getByRole('button', { name: '生成联想线索' }).click();
  await expect.poll(() => pending.length).toBe(4);
  await expect(page.getByTestId('cue-scope')).toHaveCount(0);
  await expect(page.getByTestId('cue-option')).toHaveCount(0);
  await page.getByRole('button', { name: '取消生成' }).click();
  await pending[3].route.abort().catch(() => {});
});

test('baseline 不展示 scope，URL 改动不切换本次试用，所有请求和导出保留 variant', async ({ page }) => {
  const calls = await mockPrethink(page);
  await open(page, '试用原版', '?variant=baseline');
  await expect(page.getByTestId('cue-scope')).toHaveCount(0);
  await expect(page.locator('.section-copy')).toHaveText('点一个方向继续，也可多选或直接生成答案。');
  await page.evaluate(() => history.replaceState(null, '', '?variant=scoped'));
  await page.getByRole('button', { name: '时间安排' }).click();
  await expect(page.getByRole('button', { name: '交通变化' })).toBeVisible();
  await page.getByRole('button', { name: '整理成答案' }).click();
  await expect(page.getByText('综合考虑后的答案')).toBeVisible();
  expect(calls.map(call => call.variant)).toEqual(['baseline', 'baseline', 'baseline']);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前试用 JSON' }).click();
  const download = await downloadPromise;
  const trial = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(trial.variant).toBe('baseline');
  expect(trial.results.every((result: any) => result.variant === 'baseline' && !('scope' in result))).toBe(true);
  expect(trial.rounds[0]).toEqual({ selected: [options(0)[0]], note: '' });
});


test('普通 URL 默认使用 baseline，显式 scoped 才启用实验说明', async ({ page }) => {
  const calls = await mockPrethink(page);
  await open(page, '默认原版', '');
  await expect(page.getByTestId('cue-option')).toHaveCount(2);
  await expect(page.getByTestId('cue-scope')).toHaveCount(0);
  expect(calls[0].variant).toBe('baseline');
});
