"use client";

/**
 * The HR Copilot: a floating button that opens a chat panel.
 *
 * The launcher and the panel are split across two modules. Only the launcher
 * ships with the app shell; the panel is imported when it is first needed, so a
 * page that is never asked a question never downloads it. The conversation state
 * lives here rather than in the panel precisely so that loading and unloading
 * the panel does not cost the user their thread.
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
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Sparkles, X } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import type { LeavePreviewCard } from "@/server/ai/leave-draft";
import { Button } from "@/components/ui/button";
import type { CopilotMessage } from "@/components/features/copilot/copilot-panel";

const CopilotPanel = dynamic(
  () => import("@/components/features/copilot/copilot-panel").then((m) => m.CopilotPanel),
  // Nothing here is meaningful without the browser: it holds a textarea, a
  // scroll container and the caller's own history.
  { ssr: false },
);

/** Only the recent turns are sent back, so the request stays small. */
const HISTORY_LIMIT = 20;

export function Copilot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    // Escape closes the panel, as it would for any other overlay.
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

  return (
    <>
      {/* The floating launcher, pinned bottom-right on every signed-in page. The
          halo is a static ring plus a soft shadow — no looping animation. */}
      <div className="fixed right-4 bottom-4 z-40 sm:right-6 sm:bottom-6">
        <Button
          size="lg"
          className="rounded-full shadow-lg transition-transform duration-200 hover:scale-[1.03]"
          onClick={() => setOpen((value) => !value)}
          onPointerEnter={preloadPanel}
          onFocus={preloadPanel}
          aria-expanded={open}
          aria-label={open ? "Close the HR Copilot" : "Open the HR Copilot"}
        >
          {open ? <X aria-hidden /> : <Sparkles aria-hidden />}
          {open ? "Close" : "Ask HR Copilot"}
        </Button>
      </div>

      {open ? (
        <CopilotPanel
          messages={messages}
          input={input}
          typing={typing}
          unavailable={unavailable}
          onSend={(text) => void send(text)}
          onInputChange={setInput}
          onOutcome={(message) =>
            setMessages((current) => [...current, { role: "assistant", content: message }])
          }
        />
      ) : null}
    </>
  );
}

/**
 * Warms the panel module without rendering it.
 *
 * Pointing at or tabbing to the launcher is the signal that the panel is wanted,
 * and paying the download there rather than on the click is most of the point of
 * splitting the module at all. The import is the same specifier `dynamic` uses,
 * so the browser serves it from cache.
 */
function preloadPanel() {
  void import("@/components/features/copilot/copilot-panel");
}