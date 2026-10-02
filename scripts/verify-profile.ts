/**
 * Phase 16 verification — controlled profile management.
 *
 * The other verifiers cover leave, approvals and the role ladder. This one covers
 * the profile split specifically:
 *
 *   - each of the five roles can edit its own permitted personal details
 *   - organisation-controlled fields cannot be edited through /api/profile
 *   - the same is true when the database functions are called directly, which is
 *     what a UI-only check would miss
 *   - nobody can change their own role, manager, department or employee id
 *   - direct table writes are refused outright
 *   - HR / Admin / Super Admin can manage someone else's profile, within limits
 *   - avatars upload, replace and remove, and non-images are rejected
 *   - a saved change shows up everywhere the person is rendered
 *
 * Run with `npm run verify:profile` while `next dev` is up.
 */
import { config } from "dotenv";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "../server/supabase/admin-core";
import { PHOTO_BUCKET } from "../shared/profile-photos";
import type { AppRole } from "../shared/types";

config({ path: ".env.local" });

const APP = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "OrgFlow@2026";

const SUPER_ADMIN = "ananya.iyer@orgflow.dev";
const ADMIN = "meera.krishnan@orgflow.dev";
const HR = "rohan.iyer@orgflow.dev";
const MANAGER = "sanjay.kapoor@orgflow.dev";
const EMPLOYEE = "neha.gupta@orgflow.dev";

/**
 * The canonical demo roster.
 *
 * Name and role are pinned here rather than snapshotted, because they are
 * identity, not state. An earlier version snapshotted them, and when a run died
 * before its cleanup the next run faithfully "restored" the corrupted values and
 * left five accounts named "Escalation Attempt". Contact details are genuinely
 * dynamic and stay a snapshot; these two are reasserted from the roster.
 */
const ROSTER: Record<string, { name: string; app_role: AppRole }> = {
  "ananya.iyer@orgflow.dev": { name: "Ananya Iyer", app_role: "super_admin" },
  "meera.krishnan@orgflow.dev": { name: "Meera Krishnan", app_role: "admin" },
  "rohan.iyer@orgflow.dev": { name: "Rohan Iyer", app_role: "hr" },
  "sanjay.kapoor@orgflow.dev": { name: "Sanjay Kapoor", app_role: "manager" },
  "aditya.rao@orgflow.dev": { name: "Aditya Rao", app_role: "manager" },
  "vikram.sethi@orgflow.dev": { name: "Vikram Sethi", app_role: "manager" },
  "neha.gupta@orgflow.dev": { name: "Neha Gupta", app_role: "employee" },
  "priya.nair@orgflow.dev": { name: "Priya Nair", app_role: "employee" },
};

/**
 * The contact fields this suite writes, cleared on the way out.
 *
 * Restored to a fixed baseline rather than to a snapshot. A snapshot records
 * whatever was there when the run started, so a run that followed a crashed one
 * would faithfully restore the previous run's leftovers — which is how two phone
 * numbers crept into the demo data and stayed there.
 */
const RESET_CONTACT = {
  phone: null,
  personal_email: null,
  address: null,
  emergency_contact_name: null,
  emergency_contact_phone: null,
} as const;

/** Every role, so "all roles can edit their own details" is actually tested. */
const ROLES = [
  ["super admin", SUPER_ADMIN],
  ["admin", ADMIN],
  ["hr", HR],
  ["manager", MANAGER],
  ["employee", EMPLOYEE],
] as const;

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function session(email: string) {
  const store = new Map<string, string>();
  const ssr = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...store].map(([name, value]) => ({ name, value })),
        setAll: (list) => {
          for (const { name, value, options } of list) {
            if (options?.maxAge === 0) store.delete(name);
            else store.set(name, value);
          }
        },
      },
    },
  );

  const { error } = await ssr.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);

  const cookie = () => [...store].map(([n, v]) => `${n}=${v}`).join("; ");
  return { cookie, client: ssr };
}

/** A genuine 1x1 PNG, so the upload path sees real image bytes. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c636000000200010005fe02fea7b1a1a4" +
    "0000000049454e44ae426082",
  "hex",
);

/**
 * Values written into a person's own row, restored at the end.
 *
 * The suite proves people can edit themselves, which means it dirties their
 * record. Snapshotting keeps a run from leaving the demo dataset changed, so a
 * second run starts from the same state as the first.
 */
const snapshot = new Map<string, Record<string, string | null>>();

async function main() {
  const db = createAdminClient();

  const { data: staff } = await db
    .from("employees")
    .select("id, email, name")
    .eq("is_active", true);

  const idFor = (email: string) =>
    (staff ?? []).find((e) => e.email === email)?.id ?? null;

  console.log("\nevery role can reach the profile page\n");

  for (const [role, email] of ROLES) {
    const { cookie } = await session(email);
    const res = await fetch(`${APP}/settings`, {
      headers: { cookie: cookie() },
      redirect: "manual",
    });
    const html = res.status === 200 ? await res.text() : "";

    check(`${role} opens the profile page`, res.status === 200, `got ${res.status}`);
    check(`${role} sees the editable personal section`, html.includes("Personal details"));
    check(`${role} sees the read-only organisation section`, html.includes("Organisation details"));
  }

  console.log("\nevery role can edit its own permitted details\n");

  for (const [role, email] of ROLES) {
    const id = idFor(email);
    if (!id) {
      check(`${role} exists in the directory`, false);
      continue;
    }

    // Name and role are snapshotted as well. The escalation checks below write
    // both, so restoring only the contact fields would leave five demo accounts
    // renamed — which is exactly what the first run of this file did.
    const { data: before } = await db
      .from("employees")
      .select("phone, address, emergency_contact_name, personal_email, name, app_role")
      .eq("id", id)
      .single();

    snapshot.set(id, before as Record<string, string | null>);

    const { cookie } = await session(email);
    const marker = `+1 555 ${String(1000 + ROLES.findIndex((r) => r[1] === email)).slice(-4)}`;

    const res = await fetch(`${APP}/api/profile`, {
      method: "PUT",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({
        phone: marker,
        address: "1 Phase 16 Way",
        emergency_contact_name: "Phase 16 Contact",
        emergency_contact_phone: "+1 555 0900",
        personal_email: `${email.split("@")[0]}.personal@orgflow.dev`,
      }),
    });

    check(`${role} saves its own personal details`, res.status === 200, `got ${res.status}`);

    const { data: after } = await db
      .from("employees")
      .select("phone, address")
      .eq("id", id)
      .single();

    check(
      `${role}'s phone was actually written`,
      (after as { phone?: string | null })?.phone === marker,
      `stored ${(after as { phone?: string | null })?.phone}`,
    );
  }

  console.log("\norganisation-controlled fields are refused by /api/profile\n");

  const PROTECTED = [
    "app_role",
    "department",
    "manager_id",
    "employee_id",
    "join_date",
    "is_active",
    "email",
    "id",
  ] as const;

  for (const field of PROTECTED) {
    const { cookie } = await session(EMPLOYEE);
    const res = await fetch(`${APP}/api/profile`, {
      method: "PUT",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ [field]: "00000000-0000-4000-8000-000000000001" }),
    });
    const body = await res.json();
    check(
      `PUT ${field} is refused`,
      res.status === 422 && /managed by HR/i.test(body?.error?.message ?? ""),
      `got ${res.status} ${JSON.stringify(body?.error?.message ?? "").slice(0, 50)}`,
    );
  }

  console.log("\nno role can escalate itself, whatever the tier\n");

  for (const [role, email] of ROLES) {
    const id = idFor(email);

    const { client } = await session(email);

    // Straight at the RPC, bypassing the route entirely.
    const { error } = await client.rpc("update_my_profile", {
      p_name: "Escalation Attempt",
    } as never);
    check(`${role} can still change its own name`, !error, error?.message ?? "");

    for (const field of ["p_app_role", "p_department", "p_manager_id"] as const) {
      // The role target has to be one the caller does not already hold: a Super
      // Admin asking for `super_admin` is asking for what they have, which is a
      // no-op and correctly not an error.
      const roleTarget = role === "super admin" ? "employee" : "super_admin";
      const { error: bad } = await client.rpc("admin_update_employee_profile", {
        p_actor: id,
        p_employee_id: id,
        ...(field === "p_app_role" ? { p_app_role: roleTarget } : {}),
        ...(field === "p_department" ? { p_department: "Executive" } : {}),
        ...(field === "p_manager_id" ? { p_manager_id: "00000000-0000-4000-8000-000000000001" } : {}),
      } as never);
      check(
        `${role} cannot change its own ${field.replace("p_", "")}`,
        Boolean(bad),
        bad ? "" : "the call succeeded",
      );
    }

    // A direct table write is the path a browser would use to bypass the RPCs.
    const { error: direct } = await client
      .from("employees")
      .update({ app_role: "super_admin" })
      .eq("id", id!);
    check(
      `${role} cannot UPDATE the employees table directly`,
      Boolean(direct),
      direct ? "" : "the write succeeded",
    );

    // The name change above was expected, so what matters is that the *role*
    // never moved.
    const { data: still } = await db
      .from("employees")
      .select("app_role")
      .eq("id", id!)
      .single();
    check(
      `${role}'s role is unchanged`,
      (still as { app_role?: string })?.app_role === (snapshot.get(id!)?.app_role as string),
      `now ${(still as { app_role?: string })?.app_role}`,
    );
  }

  console.log("\nHR, Admin and Super Admin manage other people's profiles\n");

  const employeeId = idFor(EMPLOYEE);

  {
    const { client } = await session(HR);
    const { error } = await client.rpc("admin_update_employee_profile", {
      p_actor: idFor(HR),
      p_employee_id: employeeId,
      p_phone: "+1 555 0777",
    });
    check("HR can edit an employee's phone", !error, error?.message ?? "");

    const { data } = await db
      .from("employees")
      .select("phone")
      .eq("id", employeeId!)
      .single();
    check(
      "HR's edit was stored",
      (data as { phone?: string | null })?.phone === "+1 555 0777",
      `stored ${(data as { phone?: string | null })?.phone}`,
    );
  }

  {
    const { client } = await session(HR);
    const { error } = await client.rpc("admin_update_employee_profile", {
      p_actor: idFor(HR),
      p_employee_id: idFor(ADMIN),
      p_phone: "+1 555 0000",
    });
    check("HR cannot edit an Admin", Boolean(error), error ? "" : "the call succeeded");
  }

  {
    // HR ranks above Manager, so managing one is legitimate. The ceiling is the
    // Admin tier, which the two checks above already cover.
    const { client } = await session(HR);
    const { error } = await client.rpc("admin_update_employee_profile", {
      p_actor: idFor(HR),
      p_employee_id: idFor(MANAGER),
      p_phone: "+1 555 0000",
    });
    check("HR can edit a Manager, who ranks below HR", !error, error?.message ?? "");
  }

  {
    const { client } = await session(HR);
    const { error } = await client.rpc("admin_update_employee_profile", {
      p_actor: idFor(HR),
      p_employee_id: idFor(SUPER_ADMIN),
      p_phone: "+1 555 0000",
    });
    check("HR cannot edit a Super Admin", Boolean(error), error ? "" : "the call succeeded");
  }

  {
    const { client } = await session(MANAGER);
    const { error } = await client.rpc("admin_update_employee_profile", {
      p_actor: idFor(MANAGER),
      p_employee_id: idFor(EMPLOYEE),
      p_phone: "+1 555 0000",
    });
    check("a Manager cannot manage profiles", Boolean(error), error ? "" : "the call succeeded");
  }

  {
    const { client } = await session(ADMIN);
    const { error } = await client.rpc("admin_update_employee_profile", {
      p_actor: idFor(ADMIN),
      p_employee_id: idFor(SUPER_ADMIN),
      p_app_role: "employee",
    });
    check(
      "an Admin cannot demote a Super Admin",
      Boolean(error),
      error ? "" : "the call succeeded",
    );
  }

  console.log("\nprofile photos\n");

  {
    const { cookie } = await session(EMPLOYEE);

    const upload = new FormData();
    upload.append("file", new File([PNG], "avatar.png", { type: "image/png" }));
    const up = await fetch(`${APP}/api/profile/photo`, {
      method: "POST",
      headers: { cookie: cookie() },
      body: upload,
    });
    const upBody = await up.json();
    const url = upBody?.data?.photo as string | undefined;
    check("a PNG avatar uploads", up.status === 200 && Boolean(url), `got ${up.status}`);
    check("the stored URL is in the profile-photos bucket", Boolean(url?.includes(PHOTO_BUCKET)));

    if (url) {
      const head = await fetch(url);
      check("the stored avatar is publicly readable", head.ok, `got ${head.status}`);
    }

    // Replacing: the same path written again, which is what "replace" means.
    const replace = new FormData();
    replace.append("file", new File([PNG], "other.png", { type: "image/png" }));
    const re = await fetch(`${APP}/api/profile/photo`, {
      method: "POST",
      headers: { cookie: cookie() },
      body: replace,
    });
    check("an avatar can be replaced", re.status === 200, `got ${re.status}`);

    const profile = await (await fetch(`${APP}/api/profile`, { headers: { cookie: cookie() } })).json();
    check(
      "the profile shows the avatar after upload",
      Boolean(profile?.data?.personal?.photo),
    );
  }

  {
    const { cookie } = await session(EMPLOYEE);

    const fake = new FormData();
    fake.append(
      "file",
      new File([Buffer.from("not an image at all")], "evil.png", { type: "image/png" }),
    );
    const res = await fetch(`${APP}/api/profile/photo`, {
      method: "POST",
      headers: { cookie: cookie() },
      body: fake,
    });
    check("a text file named .png is rejected", res.status === 422, `got ${res.status}`);
  }

  {
    const { cookie } = await session(EMPLOYEE);

    const huge = new FormData();
    huge.append("file", new File([Buffer.alloc(3 * 1024 * 1024)], "big.png", { type: "image/png" }));
    const res = await fetch(`${APP}/api/profile/photo`, {
      method: "POST",
      headers: { cookie: cookie() },
      body: huge,
    });
    check("an oversized image is rejected", res.status === 422, `got ${res.status}`);
  }

  {
    const { cookie } = await session(EMPLOYEE);
    const res = await fetch(`${APP}/api/profile/photo`, { method: "DELETE", headers: { cookie: cookie() } });
    const body = await res.json();
    check("an avatar can be removed", res.status === 200 && body?.data?.photo === null);

    const { data } = await db.from("employees").select("photo").eq("id", employeeId!).single();
    check("the avatar column is cleared", (data as { photo?: string | null })?.photo === null);
  }

  {
    // Someone else's folder must not be writable, which is what stops a person
    // overwriting a colleague's avatar by guessing a path.
    const { client } = await session(EMPLOYEE);
    const target = `${idFor(ADMIN)}/avatar.png`;
    const { error } = await client.storage
      .from(PHOTO_BUCKET)
      .upload(target, PNG, { contentType: "image/png", upsert: true });
    check("an employee cannot write to another person's avatar folder", Boolean(error));
  }

  console.log("\na saved change shows up across the app\n");

  {
    const id = employeeId!;
    const { cookie } = await session(HR);
    const marker = "Priya Nair-Tested";

    await fetch(`${APP}/api/employees/${id}`, {
      method: "PATCH",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ name: marker }),
    });

    const { cookie: hrCookie } = await session(HR);
    const directory = await (
      await fetch(`${APP}/api/employees`, { headers: { cookie: hrCookie() } })
    ).json();
    const rows = (directory?.data ?? []) as { id: string; name: string }[];
    check(
      "the new name appears in the directory",
      rows.find((r) => r.id === id)?.name === marker,
      `directory shows ${rows.find((r) => r.id === id)?.name}`,
    );

    const { cookie: empCookie } = await session(EMPLOYEE);
    const own = await (
      await fetch(`${APP}/api/profile`, { headers: { cookie: empCookie() } })
    ).json();
    check("the new name appears on the profile", own?.data?.personal?.name === marker);
  }

  console.log("\ncleanup\n");

  // Reassert identity from the roster and clear the contact fields this file
  // wrote. Both are fixed baselines, so the result does not depend on what the
  // run found when it started.
  for (const [email, person] of Object.entries(ROSTER)) {
    const { error } = await db
      .from("employees")
      .update({ ...RESET_CONTACT, name: person.name, app_role: person.app_role })
      .eq("email", email);
    if (error) console.error(`  could not reset ${email}: ${error.message}`);
  }

  const { data: cleaned } = await db
    .from("employees")
    .select("email, name, app_role, address")
    .eq("id", employeeId!);
  check(
    "the demo personal details are restored",
    (cleaned?.[0] as { address?: string | null })?.address !== "1 Phase 16 Way",
  );

  const { data: renamed } = await db
    .from("employees")
    .select("email, name")
    .eq("name", "Escalation Attempt");
  check(
    "no demo account was left renamed",
    (renamed ?? []).length === 0,
    (renamed ?? []).map((r) => (r as { email: string }).email).join(", "),
  );

  const { data: roles } = await db
    .from("employees")
    .select("email, app_role")
    .eq("email", SUPER_ADMIN);
  check(
    "the Super Admin kept her role",
    (roles?.[0] as { app_role?: string })?.app_role === "super_admin",
    `now ${(roles?.[0] as { app_role?: string })?.app_role}`,
  );

  await db.storage.from(PHOTO_BUCKET).remove([`${employeeId}/avatar.png`]);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();