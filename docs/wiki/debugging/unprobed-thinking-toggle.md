# 未探测的自定义端点不发送猜测的思考开关

## Background

结构化调用要求模型不思考（`requiresNonThinkingForStructured`），
工厂层会按档案里的 `thinkingToggle` 生成关闭思考的线上参数
（`thinking` / `enable_thinking` / `chat_template_kwargs` /
`thinking_boolean` / `reasoning_effort`）。档案分三档：内建默认值（按厂商/模型名识别）、
探测结论、用户手动覆盖。

## Current Rule

- 对从未探测过的自定义端点，内建档案的思考开关是 `control: "none"`、
  `supported: false`，工厂层不发送任何思考参数。这是 deliberate 的保守
  姿态：往未知端点猜发参数可能被严格 API 以 400 拒绝，而策略降级换的是
  结构化格式、不会去掉该参数，猜错会造成所有策略一起失败。
- 探测是唯一安全的发现手段：探测会逐个尝试各开关并验证思考输出是否
  真的消失。2026-11-14 产品决策：新建自定义厂商默认开启自动探测
  （创建时写偏好为开启，见 `auto-probe-default-on.md`）；没有偏好
  记录的已有厂商仍按 opt-in 处理，保存时不自动探测。
  `probeIfEnabled` 的 opt-in 语义本身由回归测试钉住，不得擅自翻转。
- 因此 `reasoningForcedOff` 标志只记录“已请求关闭”，不保证线上有参数；
  对无开关的端点，模型仍可能思考并烧光输出预算，失败分类为
  `reasoning_budget_exhausted`。
- 失败文案必须给得出路：`summarizeStructuredOutputFailure` 在
  `requiresNonThinkingForStructured` 为真且 `supportsReasoningToggle`
  为假时，提示用户先做一次兼容探测，而不是只说“关闭深度思考”。

## 自建推理服务把开关放在模板参数里

vLLM、SGLang 一类自建服务只读取
`chat_template_kwargs: {"enable_thinking": false}`，顶层同名参数和
`reasoning_effort` 会被静默接受但不生效。这类端点上的典型表现是：连接检测
通过、结构化模式全部可用，但结构化调用一直把输出额度花在思考上，先报
`output_budget_exhausted`，调高额度后变成 `reasoning_budget_exhausted`。

- 探测的候选开关因此包含 `chat_template_enable_thinking`，判定依据仍是“思考
  输出是否真的消失”，不是参数是否被接受；被忽略的候选会因思考仍在而被排除。
- 这条结论只能由探测结论或用户手动覆盖写入档案，内建默认值不猜：自建地址和
  模型名无法唯一区分 vLLM 和其它实现，与上面的保守姿态一致。
- 排查时先看 `GET /api/settings/model-compat/:provider` 的
  `profile.thinkingToggle.control` 与 `reasoningField`，再决定是否发起一次探测；
  不要靠继续调高输出 Token 上限来掩盖思考没有被真正关闭。

## Related Modules

- `server/src/llm/compatibility/defaults.ts`（内建档案）
- `server/src/llm/compatibility/probe.ts`（探测与 opt-in）
- `server/src/llm/compatibility/adapter.ts`（`thinkingControlKwargs`）
- `server/src/llm/compatibility/profile.ts`（`thinkingToggle.control` 取值集合，与设置页手动覆盖选项保持一致）
- `server/src/llm/factory.ts`（`shouldForceDisableReasoning`）
- `server/src/llm/structuredInvoke.ts`（`summarizeStructuredOutputFailure`）
- 回归测试：`server/tests/structuredReasoningExhaustedProbeHint.test.js`
