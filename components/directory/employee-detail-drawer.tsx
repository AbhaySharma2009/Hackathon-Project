"use client";

import { useEffect, useState } from "react";
import { Mail, Pencil, ShieldCheck, UserMinus } from "lucide-react";
import type { AppRole } from "@/lib/types";
import { apiFetch } from "@/lib/api-client";
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
import { Skeleton } from "@/components/ui/skeleton";

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
  }, [employeeId]);

  const employee = detail?.employee;

  return (
    <Drawer open={employeeId !== null} onOpenChange={onOpenChange}>
      <DrawerContent className="w-full max-w-md">
        <DrawerHeader>
          <DrawerTitle>Employee details</DrawerTitle>
          <DrawerDescription>
            {employee
              ? `${employee.role} · ${employee.department}`
              : "Loading the employee record…"}
          </DrawerDescription>
        </DrawerHeader>

        {loading ? (
          <div className="space-y-4 px-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : error ? (
          <p className="px-4 text-sm text-destructive">{error}</p>
        ) : detail && employee ? (
          <div className="space-y-6 px-4 pb-6">
            <div className="flex items-center gap-4">
              <Avatar className="size-16">
                {employee.photo ? <AvatarImage src={employee.photo} alt="" /> : null}
                <AvatarFallback>{initials(employee.name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold">{employee.name}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Badge variant="secondary">{employee.department}</Badge>
                  {employee.app_role ? (
                    <Badge variant="outline">
                      <ShieldCheck className="size-3" aria-hidden />
                      {employee.app_role}
                    </Badge>
                  ) : null}
                  {!employee.is_active ? <Badge variant="destructive">Inactive</Badge> : null}
                </div>
              </div>
            </div>

            <dl className="grid grid-cols-3 gap-3 text-sm">
              <dt className="text-muted-foreground">Designation</dt>
              <dd className="col-span-2">{employee.role}</dd>

              <dt className="text-muted-foreground">Manager</dt>
              <dd className="col-span-2">{detail.manager?.name ?? "—"}</dd>

              <dt className="text-muted-foreground">Joined</dt>
              <dd className="col-span-2">
                {new Date(employee.join_date).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </dd>

              {detail.permissions.has_full_access ? (
                <>
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="col-span-2 flex items-center gap-2">
                    <Mail className="size-3.5 text-muted-foreground" aria-hidden />
                    {employee.email ?? "—"}
                  </dd>
                </>
              ) : null}
            </dl>

            {!detail.permissions.has_full_access ? (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                Contact details are only visible to the person themselves, their manager
                and HR.
              </p>
            ) : null}

            {detail.reports.length > 0 ? (
              <>
                <Separator />
                <div>
                  <p className="text-sm font-medium">
                    Direct reports ({detail.reports.length})
                  </p>
                  <ul className="mt-2 space-y-2">
                    {detail.reports.map((report) => (
                      <li key={report.id} className="flex items-center gap-3 text-sm">
                        <Avatar className="size-7">
                          {report.photo ? <AvatarImage src={report.photo} alt="" /> : null}
                          <AvatarFallback className="text-[10px]">
                            {initials(report.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate">{report.name}</span>
                        <span className="ml-auto truncate text-xs text-muted-foreground">
                          {report.role}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}

            {detail.permissions.can_edit && onEdit && onDeactivate ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => onEdit(detail)}
                >
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
