import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import MarkdownViewer from "@/components/common/MarkdownViewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAssistantChat, type AssistantChatMessage } from "./useAssistantChat";

/** 五类能力各一条示例提问，作为快捷 chips。 */
const QUICK_PROMPTS: { label: string; message: string }[] = [
  { label: "功能用法", message: "自动导演怎么用？" },
  { label: "故障诊断", message: "刚才系统为什么报错？" },
  { label: "我的小说", message: "我的书写到哪了？" },
  { label: "写作概念", message: "什么是黄金三章？" },
  { label: "随便聊聊", message: "陪我聊聊写作灵感吧。" },
];

const CATEGORY_LABEL: Record<string, string> = {
  product_usage: "产品用法",
  system_diagnosis: "系统诊断",
  novel_content: "小说内容",
  writing_knowledge: "写作概念",
  chitchat: "日常对话",
};

/** 从当前路由推断小说 id，让「我的书」类提问自带上下文。 */
function useCurrentNovelId(): string | null {
  const location = useLocation();
  return useMemo(() => {
    const match = /^\/novels\/([^/]+)/.exec(location.pathname);
    return match?.[1] ?? null;
  }, [location.pathname]);
}

function ToolProgressRow({ message }: { message: AssistantChatMessage }) {
  if (!message.tools || message.tools.length === 0) {
    return null;
  }
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {message.tools.map((tool) => (
        <span
          key={tool.tool}
          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          {tool.status === "running" ? <span className="animate-pulse">●</span> : null}
          {tool.summary}
        </span>
      ))}
    </div>
  );
}

/**
 * 全局唯一的右下角 AI 助手悬浮面板。
 * 只读问答：问功能用法、查故障原因、聊你的小说内容。关闭面板即清空会话（MVP 无持久化）。
 */
export default function AssistantFloatingPanel() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const novelId = useCurrentNovelId();
  const { messages, isStreaming, send, stop, clear } = useAssistantChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  const submit = (text: string) => {
    const value = text.trim();
    if (!value || isStreaming) {
      return;
    }
    setDraft("");
    void send(value, novelId);
  };

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 inline-flex h-14 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground shadow-lg transition-transform hover:scale-105"
        >
          <span aria-hidden>✦</span>
          AI 助手
        </button>
      ) : null}

      {open ? (
        <div className="fixed bottom-6 right-6 z-50 flex h-[min(640px,calc(100dvh-3rem))] w-[min(400px,calc(100vw-3rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">AI 助手</div>
              <div className="truncate text-[11px] text-muted-foreground">问功能用法、查故障原因、聊你的小说内容</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" onClick={clear} disabled={messages.length === 0}>清空</Button>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>关闭</Button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  我是只读助手，可以帮你理解产品用法、诊断系统报错、回顾你已写的小说内容、讲解写作概念，也能陪你聊聊。想开始就点下面的示例，或直接输入问题。
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_PROMPTS.map((prompt) => (
                    <button
                      key={prompt.label}
                      type="button"
                      onClick={() => submit(prompt.message)}
                      className="rounded-full border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent"
                    >
                      {prompt.message}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={
                      message.role === "user"
                        ? "max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                        : "max-w-[92%] min-w-0 rounded-lg bg-muted/50 px-3 py-2"
                    }
                  >
                    {message.role === "assistant" ? (
                      <>
                        {message.category ? (
                          <div className="mb-1 text-[11px] text-muted-foreground">{CATEGORY_LABEL[message.category] ?? message.category}</div>
                        ) : null}
                        <ToolProgressRow message={message} />
                        {message.content ? (
                          <div className={message.error ? "text-sm text-destructive" : ""}>
                            <MarkdownViewer content={message.content} />
                          </div>
                        ) : message.streaming ? (
                          <div className="text-xs text-muted-foreground">正在思考…</div>
                        ) : null}
                      </>
                    ) : (
                      <span className="whitespace-pre-wrap break-words">{message.content}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit(draft);
                  }
                }}
                placeholder="输入你的问题…"
                className="h-9 flex-1"
                maxLength={2000}
              />
              {isStreaming ? (
                <Button variant="outline" size="sm" onClick={stop}>停止</Button>
              ) : (
                <Button size="sm" onClick={() => submit(draft)} disabled={!draft.trim()}>发送</Button>
              )}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">助手只做只读问答，不会修改你的作品；关闭面板将清空本次对话。</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
