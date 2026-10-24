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

### 独立 Inspector 发布检查

固定使用官方 `@modelcontextprotocol/inspector@2.12.0`，开发依赖单独放在 `tools/inspector`，不进入产品卡片。安装原项目与 probe 依赖、构建卡片并安装 Playwright Chromium 后运行：

```sh
npm run install:inspector
npm run build:widget
npm run test:inspector
```

第一项检查用官方 CLI 连接临时的真实 MCP 服务：核对五个工具的 schema、元数据及两个卡片地址，读取资源并检查 MIME/CSP，执行两个空目标的免费入口。检查既看进程结果，也拒绝 `resourceError`，不会因为 HTTP 200 或 CLI 正常退出就接受缺失资源。`probe/contracts/live-v1.json` 是当前接口的审阅基线；变化需要人工核对升级影响后显式修改，脚本不会自动覆盖。它记录的是动态版当前契约，不表示旧固定探针的返回 schema 仍然兼容。

第二项检查启动官方 Web Inspector 和独立沙箱，等待初始化后再检查 iframe 内的真实问题输入框及禁用的生成按钮，捕获脚本/CSP 错误。随后从实际 iframe 经宿主调用一次 app-only 免费交接整理工具，核对返回目标与补充，不发送聊天消息。服务预算为零，界面初始目标为空，检查期间不允许任何生成尝试。Inspector 的配置和认证状态使用临时目录，不使用个人默认配置。两项检查均不调用付费模型，已加入 CI。

已部署端点可以只跑免费协议检查：

```sh
node probe/inspect-contract.mjs --url https://your-host.example/mcp
```

不要在有其他用户生成时把预算变化直接归因于检查脚本；门禁会停止并要求核对。可用 `node probe/inspect-widget.mjs --artifacts /your/private/output` 保存官方宿主的报告与截图，工件应放在公开仓库外。

这层检查证明独立官方客户端能发现资源并初始化实际界面，不覆盖真实 ChatGPT 的账号权限、缓存刷新、网络验证、手机显示或最终回答采纳。发布后仍需在实际宿主验收；暂无必要增加另一个生产网关。


### 生成失败与宿主诊断

首轮生成尚未成功时，卡片应明确显示加载、失败或取消，不能把空数组解释为“没有新的方向”。只有成功返回的空结果才显示该提示；下一轮失败保留已有方向和补充。失败后修改草稿再重试时，按钮提示“带着修改重试”，实际请求应包含这次修改。

桥接错误按生成、整理交接、更新上下文、发送消息分别标注；仅展示固定分类、已知方法/工具名和整数 RPC 错误码，不回显宿主原始错误正文或 data。未获得发送确认时保留未知状态，不自动重复发送。官方 Inspector 的 app-only 调用成功不代表 ChatGPT 当前账户、客户端或连接缓存也接受调用。


若旧入口还能打开新界面，但新操作报“工具不存在”，核对连接目录是否仍保留旧固定探针的 `expand_prethink_probe` / `prepare_probe_handoff`。当前服务使用 `start_prethinking`、`start_prethink_probe` 两个入口与三个 app-only 工具。按[官方刷新步骤](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)在既有连接中执行 **Refresh**，确认目录更新，再开启新对话；普通网页重新加载不会刷新工具目录。错误码 `-32602` 也可能携带工具不存在信息，不能只按错误码认定参数不正确。
