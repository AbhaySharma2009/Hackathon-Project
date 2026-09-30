"use client";

import { useEffect, useState } from "react";
import {
  Building2,
  CheckCircle2,
  Mail,
  Pencil,
  ShieldCheck,
  UserMinus,
  UserX,
} from "lucide-react";
import type { AppRole } from "@/shared/types";
import { apiFetch } from "@/shared/api-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { ErrorState } from "@/components/design/states";
import { CardSkeleton, LoadingRegion } from "@/components/design/loaders";

export type EmployeeDetail = {
  employee: {
    id: string;
    name: string;
    photo: string | null;
    role: string;
    department: string;
    manager_id: string | null;
    join_date: string;
    is_active: boolean;
    /** Only present when the caller is entitled to the full record. */
    email?: string;
    app_role?: AppRole;
  };
  manager: { id: string; name: string; photo: string | null; role: string } | null;
  reports: { id: string; name: string; photo: string | null; role: string; department: string }[];
  permissions: {
    is_self: boolean;
    is_hr: boolean;
    is_manager: boolean;
    has_full_access: boolean;
    can_manage: boolean;
    can_edit: boolean;
  };
};

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

/** A label/value pair. The label is muted but never a different size from the
 *  value, so scanning down the column does not jump. */
function Row({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
        {Icon ? <Icon className="size-4" /> : null}
        {label}
      </dt>
      <dd className="min-w-0 text-right text-body">{children}</dd>
    </div>
  );
}

export function EmployeeDetailDrawer({
  employeeId,
  onOpenChange,
  onEdit,
  onDeactivate,
}: {
  employeeId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Omitted by read-only surfaces such as the org chart, which hides the actions. */
  onEdit?: (detail: EmployeeDetail) => void;
  onDeactivate?: (detail: EmployeeDetail) => void;
}) {
  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the very same request; the retry button has no other
  // load path to call.
  const [attempt, setAttempt] = useState(0);

  // Derived, not assigned in an effect: stale until the response lands.
  const loading = employeeId !== null && loadedId !== employeeId;

  useEffect(() => {
    if (!employeeId) return;
    const controller = new AbortController();

    apiFetch<{ data: EmployeeDetail }>(`/api/employees/${employeeId}`, {
      signal: controller.signal,
    })
      .then((res) => {
        setDetail(res.data);
        setError(null);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoadedId(employeeId));

    return () => controller.abort();
  }, [employeeId, attempt]);

  const employee = detail?.employee;

  return (
    <Drawer open={employeeId !== null} onOpenChange={onOpenChange}>
      <DrawerContent className="w-full max-w-md">
        <DrawerHeader>
          <div className="flex items-center gap-4">
            <Avatar size="lg">
              {employee?.photo ? <AvatarImage src={employee.photo} alt="" /> : null}
              <AvatarFallback>{employee ? initials(employee.name) : "··"}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <DrawerTitle className="truncate text-card-title font-semibold">
                {employee ? employee.name : "Employee details"}
              </DrawerTitle>
              <DrawerDescription className="truncate">
                {employee
                  ? `${employee.role} · ${employee.department}`
                  : "Loading the employee record…"}
              </DrawerDescription>
            </div>
          </div>

          {employee ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                <Building2 aria-hidden />
                {employee.department}
              </Badge>
              {employee.is_active ? (
                <Badge variant="success">
                  <CheckCircle2 aria-hidden />
                  Active
                </Badge>
              ) : (
                <Badge variant="neutral">
                  <UserX aria-hidden />
                  Inactive
                </Badge>
              )}
              {employee.app_role ? (
                <Badge variant="outline">
                  <ShieldCheck aria-hidden />
                  {employee.app_role}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </DrawerHeader>

        {loading ? (
          <div className="px-4 pb-6">
            <LoadingRegion label="Loading employee details" />
            <CardSkeleton />
          </div>
        ) : error ? (
          <div className="px-4 pb-6">
            <ErrorState
              title="We couldn't load this employee"
              message={error}
              onRetry={() => {
                setError(null);
                setLoadedId(null);
                setAttempt((n) => n + 1);
              }}
              retrying={loading}
            />
          </div>
        ) : detail && employee ? (
          <div className="space-y-6 px-4 pb-6">
            <dl className="divide-y overflow-hidden rounded-xl border">
              <Row label="Designation">{employee.role}</Row>
              <Row label="Department" icon={Building2}>
                {employee.department}
              </Row>
              <Row label="Manager">{detail.manager?.name ?? "—"}</Row>
              <Row label="Joined">
                <span className="tabular">
                  {new Date(employee.join_date).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              </Row>
              <Row label="Status">
                {employee.is_active ? "Active" : "Inactive"}
              </Row>

              {/* Contact details stay behind the same permission gate as before:
                  the API withholds the email, and this only renders when the
                  record says the viewer may see the full record. */}
              {detail.permissions.has_full_access ? (
                <Row label="Email" icon={Mail}>
                  <span className="break-all">{employee.email ?? "—"}</span>
                </Row>
              ) : null}
            </dl>

            {!detail.permissions.has_full_access ? (
              <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
                Contact details are only visible to the person themselves, their manager and HR.
              </p>
            ) : null}

            {detail.reports.length > 0 ? (
              <>
                <Separator />
                <div>
                  <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Direct reports ({detail.reports.length})
                  </p>
                  <ul className="mt-2.5 space-y-2">
                    {detail.reports.map((report) => (
                      <li key={report.id} className="flex items-center gap-3 text-sm">
                        <Avatar size="sm">
                          {report.photo ? <AvatarImage src={report.photo} alt="" /> : null}
                          <AvatarFallback>{initials(report.name)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate">{report.name}</span>
                        <span className="ml-auto truncate text-sm text-muted-foreground">
                          {report.role}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}

            {detail.permissions.can_edit && onEdit && onDeactivate ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" className="flex-1" onClick={() => onEdit(detail)}>
                  <Pencil className="size-4" aria-hidden />
                  Edit
                </Button>
                {employee.is_active ? (
                  <Button
                    variant="destructive"
                    className="flex-1"
                    onClick={() => onDeactivate(detail)}
                  >
                    <UserMinus className="size-4" aria-hidden />
                    Deactivate
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
