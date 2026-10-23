# ChatGPT 预思考接入探针

固定的住宿示例，用于检验 MCP Apps 卡片是否能显示、点击更新，以及把选择和自由补充交回 ChatGPT。没有 DeepSeek 或 OpenAI API 调用，不读取原网页配置或密钥。它验证接入，不用于评价 AI 联想质量。

## 本地运行

在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run install:probe
npm run start:probe
```

默认仅监听 `http://127.0.0.1:5195`，MCP 地址为 `/mcp`。`GET /` 只提供健康信息，不是用户操作网页。卡片由 MCP 工具返回，在支持 MCP Apps 的宿主中显示。

探针与原网页服务、依赖、端口分开；不会改变原网页的 baseline/scoped 行为。

## 三个工具

- `start_prethink_probe({})`：打开固定示例，展示通勤、休息、日常安排和开销四个方向。
- `expand_prethink_probe({focus})`：返回该方向的固定下一层；点击只表示值得考虑。探针只演示一层延伸，完整项目的动态联想由后续模型接入提供。
- `prepare_probe_handoff({selected_ids, note})`：按已知选项 ID 整理方向与用户补充，不生成答案、不将方向变成已确认事实。

只有初始工具关联 UI 资源。卡片内通过 `tools/call` 更新当前视图；点击“交给 ChatGPT 回答”后，先请求交接摘要，再等待 `ui/update-model-context` 成功，最后发送 `ui/message`。消息发送结果不明确时，应回到聊天核对，避免重复发送。

## 测试与证据边界

```sh
npx playwright install chromium
npm run test:probe
```

协议检查使用真实 MCP 客户端。浏览器检查使用本地模拟宿主验证消息顺序、反馈传递、错误处理和手机宽度。模拟宿主仅供测试，不由探针生产服务提供。

这些检查不证明 ChatGPT 已安装插件、手机能打开卡片，或模型最终采纳了选择。实际验收需要在目标账户和手机上依次确认：

1. 找到插件并打开固定示例卡片。
2. 点击方向后卡片更新，界面与选择一致。
3. 补充测试情境，例如“每周三先送孩子”，再交给 ChatGPT。
4. 检查回答是否区分普通日和周三，并保留未查证事项。
5. 分开记录卡片首次显示、点击更新、最终回答的等待。固定数据时延不能代表 DeepSeek 接入后的完整速度。

## 准备 ChatGPT 测试连接

让 ChatGPT 能访问单独的 HTTPS `/mcp` 测试端点，或使用官方 Secure MCP Tunnel。不要暴露包含 API key 的原网页服务来代替此探针。服务器代码不持久保存补充内容，也不写请求正文日志；内容仍会经过所用传输服务和 ChatGPT，测试时请用示例信息。

在 ChatGPT Plugins 中添加自定义 MCP，或将验证后的端点填入插件包中的 `mcp.json`。仓库不附带私人主机名、临时运行地址或已连接的账户配置。源码与账户安装状态相互独立。

如果使用临时 Cloudflare Quick Tunnel，采用本探针的 JSON 响应模式；该隧道不支持 SSE，重启会更换地址，无在线时长保证。正式接入模型和持久用户数据前需要重新设计授权、会话隔离、调用预算与稳定托管。

官方来源：

- [MCP Apps quickstart](https://developers.openai.com/plugins/build/app-quickstart)
- [连接与测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [组件与模型上下文](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Quick Tunnel 限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
