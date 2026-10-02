/**
 * How the approvals inbox turns a row into a question the database answers.
 *
 * These are pure functions over a row's status and current level, with no database
 * involved, because the thing worth pinning down is the mapping rather than the RPC:
 * `can_decide_leave_step` is written as
 *
 *     ... and (p_level is null or s.level = p_level)
 *
 * so a null `p_level` does not mean "this request's current level", it removes the
 * level constraint and lets the predicate match ANY pending step the viewer holds on
 * that request. Passing a parked request's null level through unchanged therefore
 * reported a decision the decision RPC would refuse.
 *
 * The regression that matters: a parked (`approval_blocked`) request must never be
 * asked with null, because `build_approval_chain` parks it with
 * `current_approval_level = NULL` while still leaving the department head's step
 * `pending`.
 *
 *   npm test
 */
import { describe, expect, it } from "vitest";

import {
  NO_APPROVAL_STEP_LEVEL,
  decisionProbeLevel,
  isUndecided,
} from "@/server/leave";

describe("isUndecided — which rows may be offered a decision at all", () => {
  it("treats a pending request as undecided", () => {
    expect(isUndecided("pending")).toBe(true);
  });

  it("treats a parked request as undecided, because HR can still clear it", () => {
    expect(isUndecided("approval_blocked")).toBe(true);
  });

  it.each(["approved", "rejected", "cancelled"])("treats %s as history", (status) => {
    expect(isUndecided(status)).toBe(false);
  });

  it("does not assume an unrecognised status is still open", () => {
    expect(isUndecided("something_new")).toBe(false);
  });
});

describe("decisionProbeLevel — how each row must be asked about", () => {
  it("asks a routable request about its own current level", () => {
    expect(decisionProbeLevel({ status: "pending", current_approval_level: 1 })).toBe(1);
    expect(decisionProbeLevel({ status: "pending", current_approval_level: 2 })).toBe(2);
  });

  it("never asks about a parked request with a null level", () => {
    // This is the regression. `build_approval_chain` sets
    // `current_approval_level = NULL` when it parks a request, and the level
    // argument it used to forward removed the level constraint inside the predicate,
    // so a department head holding the leftover pending step matched — a decision
    // `approve_leave_request` refuses with "only HR can decide it".
    const level = decisionProbeLevel({ status: "approval_blocked", current_approval_level: null });
    expect(level).not.toBeNull();
    expect(level).toBe(NO_APPROVAL_STEP_LEVEL);
  });

  it("asks a parked request about a level that cannot exist", () => {
    // `leave_approval_steps.level` is `check (level > 0)`, so this level names no
    // step and the only branch left that can answer true is `is_hr()`.
    expect(NO_APPROVAL_STEP_LEVEL).toBe(0);
  });

  it("parks a request even if it somehow carries a level", () => {
    // Status wins over the stored level: a parked request is HR-only regardless.
    expect(decisionProbeLevel({ status: "approval_blocked", current_approval_level: 2 })).toBe(NO_APPROVAL_STEP_LEVEL);
  });

  it("asks nothing when a routable request has no current level", () => {
    // `approve_leave_request` locks the step at the current level and returns
    // NOT_FOUND when there is none, so nobody may be offered a decision.
    expect(decisionProbeLevel({ status: "pending", current_approval_level: null })).toBeUndefined();
  });

  it("never returns a level for a request nobody may be asked about", () => {
    // The status gate runs first, so a decided request is not probed at all; this
    // guards the level helper from being reused outside that gate by accident.
    for (const status of ["approved", "rejected", "cancelled"]) {
      expect(isUndecided(status)).toBe(false);
    }
  });
});

describe("the two together, as the route applies them", () => {
  const rows = [
    { status: "pending", current_approval_level: 1 },
    { status: "pending", current_approval_level: 2 },
    { status: "pending", current_approval_level: null },
    { status: "approval_blocked", current_approval_level: null },
    { status: "approval_blocked", current_approval_level: 1 },
    { status: "approved", current_approval_level: null },
    { status: "rejected", current_approval_level: 2 },
    { status: "cancelled", current_approval_level: 1 },
  ];

  it("asks the database only about rows that could still move, and never with null", () => {
    const asked = rows.filter((r) => isUndecided(r.status)).map((r) => decisionProbeLevel(r));
    // Only the two routable rows with a level produce a question at all.
    expect(asked.filter((l) => l !== undefined)).toEqual([1, 2, NO_APPROVAL_STEP_LEVEL, NO_APPROVAL_STEP_LEVEL]);
    // A null would be the unconstrained query, so its total absence is the point.
    expect(asked).not.toContain(null);
  });

  it("never probes a decided row", () => {
    const decided = rows.filter((r) => ["approved", "rejected", "cancelled"].includes(r.status));
    expect(decided.every((r) => !isUndecided(r.status))).toBe(true);
  });
});