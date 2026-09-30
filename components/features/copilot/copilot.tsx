"use client";

/**
 * The HR Copilot: a floating button that opens a chat panel.
 *
 * Two behaviours here are deliberate and worth knowing before changing anything:
 *
 *   - The panel is entirely self-contained. If `/api/ai/chat` is slow, errors, or
 *     the server has no model key at all, the rest of the app is untouched. There
 *     is no provider call from the browser, and the key never leaves the server.
 *   - Submitting a request from a preview card is an ordinary form post to
 *     `/api/leave-requests`. The assistant cannot create leave; it can only
 *     pre-fill a card the employee then confirms.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, X } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import type { LeavePreviewCard } from "@/server/ai/leave-draft";
import { SafeMarkdown } from "@/components/features/copilot/safe-markdown";
import {
  LeavePreview,
  type PreviewOutcome,
} from "@/components/features/copilot/leave-preview-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InlineError } from "@/components/design/states";
import { cn } from "@/shared/utils";

const SUGGESTED_PROMPTS = [
  "How many leaves do I have left?",
  "Who is my manager?",
  "Show my leave history",
  "Why was my leave rejected?",
  "I want casual leave from 12th to 15th October",
];

type Message = {
  role: "user" | "assistant";
  content: string;
  card?: LeavePreviewCard | null;
};

/** Only the recent turns are sent back, so the request stays small. */
const HISTORY_LIMIT = 20;

export function Copilot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Keep the newest turn in view as the conversation grows.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typing]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape closes the panel, as it would for any other overlay.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || typing) return;

      setInput("");
      setUnavailable(false);

      // The history sent to the server excludes cards — a card is a rendered UI
      // object, and re-sending it as prose would just confuse the model.
      const history = messages
        .filter((message) => message.content.trim().length > 0)
        .slice(-HISTORY_LIMIT)
        .map(({ role, content }) => ({ role, content }));

      setMessages((current) => [...current, { role: "user", content: trimmed }]);
      setTyping(true);

      try {
        const response = await apiFetch<{
          data: { message: string; card: LeavePreviewCard | null; tools_used: string[] };
          meta: { available: boolean };
        }>("/api/ai/chat", {
          method: "POST",
          body: JSON.stringify({ message: trimmed, history }),
        });

        if (!response.meta.available) setUnavailable(true);

        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            content: response.data.message,
            card: response.data.card ?? null,
          },
        ]);
      } catch (error) {
        // The app is still fine; only the assistant failed. Say so, and keep the
        // conversation so the user can retry or carry on in the app.
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            content:
              error instanceof Error
                ? error.message
                : "The assistant is unavailable right now. The rest of the app still works — you can book leave from My Leaves.",
          },
        ]);
      } finally {
        setTyping(false);
      }
    },
    [messages, typing],
  );

  function onSubmitOutcome(outcome: PreviewOutcome) {
    setMessages((current) => [
      ...current,
      { role: "assistant", content: outcome.message },
    ]);
  }

  return (
    <>
      {/* The floating launcher, pinned bottom-right on every signed-in page. The
          halo is a static ring plus a soft shadow — no looping animation. */}
      <div className="fixed right-4 bottom-4 z-40 sm:right-6 sm:bottom-6">
        <Button
          size="lg"
          className="rounded-full shadow-lg transition-transform duration-200 hover:scale-[1.03]"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? "Close the HR Copilot" : "Open the HR Copilot"}
        >
          {open ? <X aria-hidden /> : <Sparkles aria-hidden />}
          {open ? "Close" : "Ask HR Copilot"}
        </Button>
      </div>

      {open ? (
        <section
          data-slot="copilot-panel"
          className={cn(
            "fixed z-40 flex w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl",
            "max-md:inset-x-3 max-md:bottom-20 max-md:h-[calc(100dvh-7.5rem)]",
            "sm:bottom-24 sm:right-6 sm:h-[min(34rem,calc(100dvh-8rem))]",
          )}
          aria-label="HR Copilot"
        >
          <header className="flex items-center gap-3 border-b bg-gradient-to-r from-primary/8 to-transparent px-4 py-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Sparkles className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-nav font-semibold">HR Copilot</p>
              <p className="truncate text-xs text-muted-foreground">
                Answers from your own leave data
              </p>
            </div>
            {unavailable ? (
              <Badge variant="warning">Offline</Badge>
            ) : (
              <Badge variant="secondary" className="hidden sm:inline-flex">
                Session scoped
              </Badge>
            )}
          </header>

          <div ref={scrollRef} className="scrollbar-slim flex-1 space-y-4 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <p className="text-card-title font-semibold">What can I help with?</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Ask about your leave, your balances, or who is away. I can draft a leave
                    request for you to review and send.
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Try asking
                  </p>
                  <ul className="space-y-1.5">
                    {SUGGESTED_PROMPTS.map((prompt) => (
                      <li key={prompt}>
                        <button
                          type="button"
                          onClick={() => void send(prompt)}
                          className="w-full rounded-lg border bg-muted/30 px-3 py-2 text-left text-sm leading-snug transition-colors duration-150 hover:border-primary/30 hover:bg-accent"
                        >
                          {prompt}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              messages.map((message, index) => (
                <div
                  key={index}
                  data-slot="copilot-message"
                  data-role={message.role}
                  className={cn(
                    "max-w-[92%] space-y-2",
                    message.role === "user" && "ml-auto",
                  )}
                >
                  {message.role === "assistant" ? (
                    <>
                      <div className="rounded-xl rounded-tl-sm border bg-muted/30 px-3.5 py-2.5">
                        <SafeMarkdown text={message.content} />
                      </div>
                      {message.card ? (
                        <LeavePreview card={message.card} onResult={onSubmitOutcome} />
                      ) : null}
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap rounded-xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm leading-relaxed text-primary-foreground">
                      {message.content}
                    </p>
                  )}
                </div>
              ))
            )}

            {typing ? (
              <div
                data-slot="copilot-typing"
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <span className="inline-flex items-center gap-1" aria-hidden>
                  <Loader2 className="size-4 animate-spin" />
                </span>
                Checking your data…
              </div>
            ) : null}

            {/* The assistant being unavailable is a normal state, not a crash: the
                rest of the app is untouched, so it is stated plainly and the
                conversation stays open. */}
            {unavailable && !typing ? (
              <InlineError
                className="text-sm"
                message="The assistant can't reach its model right now. Everything else in OrgFlow still works — book leave from My Leaves."
              />
            ) : null}
          </div>

          <form
            className="flex items-end gap-2 border-t bg-muted/20 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline, as in every chat UI.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder="Ask about your leave…"
              className="min-h-11 resize-none"
              aria-label="Message the HR Copilot"
            />
            <Button
              type="submit"
              size="icon"
              className="size-11 shrink-0"
              disabled={!input.trim() || typing}
              aria-label="Send"
            >
              {typing ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
            </Button>
          </form>
        </section>
      ) : null}
    </>
  );
}
