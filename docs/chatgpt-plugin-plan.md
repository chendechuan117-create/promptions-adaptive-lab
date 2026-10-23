# ChatGPT 插件接入设计提案

状态：**完整 DeepSeek 插件仍为设计提案。固定数据 MCP 接入探针已提供源码，见 [probe/README.md](../probe/README.md)。探针不证明具体账户或手机接入成功。**

官方资料核对日期：2026-10-23。本文区分文档支持的能力与建议实现方式，不代表任何账户或手机已完成接入验收。

## 体验目标

用户选择插件后进入预思考流程：先看到与问题有关、彼此容易辨认的联想方向；点击某个方向后立即继续延伸，也可以自由补充；确认准备好后，再把选择交给 ChatGPT 生成正式答案。这不是正式答案后的推荐，也不是要求用户填完固定问卷。

进入流程时应明确提示：**本次问题、选中的方向及自由补充将发送至 DeepSeek，用于生成预思考方向。** 仅发送完成当前任务必要的信息，不主动收集完整聊天记录。

## 最小架构建议

复用现有 React 卡片交互和 Node 后端能力，增加 MCP 服务及 MCP Apps UI 资源。当前独立网页的普通 fetch 接口和 iframe 安全策略不能直接充当插件；需要把组件中的后端交互适配成宿主桥调用，并单独注册 UI 资源。以下工具名称和参数只是建议，尚未实现：

- `start_prethink(intent)`：接收本次任务的简短意图，生成初始方向并返回卡片和不透明的 `session_id`。
- `expand_prethink(session_id, selected_option_ids, note)`：校验当前会话中的选项，结合用户补充生成下一组方向，并返回当前任务的更新状态。
- `prepare_handoff(session_id)`：整理本次任务的原始意图、用户明确选择和补充，返回交接摘要；不生成正式答案。

服务端仅保留当前任务所需的选择、补充及生成状态，不把独立网页原型的 `rounds` 数组原样变成 MCP 输入，不要求调用方传入历史聊天或前轮消息数组。`session_id` 不是授权凭据；未来实施时仍需检查请求者身份和会话归属。

建议交互顺序：

1. 用户选择插件并提出本次问题，调用 `start_prethink`，展示内联卡片。
2. 用户点击方向或提交补充时，卡片通过 MCP Apps 的 `tools/call` 调用 `expand_prethink`，直接用返回结果更新卡片。
3. 用户点击“现在回答”时，调用 `prepare_handoff`；卡片先通过 `ui/update-model-context` 提交交接摘要，再通过 `ui/message` 请求 ChatGPT 根据这些选择回答原问题。
4. ChatGPT 生成正式正文。DeepSeek 仍由独立后端调用，承担预思考方向生成。

官方文档支持卡片内直接调用数据工具并更新现有组件，也区分了模型上下文更新与后续消息发送。上述组合是本项目的设计建议；“每次卡片点击均不额外出现 ChatGPT 正文”和“最终交接完整影响正文”仍需接入后的实际验收，不能只凭 API 名称保证。

## 能力与边界

- **卡片 UI 与直接工具交互有文档依据。** ChatGPT 可以在 iframe 中展示 MCP Apps UI；新实现优先使用 `_meta.ui.resourceUri` 和标准 `ui/*` 桥，点击操作使用 `tools/call`。`window.openai` 是可选的兼容或扩展能力。[官方 UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui)
- **选择可以成为模型可见上下文。** `ui/update-model-context` 用于传递选择或暂存编辑，`ui/message` 用于发送后续消息；二者不能混同为“更新界面即已要求模型回答”。[官方 UI 状态说明](https://developers.openai.com/plugins/build/chatgpt-ui#keep-temporary-ui-state-in-the-ui)、[组件桥参考](https://developers.openai.com/plugins/reference#windowopenai-component-bridge)
- **未找到全局原生回答前置拦截能力的官方证据。** 当前提案依赖用户主动进入插件流程，不承诺安装后自动拦截所有 ChatGPT 原生回答，也不承诺读取全部聊天。官方规范明确要求最小化任务输入，不得索要完整聊天历史、原始聊天记录或累计前轮数组。[官方输入规范](https://developers.openai.com/plugins/plugin-guidelines#minimal-and-purpose-driven-inputs)
- **手机支持不等于当前流程已验收。** 官方说明插件支持 ChatGPT 的网页、桌面和移动端；本项目仍需验证具体账户与手机上的卡片加载、选择、补充、继续和最终交接。本文只使用“选择插件后进入流程”，不承诺手机支持通过输入框 `@mention` 启动。[官方支持平台说明](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)

## 未来实施与验收点

- 提供 ChatGPT 能访问的公网 HTTPS MCP 端点；生产服务使用稳定 HTTPS 与 Streamable HTTP。公网发布不意味着允许匿名使用由维护者付费的模型后端。[官方接入 quickstart](https://developers.openai.com/plugins/build/app-quickstart#expose-your-server-to-the-public-internet)
- 实现适当认证、服务端授权和用户间会话隔离；涉及私有数据或用户操作时，遵循 MCP 授权要求，官方认证指南使用 OAuth 2.1。[官方认证指南](https://developers.openai.com/plugins/build/auth)
- DeepSeek 密钥留在服务端；设置输入长度、调用次数、速率、超时与成本预算，处理重复点击及并发请求。ChatGPT 使用权益与外部 DeepSeek 调用分别核算；不宣称 ChatGPT 订阅覆盖 DeepSeek 费用，也不凭文档推定卡片点击的 ChatGPT 配额规则。
- 在手机上测量首次方向展示和点击延伸的实际延迟，并检查卡片是否保持、自由补充是否影响延伸，以及最终正文是否反映用户选择。避免把“接口返回成功”当作体验验收完成。
- 开源代码发布、MCP 服务部署、插件注册及公开分发是不同交付步骤；本文仅记录设计，不证明其中任何接入步骤已经完成。
