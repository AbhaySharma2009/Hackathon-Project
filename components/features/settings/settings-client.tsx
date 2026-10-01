"use client";

/**
 * Account settings.
 *
 * Read-only by design. A person may look at their own record and sign out, but
 * they cannot change their own role or department from here — self-editing
 * `app_role` is precisely the escalation Phase 15 has to refuse, and
 * `admin_update_employee` refuses it in the database too. Those changes are made
 * by an Admin in `/admin/users`.
 */
import { Building2, CalendarDays, Mail, ShieldCheck, User } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PageHeader } from "@/components/design/page-header";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  hr: "HR",
  manager: "Manager",
  employee: "Employee",
};

export function SettingsClient({
  employee,
}: {
  employee: {
    name: string;
    email: string;
    role: string;
    department: string;
    app_role: string;
    photo: string | null;
    join_date?: string;
  };
}) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Your account and your role in OrgFlow."
        actions={<Badge variant="secondary">{ROLE_LABEL[employee.app_role] ?? employee.app_role}</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="size-4" aria-hidden />
            Profile
          </CardTitle>
          <CardDescription>Who you are in OrgFlow.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar size="lg">
              {employee.photo ? (
                <AvatarImage src={employee.photo} alt="" />
              ) : (
                <AvatarFallback>
                  {employee.name
                    .split(" ")
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join("")
                    .toUpperCase()}
                </AvatarFallback>
              )}
            </Avatar>
            <div>
              <p className="text-lg font-semibold">{employee.name}</p>
              <p className="text-sm text-muted-foreground">{employee.role}</p>
            </div>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            <Field icon={Mail} label="Email" value={employee.email} />
            <Field icon={Building2} label="Department" value={employee.department} />
            <Field icon={CalendarDays} label="Joined" value={employee.join_date ?? "—"} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" aria-hidden />
            Permissions
          </CardTitle>
          <CardDescription>
            Your role decides what you can see. It is set by an administrator and cannot be changed
            by you — that restriction is enforced in the database, not just hidden here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You are signed in as{" "}
            <span className="font-medium text-foreground">
              {ROLE_LABEL[employee.app_role] ?? employee.app_role}
            </span>
            . Your own leave requests, balances and notifications are on{" "}
            <a href="/dashboard" className="font-medium text-primary hover:underline">
              your dashboard
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Mail;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border px-3.5 py-3">
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}