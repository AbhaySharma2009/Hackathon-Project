"use client";

/**
 * The approval timeline: Manager → Department Head → HR.
 *
 * Renders exactly the steps the database returned, in the order it froze them. It
 * does not decide who should be approving, does not infer which levels were
 * "required", and does not fall back to a default approver — a missing or skipped
 * level is drawn as such, because a chain that is short is a real state the
 * approver needs to see.
 *
 * The five glyphs the phase asks for:
 *   ✓  settled and approved
 *   ●  the level the request is waiting on right now
 *   ○  not reached yet
 *   –  a level that is not required for this request (`skipped`)
 *   ⊘  the level that rejected it
 */
import { Check, Circle, CircleSlash, Minus } from "lucide-react";
import type { ApprovalStep, ApprovalStepRole, LeaveStatus } from "@/shared/types";
import { cn } from "@/shared/utils";

export const STEP_ROLE_LABEL: Record<ApprovalStepRole, string> = {
  manager: "Manager",
  department_head: "Dept Head",
  hr: "HR",
};

const ROLE_LONG_LABEL: Record<ApprovalStepRole, string> = {
  manager: "Manager",
  department_head: "Department Head",
  hr: "HR",
};

function decidedLabel(decidedAt: string) {
  return new Date(decidedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

type VisualState = "done" | "current" | "upcoming" | "skipped" | "rejected";

function visualState(step: ApprovalStep, status: LeaveStatus): VisualState {
  if (step.status === "approved") return "done";
  if (step.status === "skipped") return "skipped";
  if (step.status === "rejected") return "rejected";
  if (step.is_current) return "current";
  // A decided request leaves the un-reached levels drawn as "not reached", and a
  // blocked one has no level at all.
  void status;
  return "upcoming";
}

const STATE_TEXT: Record<VisualState, string> = {
  done: "Approved",
  current: "Waiting",
  upcoming: "Not yet",
  skipped: "Not required",
  rejected: "Rejected",
};

const NODE_CLASS: Record<VisualState, string> = {
  done: "border-success bg-success text-white",
  current: "border-primary bg-primary text-primary-foreground ring-4 ring-primary/15",
  upcoming: "border-border bg-background text-muted-foreground",
  skipped: "border-dashed border-border bg-background text-muted-foreground",
  rejected: "border-destructive bg-destructive text-white",
};

const STATE_TEXT_CLASS: Record<VisualState, string> = {
  done: "text-success-foreground",
  current: "text-primary",
  upcoming: "text-muted-foreground",
  skipped: "text-muted-foreground",
  rejected: "text-destructive",
};

function StepGlyph({ step }: { step: ApprovalStep }) {
  if (step.status === "approved") return <Check className="size-4" aria-hidden />;
  if (step.status === "skipped") return <Minus className="size-4" aria-hidden />;
  if (step.status === "rejected") return <CircleSlash className="size-4" aria-hidden />;
  return step.is_current ? (
    <span className="flex size-4 items-center justify-center" aria-hidden>
      <span className="size-2.5 rounded-full bg-current" />
    </span>
  ) : (
    <Circle className="size-4" aria-hidden />
  );
}

/**
 * The horizontal chain, used in the approvals inbox and the request drawer.
 *
 * The level that is live is distinguished by more than colour: it is the only
 * node with a halo, the only one with a filled centre, and the only one whose
 * caption is written in the primary colour.
 */
export function ApprovalTimeline({
  steps,
  status,
  compact = false,
}: {
  steps: ApprovalStep[];
  status: LeaveStatus;
  compact?: boolean;
}) {
  if (steps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No approval chain was recorded for this request.
      </p>
    );
  }

  return (
    <ol className="flex flex-wrap items-start gap-x-1 gap-y-3">
      {steps.map((step, index) => {
        const state = visualState(step, status);
        return (
          <li key={step.id} className="flex items-start gap-1">
            {index > 0 ? (
              <span aria-hidden className="mt-4 h-px w-4 bg-border sm:w-7" />
            ) : null}
            <div className="flex flex-col items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "flex size-7 items-center justify-center rounded-full border transition-shadow",
                  NODE_CLASS[state],
                )}
              >
                <StepGlyph step={step} />
              </span>
              {compact ? (
                <span className="text-xs font-medium text-muted-foreground">
                  {STEP_ROLE_LABEL[step.approver_role]}
                </span>
              ) : (
                <>
                  <span className="text-center text-sm font-semibold leading-tight">
                    {STEP_ROLE_LABEL[step.approver_role]}
                  </span>
                  <span className="max-w-28 text-center text-xs leading-snug text-muted-foreground">
                    {step.approver_name}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-2xs font-semibold leading-none",
                      state === "current" && "bg-primary/10",
                      STATE_TEXT_CLASS[state],
                    )}
                  >
                    {STATE_TEXT[state]}
                  </span>
                  {step.status === "approved" && step.decided_at ? (
                    <span className="text-xs leading-tight text-muted-foreground">
                      {decidedLabel(step.decided_at)}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The compact chain shown on a request card, e.g.
 * `Manager ✓ → Department Head ● → HR ○`.
 *
 * Steps that were `skipped` are omitted — they were not required, so listing them
 * would misstate who is actually waiting.
 */
export function ApprovalStageLine({ steps }: { steps: ApprovalStep[] }) {
  const shown = steps.filter((step) => step.status !== "skipped");
  if (shown.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {shown.map((step, index) => {
        const state = visualState(step, "pending");
        return (
          <span key={step.id} className="inline-flex items-center gap-1.5">
            {index > 0 ? (
              <span aria-hidden className="text-muted-foreground/50">
                →
              </span>
            ) : null}
            <span className={cn(state === "current" && "font-medium text-foreground")}>
              {ROLE_LONG_LABEL[step.approver_role]}
            </span>
            <span
              aria-hidden
              className={cn(
                "font-semibold",
                state === "done"
                  ? "text-success-foreground"
                  : state === "current"
                    ? "text-primary"
                    : "text-muted-foreground/60",
              )}
            >
              {state === "done" ? "✓" : state === "current" ? "●" : "○"}
            </span>
            {/* The glyph alone is not enough for a screen reader to tell a settled
                step from an outstanding one, so the state is spelled out. */}
            <span className="sr-only">
              {state === "done"
                ? "approved"
                : state === "current"
                  ? "awaiting a decision"
                  : "not yet reached"}
            </span>
          </span>
        );
      })}
    </span>
  );
}
