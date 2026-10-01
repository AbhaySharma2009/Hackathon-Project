"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/server/supabase/server";
import { canRoleVisit, homeForRole } from "@/shared/nav";
import type { AppRole } from "@/shared/types";

export type AuthFormState = { error: string | null };

const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

/** Only same-origin relative paths are allowed, so `?next=` can't be an open redirect. */
function safeRedirect(target: FormDataEntryValue | null): string | null {
  const value = typeof target === "string" ? target : "";
  return value.startsWith("/") && !value.startsWith("//") ? value : null;
}

/**
 * Signs in with Supabase Auth. Runs on the server so the session cookie is
 * written by the same response that renders the post-login page.
 *
 * The landing page is chosen from the role stored in the database, never from
 * anything the form supplied. A `?next=` is honoured only when the signed-in
 * role may actually visit that path, so a hand-edited link cannot drop somebody
 * into a portal above their own tier.
 */
export async function signIn(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid credentials." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) return { error: error.message };

  // Read the role back from the database rather than trusting the form, so a
  // crafted field cannot choose the destination.
  const {
    data: employee,
    error: roleError,
  } = await supabase.rpc("current_employee").maybeSingle();

  if (roleError) {
    return { error: "Signed in, but your employee record could not be loaded." };
  }

  const role = (employee as { app_role?: AppRole } | null)?.app_role;
  const home = role ? homeForRole(role) : "/dashboard";
  const requested = safeRedirect(formData.get("next"));

  redirect(requested && role && canRoleVisit(role, requested) ? requested : home);
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
