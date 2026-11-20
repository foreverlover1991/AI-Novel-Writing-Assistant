import type { ModelCapabilityProfile } from "./profile";
export function thinkingControlKwargs(toggle: ModelCapabilityProfile["thinkingToggle"], enabled: boolean, effort = "high"): Record<string, unknown> | undefined {
  if (!toggle.supported) return undefined;
  let kwargs: Record<string, unknown> | undefined;
  switch (toggle.control) {
    case "thinking": kwargs = { thinking: { type: enabled ? "enabled" : "disabled" } }; break;
    case "thinking_boolean": kwargs = { thinking: enabled }; break;
    case "enable_thinking": kwargs = { enable_thinking: enabled }; break;
    // vLLM 与 SGLang 自建服务只读取模板参数里的开关，顶层同名参数会被静默忽略。
    case "chat_template_enable_thinking": kwargs = { chat_template_kwargs: { enable_thinking: enabled } }; break;
    case "reasoning_effort": kwargs = { reasoning_effort: enabled ? effort : "none" }; break;
  }
  return toggle.effort && enabled ? { ...kwargs, reasoning_effort: effort } : kwargs;
}

export function implicatesStructuredMode(input: { category: string; message: string; httpStatus?: number | null; failureReason?: string | null }): boolean {
  if ([401, 403, 429].includes(input.httpStatus ?? 0)
    || ["rate_limited", "network", "blocked", "cancelled", "timeout", "reasoning_budget_exhausted", "output_budget_exhausted"].includes(input.failureReason ?? "")) return false;
  // A 400/422 means the provider rejected the request shape itself, and the
  // shape differs per strategy, so a rejection on a native strategy is evidence
  // against that strategy rather than a transient transport fault: fall back
  // instead of retrying the same rejected shape. Matches the probe's convention
  // of treating 400/422 as a mode failure.
  if (input.httpStatus === 400 || input.httpStatus === 422) return true;
  const message = input.message.replace(/^\[STRUCTURED_OUTPUT:[a-z_]+\]\s*/i, "");
  if (/^\s*(400|422)\b/.test(message) || /\bstatus(?: code)?\s*(400|422)\b/i.test(message)) return true;
  // A grammar compiler rejection is always about this strategy's schema keyword, not
  // about the link, so it is evidence against the native mode even when the endpoint
  // reports it as a server error. Probing can miss it: a tiny probe schema may use no
  // rejected keyword while a product schema does.
  if (/\bgrammar error\b|unimplemented keys/i.test(message)) return true;
  return input.category === "unsupported_native_json" || input.category === "malformed_json"
    || input.failureReason === "empty_response"
    || input.category === "transport_error" && /response_format|json_schema|json_object|tool_choice|tools? (?:unsupported|not supported)|structured[-_ ]output.*(?:transport|unsupported)/i.test(message);
}
