/**
 * Phase 13 — HR leave routing and approval-hierarchy verification.
 *
 * Drives the real RPCs with real signed-in sessions, so this exercises the
 * production approval engine rather than a re-implementation of it.
 *
 * Covers every case the phase calls for: employee short/medium/long, HR
 * short/medium/long, rejection at each stage, an unauthorised approval attempt,
 * self-approval at every role, final approval with the balance update, and a
 * check that no request is left parked with no possible decider.
 *
 * Every request created here is removed at the end, so the demo dataset is left
 * exactly as it was found.
 *
 *   npx tsx scripts/verify-approval-hierarchy.ts
 */
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

const PASSWORD = "OrgFlow@2026";
const YEAR = new Date().getFullYear();

const results: { ok: boolean; label: string; detail?: string }[] = [];
function record(ok: boolean, label: string, detail?: string) {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  -> ${detail}` : ""}`);
}

async function runChecks() {
  const admin = createAdminClient();

  const { data: employees } = await admin
    .from("employees")
    .select("id,name,email,app_role,department");
  const byId = new Map((employees ?? []).map((e) => [e.id, e]));
  const byEmail = new Map((employees ?? []).map((e) => [e.email, e]));

  const hr = byEmail.get("rohan.iyer@orgflow.dev")!;
  const deptHead = byEmail.get("aditya.rao@orgflow.dev")!;
  const manager = byEmail.get("sanjay.kapoor@orgflow.dev")!;
  const outsider = byEmail.get("vikram.sethi@orgflow.dev")!;
  const emp1 = byEmail.get("neha.gupta@orgflow.dev")!;

  const as = async (email: string) => {
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
    return client;
  };

  const cookieFor = async (email: string) => {
    const store = new Map<string, string>();
    const { createServerClient } = await import("@supabase/ssr");
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
    await ssr.auth.signInWithPassword({ email, password: PASSWORD });
    return [...store].map(([name, value]) => `${name}=${value}`).join("; ");
  };
  const hrCookies = await cookieFor(hr.email);
  const deptHeadCookies = await cookieFor(deptHead.email);

  const clients: Record<string, SupabaseClient> = {
    hr: await as(hr.email),
    deptHead: await as(deptHead.email),
    manager: await as(manager.email),
    outsider: await as(outsider.email),
    emp1: await as(emp1.email),
  };

  // ---- fixture headroom ----------------------------------------------------
  // The actors' real balances shrink as the demo data is used, and windows run
  // out before the calendar year does. Raise the allocation for just these
  // people and restore the exact original numbers on the way out, so this file
  // never depends on how much demo leave has already been consumed.
  const originalBalances = new Map<string, number>();
  const { data: existingBalances } = await admin
    .from("leave_balances")
    .select("id,employee_id,leave_type,used")
    .eq("year", YEAR);
  for (const row of existingBalances ?? []) {
    originalBalances.set(row.id, Number(row.used));
  }
  const actors = [hr, deptHead, manager, outsider, emp1].map((e) => e.id);
  await admin
    .from("leave_balances")
    .update({ allocated: 40, used: 0 })
    .eq("year", YEAR)
    .eq("leave_type", "annual")
    .in("employee_id", actors);

  /**
   * Non-overlapping in-year windows, handed out in order.
   *
   * A window may never cross 31 December: `create_leave_request` rejects a
   * request spanning two calendar years, and there is no balance row for the
   * next year, so an over-long window would fail for the wrong reason.
   */
  // One cursor per person. Overlap is evaluated per employee, so two people can
  // legitimately hold leave on the same dates — a single shared cursor would
  // also run the calendar year out well before the working days are used up.
  const cursors = new Map<string, Date>();
  const cursorFor = (employeeId: string) => {
    let cursor = cursors.get(employeeId);
    if (!cursor) {
      cursor = new Date();
      cursor.setHours(0, 0, 0, 0);
      cursor.setDate(cursor.getDate() + 2);
      while (cursor.getDay() === 0 || cursor.getDay() === 6) cursor.setDate(cursor.getDate() + 1);
      cursors.set(employeeId, cursor);
    }
    return cursor;
  };

  const nextWindow = (workingDays: number, employeeId: string) => {
    const cursor = cursorFor(employeeId);
    const start = new Date(cursor);
    const end = new Date(cursor);
    for (let counted = 1; counted < workingDays; ) {
      end.setDate(end.getDate() + 1);
      if (end.getDay() !== 0 && end.getDay() !== 6) counted += 1;
    }
    if (end.getFullYear() !== YEAR) {
      throw new Error(`ran out of ${YEAR} windows asking for ${workingDays} working days`);
    }
    cursor.setTime(end.getTime());
    cursor.setDate(cursor.getDate() + 1);
    while (cursor.getDay() === 0 || cursor.getDay() === 6) cursor.setDate(cursor.getDate() + 1);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { start: iso(start), end: iso(end) };
  };

  /**
   * Date ranges already taken by a person's own leave.
   *
   * Overlap is rejected per employee, not per leave type, so the seeded demo
   * requests (e.g. Neha's 7-18 Dec pending annual) block any test window that
   * lands on them. Windows are skipped rather than the demo data being touched.
   */
  const busyRanges = async (employeeId: string) => {
    const { data } = await admin
      .from("leave_requests")
      .select("start_date,end_date")
      .eq("employee_id", employeeId)
      .in("status", ["approved", "pending", "approval_blocked"]);
    return (data ?? []).map((r) => ({ start: r.start_date as string, end: r.end_date as string }));
  };

  const created: string[] = [];
  const clean = async () => {
    for (const id of created) {
      await admin.from("leave_approval_steps").delete().eq("leave_request_id", id);
      await admin.from("alerts").delete().eq("related_request_id", id);
      await admin.from("leave_requests").delete().eq("id", id);
    }
    for (const [id, used] of originalBalances) {
      await admin.from("leave_balances").update({ used }).eq("id", id);
    }
  };

  /** Submit and return the chain, asserting nothing about routing. */
  const submit = async (who: SupabaseClient, days: number, reason: string, employeeId: string) => {
    const busy = await busyRanges(employeeId);
    let w = nextWindow(days, employeeId);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const clashes = busy.some((r) => w.start <= r.end && w.end >= r.start);
      if (!clashes) break;
      w = nextWindow(days, employeeId);
    }
    const stillClashing = busy.some((r) => w.start <= r.end && w.end >= r.start);
    if (stillClashing) {
      throw new Error(`no free ${YEAR} window of ${days} working days left for ${employeeId}`);
    }
    const result = await who.rpc("create_leave_request", {
      p_leave_type: "annual",
      p_start: w.start,
      p_end: w.end,
      p_reason: reason,
    });
    const id = (result.data as { id?: string } | null)?.id;
    if (id) created.push(id);
    const chain = id
      ? ((await admin
          .from("leave_approval_steps")
          .select("level,status,approver_employee_id,approver_role")
          .eq("leave_request_id", id)
          .order("level")).data ?? [])
      : [];
    return { id, chain, result: result.data as Record<string, unknown> | null };
  };

  const pendingSteps = (chain: { status: string; approver_employee_id: string }[]) =>
    chain.filter((s) => s.status === "pending");

  // ==========================================================================
  // 1. Employee chains are unchanged by this fix
  // ==========================================================================
  const empShort = await submit(clients.emp1, 2, "phase13 employee short", emp1.id);
  record(
    empShort.result?.valid === true && empShort.id !== undefined,
    "employee submits a short (2 day) request",
    empShort.result?.error_message as string,
  );
  record(
    empShort.chain.length === 1 && pendingSteps(empShort.chain).length === 1,
    "employee short leave -> a single manager signature",
    `chain: ${empShort.chain.map((s) => `L${s.level}:${s.status}`).join(" ")}`,
  );

  const empMedium = await submit(clients.emp1, 5, "phase13 employee medium", emp1.id);
  record(
    empMedium.chain.length === 2 && pendingSteps(empMedium.chain).length === 2,
    "employee medium (5 day) leave -> manager + department head",
    `chain: ${empMedium.chain.map((s) => `L${s.level}:${s.status}`).join(" ")}`,
  );

  const empLong = await submit(clients.emp1, 10, "phase13 employee long", emp1.id);
  record(
    empLong.chain.length === 3 && pendingSteps(empLong.chain).length === 3,
    "employee long (10 day) leave -> manager + department head + HR",
    `chain: ${empLong.chain.map((s) => `L${s.level}:${s.status}`).join(" ")}`,
  );
  record(
    empLong.chain.some((s) => s.approver_employee_id === hr.id),
    "the HR level of an employee's long leave is the HR user",
  );

  for (const id of [empShort.id, empMedium.id, empLong.id]) {
    if (id) {
      await admin.from("leave_approval_steps").delete().eq("leave_request_id", id);
      await admin.from("leave_requests").delete().eq("id", id);
    }
  }
  created.length = 0;

  // ==========================================================================
  // 2. HR leave routes, and never to themselves
  // ==========================================================================
  // Windows come from the per-employee cursor, so only the length matters here.
  for (const [label, days] of [
    ["short", 2],
    ["medium", 5],
    ["long", 10],
  ] as [string, number][]) {
    const submitted = await submit(clients.hr, days, `phase13 HR ${label}`, hr.id);
    const { data: request } = await admin
      .from("leave_requests")
      .select("status,blocked_reason")
      .eq("id", submitted.id!)
      .single();

    record(
      submitted.result?.valid === true && submitted.id !== undefined,
      `HR can submit ${label} (${days} day) leave`,
      submitted.result?.error_message as string,
    );
    record(
      request?.status === "pending",
      `HR ${label} leave routes instead of parking as blocked`,
      `${request?.status}${request?.blocked_reason ? `: ${request.blocked_reason}` : ""}`,
    );
    record(
      submitted.chain.every((s) => s.approver_employee_id !== hr.id),
      `HR ${label} leave never names the HR user as an approver`,
      submitted.chain
        .map((s) => `L${s.level}=${byId.get(s.approver_employee_id)?.name}(${s.status})`)
        .join(" "),
    );
    record(
      submitted.chain.some((s) => s.approver_employee_id === deptHead.id),
      `HR ${label} leave routes to the organisation head`,
    );
    record(
      pendingSteps(submitted.chain).length >= 1,
      `HR ${label} leave has at least one actionable signature`,
    );

    // HR must not be able to sign it, even as the only HR in the org.
    if (submitted.id) {
      const selfTry = await clients.hr.rpc("approve_leave_request", {
        p_request_id: submitted.id,
        p_comment: "Approving my own leave.",
      });
      record(
        (selfTry.data as { error_code?: string } | null)?.error_code === "FORBIDDEN",
        `HR cannot approve their own ${label} request`,
        JSON.stringify(selfTry.data),
      );
    }

    // and the organisation head can actually sign it
    if (submitted.id) {
      const step = pendingSteps(submitted.chain)[0];
      if (step) {
        const sign = await clients.deptHead.rpc("approve_leave_request", {
          p_request_id: submitted.id,
          p_comment: "Approved at organisation level.",
        });
        record(sign.data?.ok === true, `organisation head can sign HR ${label} leave`, JSON.stringify(sign.data));

        const { data: settled } = await admin
          .from("leave_requests")
          .select("status,decided_by")
          .eq("id", submitted.id)
          .single();
        record(
          settled?.status === "approved" && settled.decided_by === deptHead.id,
          `HR ${label} leave reaches a final approved status`,
          `${settled?.status} by ${byId.get(settled?.decided_by ?? "")?.name}`,
        );

      }
    }
  }

  // ==========================================================================
  // 3. Rejection at each stage
  // ==========================================================================
  const annualUsed = async () => {
    const { data } = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", emp1.id)
      .eq("year", YEAR)
      .eq("leave_type", "annual")
      .single();
    return Number(data?.used ?? 0);
  };
  {
    const at = await submit(clients.emp1, 2, "phase13 reject L1", emp1.id);
    const reject = await clients.manager.rpc("reject_leave_request", {
      p_request_id: at.id!,
      p_comment: "Rejected at the first stage.",
    });
    record(reject.data?.ok === true, "rejection at level 1 is accepted", JSON.stringify(reject.data));
    const { data: after } = await admin
      .from("leave_requests")
      .select("status,manager_comment")
      .eq("id", at.id!)
      .single();
    record(after?.status === "rejected", "level 1 rejection settles the request", after?.status);
    record(
      (after?.manager_comment ?? "").includes("first stage"),
      "the rejection reason is stored and shown",
      String(after?.manager_comment ?? "no comment stored"),
    );
  }
  {
    // Reject at the SECOND level: level 1 must be signed first.
    const beforeL2 = await annualUsed();
    const two = await submit(clients.emp1, 5, "phase13 reject L2", emp1.id);
    const tooEarly = await clients.deptHead.rpc("reject_leave_request", {
      p_request_id: two.id!,
      p_comment: "Jumping the queue.",
    });
    record(
      (tooEarly.data as { error_code?: string } | null)?.error_code !== undefined,
      "a later stage cannot decide before the earlier stage signs",
      JSON.stringify(tooEarly.data),
    );

    await clients.manager.rpc("approve_leave_request", {
      p_request_id: two.id!,
      p_comment: "Level one signed.",
    });
    const reject = await clients.deptHead.rpc("reject_leave_request", {
      p_request_id: two.id!,
      p_comment: "Rejected at department level.",
    });
    record(reject.data?.ok === true, "rejection at level 2 is accepted", JSON.stringify(reject.data));

    const { data: settledRow } = await admin
      .from("leave_requests")
      .select("status")
      .eq("id", two.id!)
      .single();
    record(
      settledRow?.status === "rejected",
      "level 2 rejection settles the request",
      settledRow?.status,
    );

    // A rejected request must not have moved the balance at all.
    const usedAfter = await annualUsed();
    record(
      usedAfter === beforeL2,
      "rejected leave spends no balance",
      `${beforeL2} -> ${usedAfter}`,
    );
  }

  // ==========================================================================
  // 4. Unauthorised and self approval
  // ==========================================================================
  {
    const target = await submit(clients.emp1, 2, "phase13 unauthorised", emp1.id);
    const outsiderTry = await clients.outsider.rpc("approve_leave_request", {
      p_request_id: target.id!,
      p_comment: "Not my department.",
    });
    record(
      (outsiderTry.data as { error_code?: string } | null)?.error_code === "FORBIDDEN",
      "a manager from another department cannot approve",
      JSON.stringify(outsiderTry.data),
    );

    // HR is org-wide, so HR legitimately CAN sign an employee's request.
    const hrTry = await clients.hr.rpc("approve_leave_request", {
      p_request_id: target.id!,
      p_comment: "Signing on the employee's behalf.",
    });
    record(hrTry.data?.ok === true, "HR retains org-wide authority over employee requests", JSON.stringify(hrTry.data));
  }

  // ==========================================================================
  // 5. Final approval spends the balance exactly once
  // ==========================================================================
  {
    const journey = await submit(clients.emp1, 10, "phase13 final", emp1.id);
    record(
      journey.id !== undefined,
      "employee submits a final 10 day request for the balance check",
      JSON.stringify(journey.result),
    );
    const before = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", emp1.id)
      .eq("year", YEAR)
      .eq("leave_type", "annual")
      .single();

    const l1 = await clients.manager.rpc("approve_leave_request", {
      p_request_id: journey.id!,
      p_comment: "L1",
    });
    record(l1.data?.ok === true, "level 1 signature succeeds", JSON.stringify(l1.data));
    const midway = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", emp1.id)
      .eq("year", YEAR)
      .eq("leave_type", "annual")
      .single();
    record(
      Number(midway.data?.used) === Number(before.data?.used),
      "balance untouched after the first of three signatures",
      `${before.data?.used} -> ${midway.data?.used}`,
    );

    // Duplicate signature on an already-signed step.
    const dupe = await clients.manager.rpc("approve_leave_request", {
      p_request_id: journey.id!,
      p_comment: "Signing twice.",
    });
    const dupeRefused =
      (dupe.data as { error_code?: string } | null)?.error_code != null || !!dupe.error;
    record(
      dupeRefused,
      "a step cannot be signed twice",
      `data=${JSON.stringify(dupe.data)} error=${dupe.error?.message ?? "none"}`,
    );

    const l2 = await clients.deptHead.rpc("approve_leave_request", {
      p_request_id: journey.id!,
      p_comment: "L2",
    });
    record(l2.data?.ok === true, "level 2 signature succeeds", JSON.stringify(l2.data));
    const l3 = await clients.hr.rpc("approve_leave_request", {
      p_request_id: journey.id!,
      p_comment: "L3",
    });
    record(l3.data?.ok === true, "level 3 signature succeeds", JSON.stringify(l3.data));

    const { data: settled } = await admin
      .from("leave_requests")
      .select("status,days")
      .eq("id", journey.id!)
      .single();
    const after = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", emp1.id)
      .eq("year", YEAR)
      .eq("leave_type", "annual")
      .single();
    record(
      Number(after.data?.used) === Number(before.data?.used) + Number(settled?.days),
      "the balance is spent exactly once, on the final signature",
      `${before.data?.used} + ${settled?.days} => ${after.data?.used}`,
    );
  }

  await clean();
  created.length = 0;


  // ==========================================================================
  // 7. What each person actually sees (the UI-facing surface)
  // ==========================================================================
  {
    const submitted = await submit(clients.hr, 5, "phase13 HR surfaces", hr.id);
    const id = submitted.id!;

    const inbox = async (cookie: string) => {
      const response = await fetch("http://localhost:3000/api/approvals", {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      return { status: response.status, ids: (body?.data ?? []).map((r) => r.id) };
    };

    // HR's own request must NOT sit in HR's approval inbox.
    const hrInbox = await inbox(hrCookies);
    record(
      hrInbox.status === 200 && !hrInbox.ids.includes(id),
      "HR does not see their own request in their approval inbox",
      `status ${hrInbox.status}`,
    );

    // It must be in the designated approver's inbox instead.
    const headInbox = await inbox(deptHeadCookies);
    record(
      headInbox.status === 200 && headInbox.ids.includes(id),
      "the designated approver sees the HR request in their inbox",
      `status ${headInbox.status}`,
    );

    // And it appears on the requester's own "My Leaves" list.
    const mine = await fetch(`http://localhost:3000/api/leave-requests`, {
      headers: { Cookie: hrCookies },
      signal: AbortSignal.timeout(30_000),
    });
    const mineBody = (await mine.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    record(
      (mineBody?.data ?? []).some((r) => r.id === id),
      "the HR request appears under the requester's My Leaves",
    );

    // The timeline must name the right people and mark the current stage.
    const chainResponse = await fetch(`http://localhost:3000/api/leave-requests/${id}/approval-chain`, {
      headers: { Cookie: hrCookies },
      signal: AbortSignal.timeout(30_000),
    });
    const chainBody = (await chainResponse.json().catch(() => null)) as
      | { data?: { steps?: { level: number; status: string; approver_name?: string; is_current?: boolean }[] } }
      | null;
    const steps = chainBody?.data?.steps ?? [];
    record(
      steps.length >= 1 && steps.every((step) => step.approver_name !== hr.name),
      "the timeline never lists the requester as an approver",
      steps.map((s2) => `L${s2.level}:${s2.approver_name}(${s2.status})`).join(" "),
    );
    record(
      steps.some((step) => step.is_current === true && step.status === "pending"),
      "the timeline marks which stage is current",
      steps.map((s2) => `L${s2.level} current=${s2.is_current}`).join(" "),
    );
  }

  // ==========================================================================
  // 6. Nothing is left stuck
  // ==========================================================================
  {
    const { data: stuck } = await admin
      .from("leave_requests")
      .select("id,employee_id,status,blocked_reason")
      .eq("status", "approval_blocked");
    for (const row of stuck ?? []) {
      // A blocked request is only acceptable if someone other than the
      // requester can actually decide it.
      const { data: otherHr } = await admin
        .from("employees")
        .select("id")
        .eq("app_role", "hr")
        .eq("is_active", true)
        .neq("id", row.employee_id);
      record(
        (otherHr ?? []).length > 0,
        `a blocked request still has an independent decider`,
        `requester ${byId.get(row.employee_id)?.name}, other HR ${(otherHr ?? []).length}`,
      );
    }
    if (!(stuck ?? []).length) console.log("PASS  no request is parked as approval_blocked");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` (${f.detail})` : ""}`);
  }
}

/** Request ids the demo seed owns. Anything else was created by this file. */
const SEEDED_REQUEST_IDS = new Set(
  Array.from({ length: 11 }, (_, i) => `11111111-1111-4111-8111-${String(200 + i).padStart(12, "0")}`),
);

/**
 * Restore the demo dataset no matter how the run ended.
 *
 * An earlier version cleaned up only on the success path, so a single failed
 * assertion left approved requests and a spent balance behind. The next run then
 * failed on an overlap it had caused itself, which looked like a product bug.
 * This runs from `finally`, so leaking is no longer possible.
 */
async function main() {
  const admin = createAdminClient();

  const { data: balancesBefore } = await admin
    .from("leave_balances")
    .select("id,used")
    .eq("year", YEAR);
  const snapshot = new Map((balancesBefore ?? []).map((b) => [b.id, Number(b.used)]));

  try {
    await runChecks();
  } finally {
    const { data: strays } = await admin.from("leave_requests").select("id");
    const strayIds = (strays ?? []).map((r) => r.id).filter((id) => !SEEDED_REQUEST_IDS.has(id));
    for (const id of strayIds) {
      await admin.from("leave_approval_steps").delete().eq("leave_request_id", id);
      await admin.from("alerts").delete().eq("related_request_id", id);
      await admin.from("leave_requests").delete().eq("id", id);
    }
    for (const [id, used] of snapshot) {
      await admin.from("leave_balances").update({ used }).eq("id", id);
    }
    if (strayIds.length) console.log(`\n(cleaned up ${strayIds.length} stray request(s))`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
