/**
 * Shared test fixtures.
 *
 * The suites used to hard-code the ids of the original demo seed
 * (`00000000-0000-4000-8000-...`). That seed has been replaced, so those
 * constants now point at people who do not exist and every suite that touches
 * them fails for reasons that have nothing to do with what it is testing.
 *
 * People are therefore resolved by email at run time. If the demo dataset is
 * reseeded the tests follow it, rather than needing a hand-edited id in nine
 * files.
 */
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

export const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const PASSWORD = "OrgFlow@2026";

export const CURRENT_YEAR = new Date().getFullYear();

/** Demo accounts, by email. */
export const PEOPLE = {
  admin: "meera.krishnan@orgflow.dev",
  ceo: "aditya.rao@orgflow.dev",
  engManager: "sanjay.kapoor@orgflow.dev",
  salesManager: "vikram.sethi@orgflow.dev",
  hr: "rohan.iyer@orgflow.dev",
  neha: "neha.gupta@orgflow.dev",
  priya: "priya.nair@orgflow.dev",
} as const;

export type PeopleKey = keyof typeof PEOPLE;

/** Ids resolved once per test process and reused. */
const cache = new Map<string, string>();

/**
 * Resolves a demo person's employee id from their email, failing loudly when the
 * dataset is missing them — a silent `undefined` id produces baffling downstream
 * errors instead of a clear message.
 */
export async function employeeId(email: string): Promise<string> {
  const hit = cache.get(email);
  if (hit) return hit;

  const db = createAdminClient();
  const { data, error } = await db
    .from("employees")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error(
      `No employee with email ${email}. Run \`npm run db:seed\` before the test suite.`,
    );
  }

  cache.set(email, data.id);
  return data.id;
}

/** Resolves several people at once, keyed by their role in the fixture. */
export async function employeeIds(
  keys: readonly PeopleKey[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(keys.map(async (k) => [k, await employeeId(PEOPLE[k])] as const));
  return Object.fromEntries(entries);
}

/** Signs in as a demo person with the shared demo password. */
export async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

export { createAdminClient };

/**
 * Removes fixture rows a killed run left behind.
 *
 * Approving spends a balance permanently, so a suite that crashes can leave both
 * a stray request and drifted `leave_balances`. Tests call this before working so
 * a re-run starts from the seeded numbers rather than passing for the wrong
 * reason.
 */
export async function purgeRequestsFor(employeeId: string): Promise<void> {
  const db = createAdminClient();
  await db.from("leave_requests").delete().eq("employee_id", employeeId);
}

/** Puts one leave balance back to an explicit allocation. */
export async function resetBalance(
  employeeId: string,
  leaveType: string,
  allocated: number,
  used = 0,
): Promise<void> {
  const db = createAdminClient();
  const { error } = await db
    .from("leave_balances")
    .update({ allocated, used })
    .eq("employee_id", employeeId)
    .eq("year", CURRENT_YEAR)
    .eq("leave_type", leaveType);
  if (error) throw error;
}

/** Reads the `used` figure for one leave balance. */
export async function usedDays(
  admin: SupabaseClient,
  employeeId: string,
  leaveType: string,
): Promise<number> {
  const { data, error } = await admin
    .from("leave_balances")
    .select("used")
    .eq("employee_id", employeeId)
    .eq("year", CURRENT_YEAR)
    .eq("leave_type", leaveType)
    .single();
  if (error) throw error;
  return Number(data?.used ?? 0);
}

/**
 * The seeded allocation for a person and leave type.
 *
 * Tests that need to assert against a number read it from here instead of
 * hard-coding it, so the value tracks `scripts/seed-demo-data.ts`.
 */
export function seededAllocation(email: string, leaveType: string): number {
  const allocations: Record<string, Record<string, number>> = {
    [PEOPLE.admin]: { casual: 12, sick: 10, annual: 22, unpaid: 0 },
    [PEOPLE.ceo]: { casual: 10, sick: 10, annual: 25, unpaid: 0 },
    [PEOPLE.engManager]: { casual: 12, sick: 10, annual: 22, unpaid: 0 },
    [PEOPLE.salesManager]: { casual: 12, sick: 10, annual: 20, unpaid: 0 },
    [PEOPLE.hr]: { casual: 12, sick: 10, annual: 20, unpaid: 0 },
    [PEOPLE.neha]: { casual: 12, sick: 10, annual: 20, unpaid: 0 },
    [PEOPLE.priya]: { casual: 12, sick: 8, annual: 18, unpaid: 0 },
  };
  const row = allocations[email];
  if (!row) throw new Error(`No seeded allocation known for ${email}`);
  const value = row[leaveType];
  if (value === undefined) throw new Error(`No seeded ${leaveType} allocation for ${email}`);
  return value;
}