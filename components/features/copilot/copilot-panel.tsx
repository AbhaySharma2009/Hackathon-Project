"use client";

/**
 * The HR Copilot panel — everything the launcher does not need to draw.
 *
 * This is a separate module so it can be loaded only when the panel is first
 * opened. The conversation state lives in the launcher (`copilot.tsx`), not
 * here, so unmounting this panel when the panel closes does not clear the
 * thread. See that file for the rest.
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
import { useEffect, useRef } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import type { LeavePreviewCard } from "@/server/ai/leave-draft";
import { SafeMarkdown } from "@/components/features/copilot/safe-markdown";
import { LeavePreview } from "@/components/features/copilot/leave-preview-card";
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

export type CopilotMessage = {
  role: "user" | "assistant";
  content: string;
  card?: LeavePreviewCard | null;
};

export function CopilotPanel({
  messages,
  input,
  typing,
  unavailable,
  onSend,
  onInputChange,
  onOutcome,
}: {
  messages: CopilotMessage[];
  input: string;
  typing: boolean;
  unavailable: boolean;
  onSend: (text: string) => void;
  onInputChange: (value: string) => void;
  onOutcome: (message: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Keep the newest turn in view as the conversation grows.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typing]);

  // This panel only mounts when it is opened, so focusing on mount is focusing
  // on open.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function onSubmitOutcome(outcome: { message: string }) {
    // The card reports its result back into the thread the launcher owns, so the
    // outcome survives this panel being unmounted when the panel closes.
    onOutcome(outcome.message);
  }

  return (
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
                      onClick={() => onSend(prompt)}
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
          onSend(input);
        }}
      >
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline, as in every chat UI.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend(input);
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
  );
}