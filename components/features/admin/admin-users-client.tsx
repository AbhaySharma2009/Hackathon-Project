"use client";

import { useCallback, useMemo, useState } from "react";
import { Plus, UserCog } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/design/page-header";
import { EmptyState, ErrorState } from "@/components/design/states";
import { TableSkeleton } from "@/components/design/loaders";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ToastViewport, useToast } from "@/components/ui/toast";
import { useAdminResource } from "@/components/features/admin/use-admin-resource";
import type { AdminUser, AppRole } from "@/shared/types";

const ROLE_OPTIONS: { value: AppRole; label: string }[] = [
  { value: "employee", label: "Employee" },
  { value: "manager", label: "Manager" },
  { value: "hr", label: "HR" },
  { value: "admin", label: "Admin" },
  { value: "super_admin", label: "Super Admin" },
];

const NO_MANAGER = "__none__";

/**
 * The administrator's directory: who is here, what they do, and who they report
 * to.
 *
 * Each row edits in place and saves immediately. The database is the authority —
 * it refuses to demote the last administrator, to appoint a plain employee as a
 * manager, to file somebody under a department that does not exist, and to build
 * a reporting cycle — and those refusals are surfaced verbatim rather than being
 * swallowed into a generic "could not save".
 */
export function AdminUsersClient() {
  const [savingId, setSavingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { toasts, toast, dismiss } = useToast();

  const fetchDirectory = useCallback(
    () =>
      Promise.all([
        apiFetch<{ data: AdminUser[] }>("/api/admin/users").then((r) => r.data),
        apiFetch<{ data: string[] }>("/api/admin/departments").then((r) => r.data),
      ]).then(([users, departments]) => ({ users, departments })),
    [],
  );
  const { data, loading, error, reload } = useAdminResource(fetchDirectory);

  const users = data?.users ?? null;
  const departments = data?.departments ?? [];

  /**
   * Who may be chosen as a manager: active people who already hold authority.
   * Offering anybody else would only produce a rejection from the database.
   */
  const managerChoices = useMemo(
    () =>
      (users ?? [])
        .filter((u) => u.is_active && u.app_role !== "employee")
        .map((u) => ({ id: u.id, name: u.name })),
    [users],
  );

  const patch = async (id: string, body: Record<string, unknown>) => {
    setSavingId(id);
    try {
      await apiFetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await reload();
      toast({ tone: "success", title: "Saved" });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not save",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
      // Re-read so the control snaps back to the value the database still holds.
      await reload();
    } finally {
      setSavingId(null);
    }
  };

  const setActive = async (user: AdminUser, isActive: boolean) => {
    setSavingId(user.id);
    try {
      await apiFetch(`/api/admin/users/${user.id}/active`, {
        method: "POST",
        body: JSON.stringify({ is_active: isActive }),
      });
      await reload();
      toast({
        tone: "success",
        title: isActive ? `${user.name} restored` : `${user.name} deactivated`,
        description: isActive
          ? "They can sign in again."
          : "Their history, balances and past decisions are untouched.",
      });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not change access",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & roles"
        description="Change who holds which role, where they sit, and who they report to."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add person
          </Button>
        }
      />

      {loading ? (
        <TableSkeleton rows={6} columns={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} retrying={loading} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Directory</CardTitle>
          </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Reports to</TableHead>
                <TableHead className="text-right">Access</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users ?? []).map((user) => (
                <TableRow key={user.id} className={user.is_active ? undefined : "opacity-60"}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar size="sm">
                        {user.photo ? (
                          <AvatarImage src={user.photo ?? undefined} alt="" />
                        ) : null}
                        <AvatarFallback>
                          {user.name
                            .split(" ")
                            .map((part) => part[0])
                            .join("")
                            .slice(0, 2)
                            .toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{user.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                      </div>
                    </div>
                  </TableCell>

                  <TableCell>
                    <Select
                      value={user.app_role}
                      disabled={savingId === user.id}
                      onValueChange={(value) =>
                        patch(user.id, { app_role: value as AppRole })
                      }
                    >
                      <SelectTrigger className="w-36" aria-label={`Role for ${user.name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>

                  <TableCell>
                    <Select
                      value={user.department ?? NO_MANAGER}
                      disabled={savingId === user.id}
                      onValueChange={(value) =>
                        patch(user.id, {
                          department: value === NO_MANAGER ? null : value,
                        })
                      }
                    >
                      <SelectTrigger className="w-44" aria-label={`Department for ${user.name}`}>
                        <SelectValue placeholder="No department" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_MANAGER}>No department</SelectItem>
                        {departments.map((dept) => (
                          <SelectItem key={dept} value={dept}>
                            {dept}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>

                  <TableCell>
                    <Select
                      value={user.manager_id ?? NO_MANAGER}
                      disabled={savingId === user.id}
                      onValueChange={(value) =>
                        patch(user.id, {
                          manager_id: value === NO_MANAGER ? null : value,
                        })
                      }
                    >
                      <SelectTrigger className="w-44" aria-label={`Manager for ${user.name}`}>
                        <SelectValue placeholder="Nobody" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_MANAGER}>Nobody</SelectItem>
                        {managerChoices
                          .filter((m) => m.id !== user.id)
                          .map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </TableCell>

                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={savingId === user.id}
                      onClick={() => setActive(user, !user.is_active)}
                    >
                      {user.is_active ? "Deactivate" : "Restore"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {(users ?? []).length === 0 ? (
            <EmptyState
              icon={UserCog}
              title="Nobody here yet"
              description="Add the first person to get started."
            />
          ) : null}
        </CardContent>
        </Card>
      )}

      <AddPersonDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        departments={departments}
        managerChoices={managerChoices}
        onCreated={reload}
      />

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/**
 * Creates a login and the matching employee record together.
 *
 * The password is a required field rather than an invitation email, because the
 * admin API sets the credential directly and there is no mail delivery in this
 * demo. The person it creates is active immediately.
 */
function AddPersonDialog({
  open,
  onOpenChange,
  departments,
  managerChoices,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departments: string[];
  managerChoices: { id: string; name: string }[];
  onCreated: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    password: "OrgFlow@2026",
    app_role: "employee" as AppRole,
    department: NO_MANAGER,
    manager_id: NO_MANAGER,
    job_title: "Employee",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toasts, toast, dismiss } = useToast();

  const set = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          full_name: form.full_name,
          email: form.email,
          password: form.password,
          app_role: form.app_role,
          department: form.department === NO_MANAGER ? null : form.department,
          manager_id: form.manager_id === NO_MANAGER ? null : form.manager_id,
          job_title: form.job_title,
        }),
      });
      await onCreated();
      toast({
        tone: "success",
        title: `${form.full_name} added`,
        description: "Their leave balances for this year were allocated automatically.",
      });
      onOpenChange(false);
      setForm((prev) => ({ ...prev, full_name: "", email: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a person</DialogTitle>
          <DialogDescription>
            Creates a login and an employee record together, with this year&apos;s leave
            balances allocated.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Full name" htmlFor="np-name">
            <Input
              id="np-name"
              value={form.full_name}
              onChange={(e) => set("full_name", e.target.value)}
            />
          </Field>

          <Field label="Email" htmlFor="np-email">
            <Input
              id="np-email"
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role" htmlFor="np-role">
              <Select value={form.app_role} onValueChange={(v) => set("app_role", v as string)}>
                <SelectTrigger id="np-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Job title" htmlFor="np-title">
              <Input
                id="np-title"
                value={form.job_title}
                onChange={(e) => set("job_title", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Department" htmlFor="np-dept">
              <Select value={form.department} onValueChange={(v) => set("department", v as string)}>
                <SelectTrigger id="np-dept">
                  <SelectValue placeholder="No department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MANAGER}>No department</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Reports to" htmlFor="np-manager">
              <Select value={form.manager_id} onValueChange={(v) => set("manager_id", v as string)}>
                <SelectTrigger id="np-manager">
                  <SelectValue placeholder="Nobody" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MANAGER}>Nobody</SelectItem>
                  {managerChoices.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field
            label="Starting password"
            htmlFor="np-password"
            hint="Shared with them directly. At least 8 characters."
          >
            <Input
              id="np-password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
            />
          </Field>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !form.full_name || !form.email}>
            {busy ? "Adding…" : "Add person"}
          </Button>
        </DialogFooter>

        <ToastViewport toasts={toasts} onDismiss={dismiss} />
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}