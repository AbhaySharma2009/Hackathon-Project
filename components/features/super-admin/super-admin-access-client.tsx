"use client";

/**
 * Access & escalation.
 *
 * Two controls, both Super-Admin-only, and both about the same failure mode:
 * the top tier approving itself.
 *
 *   1. The role matrix. Which roles this actor may assign. `assignable` comes
 *      from `admin_role_catalog` rather than from a client-side role comparison,
 *      because the answer is viewer-dependent and must not be the UI's decision.
 *      Greying a row here is presentation — `admin_create_employee` and
 *      `admin_update_employee` refuse the write again in the database.
 *
 *   2. The fallback approver. Who signs a Super Admin's own leave. Left unset,
 *      such a request is parked as blocked. There is no self-approval path.
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/design/page-header";
import { ErrorState } from "@/components/design/states";
import { ListSkeleton } from "@/components/design/loaders";
import { ToastViewport, useToast } from "@/components/ui/toast";

type RoleRow = {
  value: string;
  rank: number;
  assignable: boolean;
  active_count: number;
};

type Catalog = {
  can_assign_super_admin: boolean;
  roles: RoleRow[];
  fallback_approver_id: string | null;
};

type Candidate = { id: string; name: string; app_role: string };

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  hr: "HR",
  manager: "Manager",
  employee: "Employee",
};

const NONE = "__none__";

export function SuperAdminAccessClient() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string>(NONE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toasts, toast, dismiss } = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch<{ data: Catalog }>("/api/super-admin/access", { signal });
    setCatalog(response.data);
    setSelected(response.data.fallback_approver_id ?? NONE);
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal)
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [load]);

  // The candidate list comes from the admin directory, which already hides the
  // restricted columns from non-privileged callers — so an ordinary employee's
  // name and role can be used to describe them without widening anything.
  useEffect(() => {
    apiFetch<{ data: Candidate[] }>("/api/admin/users")
      .then((r) => setCandidates(r.data))
      .catch(() => {
        /* the selector simply has no options; saving still works */
      });
  }, []);

  const saveFallback = async () => {
    setSaving(true);
    try {
      await apiFetch("/api/super-admin/fallback-approver", {
        method: "PUT",
        body: JSON.stringify({ employee_id: selected === NONE ? null : selected }),
      });
      toast({
        tone: "success",
        title: "Fallback approver saved",
        description:
          selected === NONE
            ? "A Super Admin's own leave is now parked as blocked rather than self-approved."
            : "A Super Admin's own leave will now route to this person.",
      });
      await load();
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not save",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Access & escalation" />
        <ListSkeleton count={2} />
      </div>
    );
  }

  if (error || !catalog) {
    return (
      <div className="space-y-6">
        <PageHeader title="Access & escalation" />
        <ErrorState
          message={error ?? "The access catalog could not be read."}
          onRetry={() => {
            setLoading(true);
            setError(null);
            void load().finally(() => setLoading(false));
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access & escalation"
        description="Who may hold which role, and who signs a Super Admin's own leave."
        actions={<Badge>Super Admin only</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4" aria-hidden />
            Role matrix
          </CardTitle>
          <CardDescription>
            The five tiers, top down. A role you cannot assign is refused by the database, not just
            hidden here — an Admin cannot appoint a Super Admin even by calling the API directly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y overflow-hidden rounded-xl border">
            {catalog.roles.map((role) => (
              <li
                key={role.value}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <span className="font-medium">{ROLE_LABEL[role.value] ?? role.value}</span>
                <Badge variant="outline" className="tabular">
                  rank {role.rank}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {role.active_count} active
                </span>
                <span className="ml-auto">
                  {role.assignable ? (
                    <Badge variant="secondary">You can assign</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      Super Admin only
                    </Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {!catalog.can_assign_super_admin ? (
            <p className="mt-4 flex items-start gap-2 rounded-lg border bg-muted/50 px-3.5 py-2.5 text-sm text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              You cannot assign the Super Admin role. Only an existing Super Admin may appoint
              another one.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fallback approver for Super Admin leave</CardTitle>
          <CardDescription>
            A Super Admin has nobody above them, and nobody may approve their own leave. This names
            the person who signs instead. With nobody set, such a request is parked as blocked —
            it is never self-approved.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1 space-y-1.5">
              <label htmlFor="fallback-approver" className="text-sm font-medium">
                Approver
              </label>
              <Select value={selected} onValueChange={(value) => setSelected(value ?? NONE)}>
                <SelectTrigger id="fallback-approver" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Nobody — park as blocked</SelectItem>
                  {candidates.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name} · {ROLE_LABEL[person.app_role] ?? person.app_role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={saveFallback} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            Current fallback:{" "}
            {catalog.fallback_approver_id
              ? (candidates.find((c) => c.id === catalog.fallback_approver_id)?.name ??
                catalog.fallback_approver_id)
              : "nobody — a Super Admin's leave will be parked as blocked"}
          </p>
        </CardContent>
      </Card>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}