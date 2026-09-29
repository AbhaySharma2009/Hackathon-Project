"use client";

import { useCallback, useState } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { cn } from "cn";

/**
 * Minimal toast stack. The project has no toast dependency, and the approval
 * inbox only needs a success/failure confirmation after a decision, so this
 * keeps the feedback local to the screen that triggers it.
 */
export type ToastTone = "success" | "error" | "info";

type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
};

const TONE_ICON: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: CircleAlert,
  info: Info,
};

const TONE_CLASS: Record<ToastTone, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  error: "text-destructive",
  info: "text-muted-foreground",
};

let nextId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (next: Omit<Toast, "id">) => {
      const id = (nextId += 1);
      setToasts((current) => [...current, { ...next, id }]);
      // Auto-dismiss; the caller does not have to remember to clear it.
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  return { toasts, toast, dismiss };
}

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => {
        const Icon = TONE_ICON[toast.tone];
        return (
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_CLASS[toast.tone])} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{toast.title}</p>
              {toast.description ? (
                <p className="text-xs text-muted-foreground">{toast.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss notification"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
