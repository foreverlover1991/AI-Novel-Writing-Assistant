# AI 助手边界

## 背景与决策

用户在使用产品时会遇到三类问题：功能怎么用、系统为什么报错、自己的书写到哪了。这些提问分散在不同工作台，新手往往不知道该去哪里找答案。因此在所有页面右下角提供一个全局悬浮的只读 AI 助手：用户提问后，服务端由 AI 判定意图并路由到对应能力，调用确定性只读工具取证据，再流式生成 beginner-friendly 的中文回答。

助手的核心约束是**只读**：它不修改任何业务数据，也不代替创作。所有创作、修改类请求都在回答里引导用户去创作中枢或对应工作台完成。

## 五类能力边界

意图判定是纯 AI 结构化输出（`assistant.intent.route@v1`），禁止关键词或正则 fallback。五个分类各自对应一套只读证据来源：

- **产品用法（product_usage）**：先由 `assistant.docs.select@v1` 从文档目录选出至多 3 篇相关文档，再读取正文作答。文档包在镜像构建时从 `mintlify-docs/` 拷贝进 `/app/docs`，运行期只读，路径白名单限定在文档根内（防目录穿越）。
- **系统日志诊断（system_diagnosis）**：按意图给出的 `logSources` 采集证据——运行错误日志、失败任务记录、LLM 会话错误事件，据实说明报错原因，不臆测。
- **已写小说内容（novel_content）**：给出小说概览（标题、题材、卷章结构、最近章节）；RAG 可用时按 `novelId` 限定 ownerTypes 检索 top4 片段，不可用时降级为检索命中章节全文截断。
- **写作基础概念（writing_knowledge）**：读术语表与写作指南目录摘要作答；术语表未收录时如实说明，不编造词条。
- **日常对话（chitchat）**：不调用任何工具，直接友好回应。

## 只读约束

工具层 `services/assistant/assistantTools.ts` 全部是 Prisma 查询、文件读取与 RAG 检索，**不 import 任何写服务**。这一约束由 `server/tests/assistantTools.test.js` 断言（检查无写调用、路径穿越被拒绝、截断上限生效）。创作或修改类意图在 `assistant.answer.compose@v1` 提示词中统一指引去创作中枢或源工作台，遵守任务中心只读规则与创作中枢边界。

## 与创作中枢 / 任务中心的分工

- **创作中枢**：真正产出与修改小说内容的地方。助手只回答"写到哪了""某段讲了什么"，需要续写、改写时引导用户去创作中枢或章节编辑器。
- **任务中心**：任务的权威只读视图。助手诊断时读取失败任务记录作为证据，但不代替任务中心展示完整任务状态，也不触发任何任务操作。
- **模型路由管理**：助手走新增的 TaskType `assistant`，默认沿用 `chat` 路由（不新增 `MODEL_ROUTE_TASK_TYPES` 条目，避免拉高 onboarding"未配置"比例）；用户可在模型路由管理页为助手改派模型。

## 运行错误日志落盘合同

为支撑系统诊断能力，服务端把运行错误追加写到 `<logsRoot>/server/runtime-<日期>.log`（compose 部署即宿主机 `data/logs/server/`，容器内 `/app/.logs/server/`）：

- 三个挂钩点：`app.ts` morgan 自定义格式（status >= 400 或存在 error-message 时追加一行 method/url/status/耗时/error）、`middleware/errorHandler.ts`（追加 requestId 与截断至 2KB 的堆栈）、启动处注册的 `unhandledRejection` / `uncaughtException`。
- 无条件开启（仅错误行，量小）；复用 `logRetention.ts` 的轮转与保留配置（14 天 / 50MB）。
- 写日志失败只告警不抛出，绝不影响主请求链路。
- 助手诊断时读取近 24 小时末尾 200 行作为证据。

## 相关模块与验证

`routes/assistant.ts` 提供 `POST /api/assistant/chat`（authMiddleware + zod 校验，SSE 帧合同 `assistant/intent`、`assistant/tool`、`assistant/delta`、`assistant/done`、`assistant/error`）；`services/assistant/assistantService.ts` 编排 intent → 工具 → answer；`prompting/prompts/assistant/assistant.prompts.ts` 定义三个 PromptAsset 并注册进 registry；前端 `components/assistant/AssistantFloatingPanel.tsx` 在 `AppLayout.tsx` 全局挂载（令牌闸门 / 登录前页面不渲染）。

POST 流式响应用 `res.once("close")` 感知客户端断开，不能用 `req.on("close")`——后者在请求体读完后立即触发，会误中止模型调用。

服务端测试覆盖 Prompt 资产注册与 schema 边界、工具只读与截断、SSE 帧顺序与错误帧、运行错误日志格式与轮转，均在容器内以假 PostgreSQL `DATABASE_URL` 且不加载 sqlite-preload 的方式跑通。
