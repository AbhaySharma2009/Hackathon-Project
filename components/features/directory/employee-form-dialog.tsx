"use client";

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiFetch, ClientApiError } from "@/shared/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type ManagerOption = { id: string; name: string };

type FormState = {
  name: string;
  email: string;
  role: string;
  department: string;
  manager_id: string;
  join_date: string;
  photo: string;
};

const EMPTY: FormState = {
  name: "",
  email: "",
  role: "",
  department: "",
  manager_id: "",
  join_date: new Date().toISOString().slice(0, 10),
  photo: "",
};

export type EditableEmployee = {
  id: string;
  name: string;
  email?: string;
  role: string;
  department: string;
  manager_id: string | null;
  join_date: string;
  photo: string | null;
};

function toFormState(employee: EditableEmployee | null): FormState {
  if (!employee) return EMPTY;
  return {
    name: employee.name,
    email: employee.email ?? "",
    role: employee.role,
    department: employee.department,
    manager_id: employee.manager_id ?? "",
    join_date: employee.join_date,
    photo: employee.photo ?? "",
  };
}

/**
 * The parent remounts this with a `key` whenever the target changes, so the form
 * state initialises from props instead of being resynchronised in an effect.
 */
export function EmployeeFormDialog({
  open,
  onOpenChange,
  /** null = create mode, an employee = edit mode. */
  employee,
  departments,
  managers,
  /** The signed-in employee, excluded from the manager list on edit. */
  selfId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EditableEmployee | null;
  departments: string[];
  managers: ManagerOption[];
  selfId?: string;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toFormState(employee));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const managerOptions = useMemo(
    () => managers.filter((m) => m.id !== selfId),
    [managers, selfId],
  );

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const payload = {
        name: form.name,
        email: form.email,
        role: form.role,
        department: form.department,
        manager_id: form.manager_id || null,
        join_date: form.join_date,
        photo: form.photo || null,
      };

      await apiFetch(employee ? `/api/employees/${employee.id}` : "/api/employees", {
        method: employee ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });

      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ClientApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors());
      } else {
        setError("Could not save the employee.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{employee ? "Edit employee" : "Add employee"}</DialogTitle>
          <DialogDescription>
            {employee
              ? "Update the record. Changing the manager updates the org chart."
              : "Create a new employee record. They can sign in once an auth account is linked."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" error={fieldErrors.name} className="sm:col-span-2">
            <Input
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Aparna Iyer"
            />
          </Field>

          <Field label="Work email" error={fieldErrors.email}>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              placeholder="aparna.iyer@orgflow.dev"
            />
          </Field>

          <Field label="Designation" error={fieldErrors.role}>
            <Input
              value={form.role}
              onChange={(e) => update("role", e.target.value)}
              placeholder="Software Engineer"
            />
          </Field>

          <Field label="Department" error={fieldErrors.department}>
            <Input
              list="of-departments"
              value={form.department}
              onChange={(e) => update("department", e.target.value)}
              placeholder="Engineering"
            />
            <datalist id="of-departments">
              {departments.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>

          <Field label="Manager" error={fieldErrors.manager_id}>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.manager_id}
              onChange={(e) => update("manager_id", e.target.value)}
            >
              <option value="">No manager (top of the org)</option>
              {managerOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Join date" error={fieldErrors.join_date}>
            <Input
              type="date"
              value={form.join_date}
              onChange={(e) => update("join_date", e.target.value)}
            />
          </Field>

          <Field label="Avatar URL" error={fieldErrors.photo} className="sm:col-span-2">
            <Textarea
              rows={2}
              value={form.photo}
              onChange={(e) => update("photo", e.target.value)}
              placeholder="https://i.pravatar.cc/300?img=12"
            />
          </Field>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {employee ? "Save changes" : "Add employee"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  error,
  className,
  children,
}: {
  label: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
