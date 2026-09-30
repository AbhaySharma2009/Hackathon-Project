import { CheckCircle2, Clock, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { LeaveStatus } from "@/shared/types";

/**
 * One status treatment for the whole app.
 *
 * Status colour was previously chosen per screen: `pending` was grey in one
 * place and blue in another, and "rejected" was red everywhere, which made a
 * closed request look like a live problem. Every status now maps to the same
 * variant, the same label and the same icon, so a colour is never the only
 * signal — the word is always present too.
 */
const STATUS: Record<
  LeaveStatus,
  {
    label: string;
    variant: "info" | "success" | "destructive" | "neutral" | "warning";
    icon: typeof Clock;
  }
> = {
  pending: { label: "Pending", variant: "info", icon: Clock },
  approved: { label: "Approved", variant: "success", icon: CheckCircle2 },
  rejected: { label: "Rejected", variant: "destructive", icon: XCircle },
  cancelled: { label: "Cancelled", variant: "neutral", icon: XCircle },
  approval_blocked: { label: "Needs attention", variant: "warning", icon: ShieldAlert },
};

export function statusMeta(status: LeaveStatus) {
  return STATUS[status] ?? STATUS.pending;
}

export function StatusBadge({
  status,
  className,
}: {
  status: LeaveStatus;
  className?: string;
}) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      <Icon aria-hidden />
      {meta.label}
    </Badge>
  );
}
