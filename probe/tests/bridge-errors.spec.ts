import { test, expect, type Page } from '@playwright/test';

// Browser-only parent simulation. No production MCP endpoint or model is called.
const sensitive = 'https://private.invalid/path?token=SECRET_TOKEN PRIVATE_GOAL raw upstream failure';
const frame = (page: Page) => page.frameLocator('iframe');

async function rejectRpc(page: Page, target: 'generate' | 'message', code: number, toolError = false, businessCode?: string, hostMessage?: string) {
  await page.addInitScript(({ target, code, sensitive, toolError, businessCode, hostMessage }) => {
    if (window.parent !== window) return;
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, listener: any, options: any) => {
      if (type !== 'message' || typeof listener !== 'function') return add(type as any, listener, options);
      add('message', (event: MessageEvent) => {
        const iframe = document.querySelector('iframe');
        const message = event.data;
        const matches = target === 'generate'
          ? message?.method === 'tools/call' && message.params?.name === 'generate_prethink_cues'
          : message?.method === 'ui/message';
        if (event.source !== iframe?.contentWindow || !matches) return listener(event);
        const host = (window as any).liveHost;
        host.messages.push(message);
        if (target === 'generate') host.toolCalls.push({ name: message.params.name, args: message.params.arguments });
        iframe.contentWindow!.postMessage({
          jsonrpc: '2.0', id: message.id,
          ...(toolError
            ? { result: { isError: true, content: [{ type: 'text', text: businessCode ? JSON.stringify({ code: businessCode, error: sensitive }) : sensitive }] } }
            : { error: { code, message: hostMessage ?? sensitive, data: { url: sensitive, token: 'SECRET_DATA', goal: 'PRIVATE_GOAL' } } }),
        }, location.origin);
      }, options);
    }) as typeof window.addEventListener;
  }, { target, code, sensitive, toolError, businessCode, hostMessage });
}

for (const hostMessage of ['Tool private_legacy_tool not found', 'Unknown tool: private_legacy_tool']) {
  test(`-32602 exact missing-tool diagnostic gives a fixed refresh hint: ${hostMessage.split(' ')[0]}`, async ({ page }) => {
    await rejectRpc(page, 'generate', -32602, false, undefined, hostMessage);
    await page.goto('/?goal=' + encodeURIComponent('安排一次社区读书会'));
    await expectSafeAlert(page, '生成联想', -32602);
    await expect(frame(page).getByRole('alert')).toContainText('连接工具目录中找不到此工具，请刷新连接');
    await expect(frame(page).getByRole('alert')).not.toContainText('参数被拒绝');
    await expect(frame(page).getByRole('alert')).not.toContainText('private_legacy_tool');
  });
}

test('-32602 diagnostic with appended sensitive data is not treated as a missing-tool match', async ({ page }) => {
  await rejectRpc(page, 'generate', -32602, false, undefined, 'Tool private_legacy_tool not found token=SECRET_TOKEN');
  await page.goto('/?goal=' + encodeURIComponent('安排一次社区读书会'));
  await expectSafeAlert(page, '生成联想', -32602);
  await expect(frame(page).getByRole('alert')).toContainText('参数被拒绝');
  await expect(frame(page).getByRole('alert')).not.toContainText('连接工具目录中找不到此工具');
  await expect(frame(page).getByRole('alert')).not.toContainText('private_legacy_tool');
});

async function expectSafeAlert(page: Page, stage: string, code?: number, role: 'alert' | 'status' = 'alert') {
  const alert = role === 'status' ? frame(page).locator('.status-region') : frame(page).getByRole('alert');
  await expect(alert).toContainText(stage);
  if (code !== undefined) await expect(alert).toContainText(`错误码 ${code}`);
  const text = await alert.innerText();
  for (const secret of ['private.invalid', 'SECRET_TOKEN', 'SECRET_DATA', 'PRIVATE_GOAL', 'raw upstream failure', 'https://']) {
    expect(text).not.toContain(secret);
  }
}

for (const [code, classification] of [[-32601, '方法不支持'], [-32602, '参数被拒绝']] as const) {
  test(`generation RPC ${code} retains stage and safe code without host error details`, async ({ page }) => {
    await rejectRpc(page, 'generate', code);
    await page.goto('/?goal=' + encodeURIComponent('安排一次社区读书会'));
    await expectSafeAlert(page, '生成联想', code);
    await expect(frame(page).getByRole('alert')).toContainText(classification);
    await expect(frame(page).getByRole('alert')).toContainText('未接受这次请求');
    if (code === -32601) await expect(frame(page).getByRole('alert')).toContainText('刷新插件连接的工具目录');
    await expect(frame(page).getByTestId('cue-option')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).liveHost.toolCalls.length)).toBe(1);
  });
}

test('unknown message RPC -32603 preserves delivery uncertainty without blind resend or sensitive host details', async ({ page }) => {
  await rejectRpc(page, 'message', -32603);
  await page.goto('/?goal=' + encodeURIComponent('安排一次社区读书会'));
  await expect(frame(page).getByTestId('cue-option')).toHaveCount(4);
  await frame(page).getByLabel('当前补充').fill('请保留当前补充');
  await frame(page).getByRole('button', { name: '交给 ChatGPT 回答' }).click();
  await expectSafeAlert(page, '发送交接消息', -32603, 'status');
  await expect(frame(page).locator('.status-region')).toContainText('发送结果尚未确认');
  await expect(frame(page).locator('.status-region')).not.toContainText('未接受这次请求');
  await expect(frame(page).getByRole('button', { name: '请先查看聊天正文' })).toBeDisabled();
  await expect(frame(page).getByRole('button', { name: '重新开始' })).toBeDisabled();
  await expect(frame(page).getByLabel('当前补充')).toHaveValue('请保留当前补充');
  await expect(frame(page).getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).liveHost.messages.filter((item: any) => item.method === 'ui/message').length)).toBe(1);
});

test('tool execution error content is not copied into the visible generation error', async ({ page }) => {
  await rejectRpc(page, 'generate', -32603, true);
  await page.goto('/?goal=' + encodeURIComponent('安排一次社区读书会'));
  await expectSafeAlert(page, '生成联想');
  await expect(frame(page).getByRole('alert')).toContainText('工具执行失败');
  await expect(frame(page).getByRole('alert')).not.toContainText('未接受这次请求');
});

for (const [code, explanation] of [
  ['BUDGET_EXHAUSTED', '预算已用尽或未启用'],
  ['INVALID_INPUT', '参数格式不正确'],
  ['PARENT_UNAVAILABLE', '上轮任务记录不存在'],
  ['CANCELLED', '请求已取消或替换'],
  ['TIMEOUT', '生成超时'],
] as const) {
  test(`known business error ${code} uses a fixed explanation rather than upstream text`, async ({ page }) => {
    await rejectRpc(page, 'generate', -32603, true, code);
    await page.goto('/?goal=' + encodeURIComponent('安排一次社区读书会'));
    await expectSafeAlert(page, '生成联想');
    await expect(frame(page).getByRole('alert')).toContainText(explanation);
    await expect(frame(page).getByRole('alert')).toContainText(code);
    await expect(frame(page).getByRole('alert')).not.toContainText('未接受这次请求');
  });
}

test('unknown business code remains generic without reflecting its code or raw text', async ({ page }) => {
  await rejectRpc(page, 'generate', -32603, true, 'SECRET_DATA');
  await page.goto('/?goal=' + encodeURIComponent('安排一次社区读书会'));
  await expectSafeAlert(page, '生成联想');
  await expect(frame(page).getByRole('alert')).toContainText('工具执行失败');
});
