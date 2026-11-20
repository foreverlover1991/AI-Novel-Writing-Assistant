# 自定义网关的连接合同与探测预算

## Background

自定义渠道的输入全部来自用户粘贴：接口文档里的请求地址、控制台里的密钥、网关给的模型名。
这三项只要有一项和代码期望的形态不一致，用户看到的就是「模型检测未通过」，而且报错文案
可能指向一个用户根本没选的协议，把人带离真实原因。

典型场景是一个 OpenAI 兼容的 vLLM 网关，文档写着完整请求地址
`http://host:port/api/inference/v1/chat/completions`，密钥示例写着 `Bearer <token>`。
按字面粘贴后可能同时踩中四类问题：鉴权头方案不对、路径被重复拼接、密钥前缀被重复、
思考型模型把探测预算吃光导致「空正文」。这四类的表现完全不同，但都会伪装成同一句检测失败。

## Decision

渠道层把用户粘贴的内容当作「原始输入」，在进入任何网络请求之前归一化成项目内部合同
（版本根地址 + 纯密钥 + 鉴权头方案），并且探测必须能区分「渠道不可用」和「渠道可用但输出预算不够」。

鉴权方式不写死在传输层：`authMode` 是渠道属性，Anthropic 传输层和 OpenAI 兼容传输层都读同一个值。
这与《当前模型选择与厂商默认模型边界》里「模型目录、连接测试、正式生成必须读取同一 `authMode`」的规则一致。

## Current Rule

### 归一化发生在发送之前

- `normalizeBaseURL` 只做一件事：剥离尾部已知的操作路径（`chat/completions`、`completions`、
  `responses`、`messages`、`embeddings`）和多余斜杠，把输入收敛到版本根地址。它是有限枚举的尾部剥离，
  不是通用路径裁剪，因此 `https://host/api/inference/v1` 这类自定义前缀会被完整保留。
- `normalizeProviderApiKey` 剥离 `Bearer ` 方案前缀和空白，返回纯密钥。所有从厂商密钥记录取值的入口
  （LLM 工厂层、模型目录列表、Embedding 服务）都必须先过它；只有统一的鉴权头构造函数允许拼接
  `Bearer ` 前缀，业务代码里散落的 `` `Bearer ${apiKey}` `` 会造成双重前缀。
- 归一化只发生在读取配置的链路上（`resolveProviderBaseUrl` 一类），不改写用户保存的原始值；
  展示给用户时仍是他填的那个地址。
- 注意 Anthropic 传输层自己还有一层收敛：它要求地址停在版本根（结尾不是 `/v1` 时会补 `/v1`）。
  因此一个版本前缀不是 `/v1` 的 Anthropic 兼容网关需要显式验证，不能假设 providers 层的归一化已经够用。

### 鉴权头由 `authMode` 决定，两种协议都一样

- `bearer` → `Authorization: Bearer <key>`；`x-api-key` → `x-api-key: <key>`；`none` → 不发鉴权头。
- Anthropic 传输层必须接受 `authMode`。第三方 Anthropic 兼容网关大多只读 `Authorization`，
  只发 `x-api-key` 会被判为缺失鉴权头。
- 唯一例外是官方 `anthropic` 厂商：它在工厂层被固定为 `x-api-key`，不受渠道设置影响。

### 探测预算要容得下推理

- 连通性探测的输出预算必须大于「推理 + 最短答案」：普通文本 `512`、结构化 `1024`。
  这与兼容性探测的 512 预算是同一套理由，见《新增厂商默认关闭思考与探测韧性》。
- 只收到推理内容也算连通证据：推理文本证明请求已经被模型处理。正文和推理**都**为空才是失败。
- 代价必须清楚：结构化探测会依次尝试多种格式策略与协议，思考模型下整场检测可能耗时十几到几十秒。
  这是「不误判可用渠道」换取的成本，不要为了省时间再把预算调回几十 token。

### 失败原因按协议分别列出

- `requestProtocol` 为 `auto` 时按 `openai_compatible` → `anthropic` 顺序回退。
  回退链上所有候选都失败时，错误文案必须按协议分别列出原因（`OpenAI 兼容协议：…；Anthropic 协议：…`）。
- 禁止只保留最后一个候选的错误。用户配置的是 OpenAI 兼容网关，却看到一句 Anthropic 的 401，
  只会把排查引向错误的方向。
- 不要用报错文案做关键词路由或硬编码分类来「修好」提示；缺信息就补结构化字段，不要靠正则猜。

### 模型目录请求的响应也必须做内容识别

- 目录地址拼错时会落在网关的网页控制台：HTTP 状态码是 200，正文是 HTML。
  裸 `response.json()` 会抛 SyntaxError 并以「服务器错误，请稍后重试」的 500 呈现，
  把一个填错地址的问题伪装成服务端故障。
- `modelCatalog` 的 `fetchJson` 因此必须先识别 content-type / 正文开头再解析：
  非 JSON 正文、无法解析的正文、请求超时，都转成带指引的中文错误（含「失败」字样），
  由路由层归类为 400。判定方式见 `isModelFetchError`，两者是成对合同，改一处必须同步另一处。
- 网关按 key 过滤模型列表是正常行为：每个 key 只能看到自己授权的模型，
  「已获取 1 个模型」不代表网关只有这一个模型。

### 向量化专用渠道按真实能力判定

- 公共入口按服务 ID 区分能力面：`.../v1/embeddings` 服务没有对话接口，对话探测
  （`/chat/completions`）必然得到 404/500。这不是配置错误，而是渠道用途不同。
- 厂商检测入口（`POST /api/llm/test`）在对话探测全部失败后，会用同一套归一化与鉴权合同
  向 `/embeddings` 发一次真实请求（`probeEmbeddingEndpoint`）：成功则返回
  `embeddingOnly` 判定并引导到知识库向量设置，失败才保留原有报错。
- 判定依据是真实请求结果（2xx + 非空 `data` 数组），不是错误文案路由；
  模型路由检测（`testModelRoutes`）不经过这条增强路径，对话路由选了向量服务仍会判失败。
- 弹窗里 API Key 留空表示沿用保存配置，此时请求体不带 key/地址：向量化探测必须先从
  `APIKey` 表回退取保存的 key/baseURL/model/authMode，否则探测缺少鉴权，
  会把配置正确的向量服务误判成连接失败（已踩过：第一轮实现只认请求体参数）。
- 同类回退也适用于异常路径：缺少密钥时 `resolveLLMClientOptions` 直接 throw，
  `/test` 路由的 catch 对含「API Key / 未配置」的错误转 400 具体提示，不能冒成 500。

## Examples

- 推荐：渠道地址填 `http://host:30808/api/inference/v1`，密钥填纯 token，鉴权方式选 `bearer`。
- 可接受：用户直接粘贴文档里的完整 `.../v1/chat/completions` 和 `Bearer <token>`，
  由归一化层收敛，检测与生成都能正常走通。
- 不推荐：在 `anthropicClient` 里写死 `x-api-key`，或为某个网关加一条「如果是 xxx 域名就发 Bearer」的特判。
- 不推荐：把 `normalizeProviderApiKey` 的结果再存回数据库覆盖用户原始输入。

## Failure Modes

先用 curl 打网关，把四类原因分开，不要一上来改代码：

| 现象 | 原因 | 判定方式 |
| --- | --- | --- |
| `401 缺失Authorization header` | 发了 `x-api-key`，网关只认 `Authorization` | 用 `Authorization: Bearer <key>` 重试，成功即确认 |
| `401 apiKey无效` | 密钥错，或双重 `Bearer Bearer <key>` | 检查请求头里 `Bearer` 出现了几次 |
| `500 / 404 Not Found`，路径里出现两次 `/chat/completions` | 用户粘贴了完整请求地址 | 看拼出的 URL 是否路径重复 |
| `200` 但 `content` 为 `null`，只有 `reasoning_content` | 输出预算全被推理吃掉 | 逐步放大 `max_tokens`（16 / 64 / 256 / 512）观察正文何时出现 |

- 排查推荐顺序：`GET <版本根地址>/models` 带 `Bearer` 验证鉴权与根地址 → 小请求验证正文 → 再验证结构化格式。
- 短期掩盖手段（禁止）：调低检测的判定标准、把空正文当成通过、只在 UI 上隐藏协议错误。
- 纯思考模型且从未探测过时，仍可能没有可用的关思考参数，此时结构化会归类为
  `reasoning_budget_exhausted`，出路是先做一次兼容探测，见《未探测厂商的思考开关》。

## Related Modules

- `server/src/llm/providers.ts`：`normalizeBaseURL`、`normalizeProviderApiKey`、厂商环境密钥。
- `server/src/llm/anthropicClient.ts`：`buildAuthHeaders`，Anthropic 传输层的鉴权头选择。
- `server/src/llm/factory.ts`：密钥归一化与向 Anthropic 客户端传递 `authMode`。
- `server/src/llm/modelCatalog.ts`：模型列表端点与列表请求头，必须与生成走同一套归一化；
  目录响应的内容识别与 400 转换也在这里。
- `server/src/routes/settings/customProviderRoutes.ts`：`isModelFetchError` 把目录失败归为 400。
- 回归测试：`server/tests/modelCatalog.test.js`（网页正文、空 JSON 两个用例）；
  `server/tests/llmEmbeddingProbe.test.js`（向量化探测的路径归一、鉴权头、失败分类）。
- `server/src/llm/connectivity.ts`：探测预算、推理证据、多协议失败汇总；
  `probeEmbeddingEndpoint` 是向量化渠道的判定入口。
- `server/src/services/rag/EmbeddingService.ts`：与对话模型共用厂商密钥记录，取密钥时走同一归一化。
- `server/src/modules/setup/onboarding/application/QuickSetupService.ts`：「模型检测未通过」文案来源。
- 回归测试：`server/tests/llmProviderConnectionContract.test.js`

## 来源文档

- [当前模型选择与厂商默认模型边界](../architecture/model-selection.md)
- [未探测厂商的思考开关](./unprobed-thinking-toggle.md)
- [新增厂商默认关闭思考与探测韧性](./probe-resilience-and-reasoning-default.md)
- [自定义厂商默认自动探测](./auto-probe-default-on.md)
