# Promptions Adaptive Lab · 预思考联想

**先展开相关方向，让人补入联想，再形成答案。**

一个可在手机浏览器使用的实验原型：DeepSeek 提供容易辨认的联想方向，用户点击后自动展开下一层，也可以多选、自由补充或直接生成答案。原问题与用户提出的关联会进入后续生成。

例如，选住处时关注“通勤”，可能让人想起途中接送、夜间返程或休息问题。点击表示“值得考虑”，不等于确认事实或承诺最终方案。方向可以较多，但应避免近义重复、混合层级或过早让人比较相似具体方案。

## 运行

需要 **Node.js 24.5 或更高版本**、npm，以及你自己的 DeepSeek API key。API key 只放服务端；在 `.env` 文件中填写，不要提交到仓库。

```sh
npm ci --ignore-scripts
npm run build
```

复制 `.env.example` 为 `.env`，在编辑器内填写 `DEEPSEEK_API_KEY`，然后：

```sh
npm start
```

打开 <http://127.0.0.1:5193/>。默认使用 DeepSeek Flash：线索阶段 `reasoning=none`，答案阶段 `reasoning=low`。每步一次请求，没有自动重试或实时搜索。

原型只监听本机地址。手机访问需要你自行配置受保护的 HTTPS 反向代理，并通过 `PROMPTIONS_PUBLIC_HOST` 指定自己的主机名。仓库没有附带任何已部署的公共服务或访问凭据。

## 两种线索版本

- 默认 `baseline`：保留原有提示词与交互。
- `/?variant=scoped`：实验性地区分本轮关注与较早背景，在卡片上方增加一句本轮探索说明。

`scoped` 尚未证明稳定优于默认版。小规模开发测试同时出现了更贴合关注点与过早集中于某一种情境的结果，所以没有替换默认版本。结构合规、选项更少或生成更快，都不能单独证明联想或决策质量提高。

## 数据与边界

问题、选择和补充会发往你运行的 Node 服务，再由服务端调用 DeepSeek。浏览器在内存中保存当前状态；刷新会丢失，只有主动导出才生成本地 JSON 文件。应用本身不写入聊天数据库或分析日志；模型服务商的数据处理另受其条款约束。

这里没有房源、地图、天气、库存等实时数据源，没有自动预订，也没有事实正确性保证。生成的关联可能不适用，选项也可能遗漏重要方面。推理文本不作为应用结果展示或持久化。候选仍等整组完成并验证后才显示；首个文本片段的到达时间不等于可点击时间。

这是单人/受信任访问的原型。Host 和同源检查不是身份认证。若部署到互联网，应先增加认证、用户会话隔离、调用配额和成本限制，避免他人使用你的模型额度。参见 [SECURITY.md](SECURITY.md)。

## 检查

```sh
npm test
npm run build
npx playwright install chromium
npm run test:ui
```

浏览器检查会自动启动独立的本机测试服务，默认端口 `5194`。所有生成接口均由测试拦截，不需要 API key，不产生真实模型费用。后端检查使用本地模拟 SSE 响应。`npm run check` 依次执行单元检查、构建和浏览器检查。

自动检查覆盖取消与迟到响应、重试、原目标和补充的传递、两种版本、导出及手机宽度。它们验证程序行为，不证明真人使用效率或模型语义质量。

## ChatGPT 插件方向

建议用 MCP 服务与 MCP Apps 卡片承载“主动开启预思考 → 卡片内延伸 → 交还 ChatGPT 回答”。这是**接入提案，尚未实现或注册为插件**。公开代码目前是一套独立网页应用。

完整路线、官方文档和待验证边界见 [ChatGPT 插件接入提案](docs/chatgpt-plugin-plan.md)。

## 代码结构

- `src/prethink.tsx`、`src/prethink.css`：手机界面与交互状态。
- `server/prethink.mjs`：提示词、输入输出校验、baseline/scoped。
- `server/deepseek-http.mjs`：受限的 DeepSeek Responses SSE 传输。
- `server/prethink-server.mjs`、`server/jobs.mjs`：HTTP 服务、取消与请求版本控制。
- `tests/`：合成测试，未包含私人聊天或历史试用记录。

这个公开仓库是独立整理的源码导出，不含开发时的私人 Git 历史、实验数据库或聊天数据，也不会与私人研究目录自动同步。

## 许可与来源

[MIT](LICENSE)。项目始于对 Microsoft Promptions 的实验；来源及保留的许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
