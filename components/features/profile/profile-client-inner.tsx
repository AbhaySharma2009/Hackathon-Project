"use client";

import { useRef, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initials, MAX_PHOTO_BYTES, PHOTO_ACCEPT } from "@/shared/profile-photos";
import type { AppRole } from "@/shared/types";

/**
 * The profile page: the personal fields a person owns, and the organisation
 * fields they do not.
 *
 * The split is the feature. `PERSONAL_FIELDS` is the whole list of things this
 * form can write, and the read-only block below is rendered as text rather than
 * inputs — so there is no input to disable and nothing for the database to
 * reject on the way through. The server enforces the same split independently;
 * see `update_my_profile`.
 */
const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  hr: "HR",
  manager: "Manager",
  employee: "Employee",
};

type Personal = {
  name: string;
  photo: string | null;
  phone: string | null;
  personal_email: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
};

type Organisation = {
  employee_id: string;
  work_email: string;
  app_role: AppRole;
  designation: string;
  department: string;
  manager_name: string | null;
  joining_date: string;
  account_status: string;
};

type Balance = { leave_type: string; allocated: number; used: number; remaining: number };

type Props = {
  personal: Personal;
  organisation: Organisation;
  balances: Balance[];
};

export function ProfileClientInner({ personal, organisation, balances }: Props) {
  const [form, setForm] = useState(personal);
  const [photo, setPhoto] = useState(personal.photo);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = (key: keyof Personal) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          phone: form.phone ?? "",
          personal_email: form.personal_email ?? "",
          address: form.address ?? "",
          emergency_contact_name: form.emergency_contact_name ?? "",
          emergency_contact_phone: form.emergency_contact_phone ?? "",
        }),
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not save your profile.");

      // Take the stored values back from the server rather than trusting the
      // form, so what is shown is what was actually written.
      const saved_ = body?.data?.employee;
      if (saved_) {
        setForm((prev) => ({
          ...prev,
          name: saved_.name ?? prev.name,
          phone: saved_.phone ?? null,
          personal_email: saved_.personal_email ?? null,
          address: saved_.address ?? null,
          emergency_contact_name: saved_.emergency_contact_name ?? null,
          emergency_contact_phone: saved_.emergency_contact_phone ?? null,
        }));
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  async function uploadPhoto(file: File) {
    setPhotoNote(null);

    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoNote("Images must be 2 MB or smaller.");
      return;
    }

    const body = new FormData();
    body.append("file", file);

    try {
      const res = await fetch("/api/profile/photo", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? "Upload failed.");
      // The object path is stable across replacements, so the cache-buster is
      // what forces the browser to fetch the new image.
      setPhoto(`${json.data.photo}?v=${Date.now()}`);
      setPhotoNote("Photo updated.");
    } catch (err) {
      setPhotoNote(err instanceof Error ? err.message : "Upload failed.");
    }
  }

  async function removePhoto() {
    setPhotoNote(null);
    try {
      const res = await fetch("/api/profile/photo", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? "Could not remove the photo.");
      setPhoto(null);
      setPhotoNote("Photo removed.");
    } catch (err) {
      setPhotoNote(err instanceof Error ? err.message : "Could not remove the photo.");
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your contact details are yours to keep current. Everything about your role in the
          organisation is managed by HR.
        </p>
      </div>

      {/* ---- photo ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile photo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="size-16">
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt="" className="size-16 rounded-full object-cover" />
              ) : (
                <AvatarFallback className="text-lg">
                  {initials(form.name || personal.name)}
                </AvatarFallback>
              )}
            </Avatar>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInput.current?.click()}
              >
                {photo ? "Replace photo" : "Upload photo"}
              </Button>

              {photo && (
                <Button type="button" variant="ghost" size="sm" onClick={removePhoto}>
                  Remove
                </Button>
              )}

              <input
                ref={fileInput}
                type="file"
                accept={PHOTO_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadPhoto(file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            PNG, JPEG or WebP, up to {Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB. Without a
            photo your initials are shown instead.
          </p>

          {photoNote && <p className="text-xs text-muted-foreground">{photoNote}</p>}
        </CardContent>
      </Card>

      {/* ---- editable ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Personal details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" htmlFor="name">
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => set("name")(e.target.value)}
                  required
                  minLength={2}
                  maxLength={120}
                />
              </Field>

              <Field label="Phone number" htmlFor="phone">
                <Input
                  id="phone"
                  value={form.phone ?? ""}
                  onChange={(e) => set("phone")(e.target.value)}
                  placeholder="+1 555 0100"
                  maxLength={32}
                />
              </Field>

              <Field
                label="Personal email"
                htmlFor="personal_email"
                hint="Optional. Kept separate from your work address."
              >
                <Input
                  id="personal_email"
                  type="email"
                  value={form.personal_email ?? ""}
                  onChange={(e) => set("personal_email")(e.target.value)}
                  maxLength={254}
                />
              </Field>

              <Field label="Emergency contact name" htmlFor="ecn">
                <Input
                  id="ecn"
                  value={form.emergency_contact_name ?? ""}
                  onChange={(e) => set("emergency_contact_name")(e.target.value)}
                  maxLength={120}
                />
              </Field>

              <Field label="Emergency contact phone" htmlFor="ecp">
                <Input
                  id="ecp"
                  value={form.emergency_contact_phone ?? ""}
                  onChange={(e) => set("emergency_contact_phone")(e.target.value)}
                  maxLength={32}
                />
              </Field>
            </div>

            <Field label="Address" htmlFor="address">
              <Input
                id="address"
                value={form.address ?? ""}
                onChange={(e) => set("address")(e.target.value)}
                maxLength={300}
              />
            </Field>

            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}

            {saved && !error && (
              <p className="text-sm text-muted-foreground" role="status">
                Profile saved.
              </p>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
              {saved && (
                <span className="text-sm text-muted-foreground">Your details are up to date.</span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* ---- read-only ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organisation details</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            These are set by HR and an administrator, and cannot be changed from here.
          </p>

          <dl className="grid gap-4 sm:grid-cols-2">
            <ReadOnly label="Employee ID" value={organisation.employee_id} mono />
            <ReadOnly label="Application role" value={ROLE_LABEL[organisation.app_role]} />
            <ReadOnly label="Department" value={organisation.department} />
            <ReadOnly label="Designation" value={organisation.designation} />
            <ReadOnly label="Work email" value={organisation.work_email} />
            <ReadOnly label="Manager" value={organisation.manager_name ?? "None"} />
            <ReadOnly label="Joining date" value={formatDate(organisation.joining_date)} />
            <ReadOnly label="Account status" value={capitalise(organisation.account_status)} />
          </dl>
        </CardContent>
      </Card>

      {/* ---- balances ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Leave balance</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Balances are worked out from your approved leave and cannot be edited here.
          </p>

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {balances.map((balance) => (
              <ReadOnly
                key={balance.leave_type}
                label={capitalise(balance.leave_type)}
                value={`${balance.remaining} of ${balance.allocated} left`}
              />
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
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
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Rendered as text, not a disabled input.
 *
 * A disabled field still looks like something that could be enabled, and it
 * invites the question of who else could. Plain text makes it clear these are
 * not yours to change.
 */
function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={`text-sm ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}