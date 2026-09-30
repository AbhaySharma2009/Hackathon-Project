"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
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
import { InlineError } from "@/components/design/states";

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

const SELECT_CLASS =
  "h-9 w-full appearance-none rounded-lg border border-input bg-background pr-9 pl-3 text-sm shadow-xs transition-colors duration-150 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25";

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
  const baseId = useId();
  const [form, setForm] = useState<FormState>(() => toFormState(employee));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const managerOptions = useMemo(
    () => managers.filter((m) => m.id !== selfId),
    [managers, selfId],
  );

  function fieldId(key: string) {
    return `${baseId}-${key}`;
  }

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

        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            id={fieldId("name")}
            label="Full name"
            error={fieldErrors.name}
            className="sm:col-span-2"
          >
            <Input
              id={fieldId("name")}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Aparna Iyer"
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? fieldId("name-error") : undefined}
            />
          </Field>

          <Field id={fieldId("email")} label="Work email" error={fieldErrors.email}>
            <Input
              id={fieldId("email")}
              type="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              placeholder="aparna.iyer@orgflow.dev"
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? fieldId("email-error") : undefined}
            />
          </Field>

          <Field id={fieldId("role")} label="Designation" error={fieldErrors.role}>
            <Input
              id={fieldId("role")}
              value={form.role}
              onChange={(e) => update("role", e.target.value)}
              placeholder="Software Engineer"
              aria-invalid={Boolean(fieldErrors.role)}
              aria-describedby={fieldErrors.role ? fieldId("role-error") : undefined}
            />
          </Field>

          <Field
            id={fieldId("department")}
            label="Department"
            error={fieldErrors.department}
          >
            <Input
              id={fieldId("department")}
              list="of-departments"
              value={form.department}
              onChange={(e) => update("department", e.target.value)}
              placeholder="Engineering"
              aria-invalid={Boolean(fieldErrors.department)}
              aria-describedby={
                fieldErrors.department ? fieldId("department-error") : undefined
              }
            />
            <datalist id="of-departments">
              {departments.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>

          <Field id={fieldId("manager_id")} label="Manager" error={fieldErrors.manager_id}>
            <div className="relative">
              <select
                id={fieldId("manager_id")}
                className={SELECT_CLASS}
                value={form.manager_id}
                onChange={(e) => update("manager_id", e.target.value)}
                aria-invalid={Boolean(fieldErrors.manager_id)}
                aria-describedby={
                  fieldErrors.manager_id ? fieldId("manager_id-error") : undefined
                }
              >
                <option value="">No manager (top of the org)</option>
                {managerOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
            </div>
          </Field>

          <Field id={fieldId("join_date")} label="Join date" error={fieldErrors.join_date}>
            <Input
              id={fieldId("join_date")}
              type="date"
              value={form.join_date}
              onChange={(e) => update("join_date", e.target.value)}
              aria-invalid={Boolean(fieldErrors.join_date)}
              aria-describedby={
                fieldErrors.join_date ? fieldId("join_date-error") : undefined
              }
            />
          </Field>

          <Field
            id={fieldId("photo")}
            label="Avatar URL"
            error={fieldErrors.photo}
            className="sm:col-span-2"
          >
            <Textarea
              id={fieldId("photo")}
              rows={2}
              value={form.photo}
              onChange={(e) => update("photo", e.target.value)}
              placeholder="https://i.pravatar.cc/300?img=12"
              aria-invalid={Boolean(fieldErrors.photo)}
              aria-describedby={fieldErrors.photo ? fieldId("photo-error") : undefined}
            />
          </Field>

          {error ? <InlineError message={error} className="sm:col-span-2" /> : null}

          <DialogFooter className="sm:col-span-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {employee ? "Save changes" : "Add employee"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
