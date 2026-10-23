# 动态预思考卡片

这个入口复用原网页的 `App`、样式和 `baseline` 提示词；固定住宿示例不是它的数据源。`scoped` 仍是独立实验，未替换默认版本。

用户在 ChatGPT 中开启预思考，可以传入本次问题，也可在卡片填写。点击方向会立即生成下一轮；多选和自由补充可一起继续。最后点“交给 ChatGPT 回答”，依次整理当前任务、更新模型上下文、发送交接消息。DeepSeek 不为此入口生成最终答案。

## 构建和检查

```sh
npm ci --ignore-scripts
npm run install:probe
npm run build:widget
npm run test:chatgpt
```

构建产物是自包含的 `dist-prethink-widget/widget.html`，不从 CDN 加载脚本，不在组件内保存 API key。`test:chatgpt` 使用注入生成器及模拟宿主，无真实模型费用。原网页用 `npm run check`，旧固定探针用 `npm run test:probe`。

## 运行边界

在服务端配置 `DEEPSEEK_API_KEY`，设置以下参数后运行 `npm run start:chatgpt`：

- `PORT`：默认 `5195`，仅监听 `127.0.0.1`。
- `THOUGHTSCOUT_PUBLIC_HOST`：自己的 HTTPS 代理主机名，不含协议或路径。
- `THOUGHTSCOUT_LIVE_MAX_CALLS`：显式的总尝试次数，1–100；未配置时为零。
- `THOUGHTSCOUT_LIVE_BUDGET_LEDGER`：服务端私有账本绝对路径，仅存数字计数，单进程写入。启用试运行时应配置，不能用重启重置预算。

每次生成前扣预算，失败和取消不返还；最多两次并发、30 秒生成期限。没有自动付费重试。该入口没有账户认证，只用于有限预算的受信任试运行；随机客户端标识不是用户身份凭据。公开生产部署需另行添加认证和授权，参见 [部署边界](../SECURITY.md)。

## 连接 ChatGPT

通过 ChatGPT 插件页的 **添加自定义 MCP 服务器** 注册自己的 HTTPS `/mcp` 端点。不要把带 `mcp.json` 的导入包当作手机支持保证：官方对工作区导入明确有“仅桌面”限制，即使配置远程 HTTPS 也适用。[连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt#add-the-mcp-server)、[导入限制](https://learn.chatgpt.com/docs/enterprise/plugin-management#desktop-only-plugins)

更新旧固定探针连接后，在连接详情点击 **Refresh**，确认工具列表包含 `start_prethinking`，然后新开对话；浏览器刷新页面和卡片内“重试”不能代替这一步。[官方元数据刷新步骤](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)

新的模型可见入口是 `start_prethinking`；`start_prethink_probe` 保留名称作为打开入口，现在也展示动态卡片，但其返回结构已由固定探针结构改为动态启动结构，因此不保证未刷新旧工具 schema 的宿主可直接使用。其余数据工具仅供卡片调用，避免每次点击重建一个新 iframe。保留原连接即可，无需重复创建另一个插件。

服务同时注册 `ui://thoughtscout/prethinking-v1.html` 和旧地址 `ui://thoughtscout/probe.html`，两者返回同一动态卡片，避免旧资源引用直接出现 `Resource not found`。这个别名只修复资源寻址，不会刷新 ChatGPT 缓存的工具说明、schema 或旧 iframe。手机实际加载和最终交接仍需在刷新后的新对话验收。

## 当前任务的数据流

- `start_prethinking({goal})`：免费打开卡片。goal 可为空，不请求完整聊天。
- `generate_prethink_cues(...)`：提交本次选项、备注及本任务父请求标识，不接收累计轮次数组。服务端检查父记录归属和选项来源，再用原生成器继续。
- `cancel_prethink(...)`：取消匹配客户端、请求及版本的操作。
- `prepare_prethink_handoff(...)`：从当前任务快照与尚未提交的选择/备注整理有序交接内容，不调用模型。

服务端保存当前任务的有限内存快照，两小时过期并每30秒清理、总计最多100个、单客户端最多32个；不持久化问题和备注，不记录请求正文。UI 只有在完整验证并实际接受结果后才推进父请求标识。取消、失败或格式错误不会丢掉已确认的分支。

交接等待 `ui/update-model-context` 成功后才调用 `ui/message`。明确拒绝允许用户重试；发送后的超时、视图关闭或无法识别的确认都标为结果未知，避免重复发送。[MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui)、[最小输入要求](https://developers.openai.com/plugins/plugin-guidelines#minimal-and-purpose-driven-inputs)

## 验收范围

自动检查覆盖两类非住宿目标连续三轮、自由补充和多选、375px双列、取消与迟到响应、父请求确认、费用边界、交接顺序和未知发送保护。模拟宿主通过不证明 ChatGPT 原生手机行为；真实 DeepSeek 返回也不证明真人联想或效率收益。手机验收还应检查实际点击等待、卡片是否保持，以及最后正文是否使用了补充。
