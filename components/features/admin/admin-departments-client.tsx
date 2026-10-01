"use client";

import { useCallback, useState } from "react";
import { Building2, Plus, Trash2 } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/design/page-header";
import { EmptyState, ErrorState } from "@/components/design/states";
import { ListSkeleton } from "@/components/design/loaders";
import { ToastViewport, useToast } from "@/components/ui/toast";
import { useAdminResource } from "@/components/features/admin/use-admin-resource";

/**
 * The authoritative department list.
 *
 * An employee can only be filed under a department that exists here, so this list
 * is what the department picker in Users & Roles offers. Removal is refused while
 * anybody is still assigned, rather than orphaning them against a name that has
 * stopped resolving.
 */
export function AdminDepartmentsClient() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const { toasts, toast, dismiss } = useToast();

  const fetchDepartments = useCallback(
    () => apiFetch<{ data: string[] }>("/api/admin/departments").then((r) => r.data),
    [],
  );
  const { data: departments, loading, error, reload } = useAdminResource(fetchDepartments);

  const add = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/admin/departments", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      await reload();
      toast({ tone: "success", title: "Department added" });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not add",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (dept: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/admin/departments?name=${encodeURIComponent(dept)}`, {
        method: "DELETE",
      });
      await reload();
      toast({ tone: "success", title: `${dept} removed` });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not remove",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Departments"
        description="The authoritative list that employees are filed under."
      />

      {loading ? (
        <ListSkeleton count={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} retrying={loading} />
      ) : (
        <>
      <Card>
        <CardHeader>
          <CardTitle>Add a department</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="dept-name">Name</Label>
              <Input
                id="dept-name"
                value={name}
                placeholder="e.g. Customer Success"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button onClick={add} disabled={busy || name.trim().length === 0}>
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {(departments ?? []).length} department{(departments ?? []).length === 1 ? "" : "s"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(departments ?? []).length === 0 ? (
            <EmptyState
              icon={Building2}
              title="No departments yet"
              description="Add one above, then employees can be filed under it."
            />
          ) : (
            <ul className="divide-y">
              {(departments ?? []).map((dept) => (
                <li key={dept} className="flex items-center justify-between py-3">
                  <span className="font-medium">{dept}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => remove(dept)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
        </>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
