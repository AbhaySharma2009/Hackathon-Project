-- =============================================================================
-- 0018_batch_decision_probe.sql — one round trip instead of one per row
--
-- `can_decide_leave_step(request_id, level)` answers "may the current employee
-- decide this request at this level?" and is the single authority for that
-- rule: `approve_leave_request` refuses independently, and the route used the
-- predicate only to decide which buttons to draw.
--
-- The approvals inbox previously called it once per candidate row. Each call is
-- a separate PostgREST round trip, so a 16-row inbox paid 16 sequential network
-- hops and dominated the endpoint's response time.
--
-- This adds a set-shaped wrapper that answers the same question for many
-- requests at once. It deliberately does NOT restate the rule: the body calls
-- `can_decide_leave_step` per input row, so the predicate stays defined in
-- exactly one place and the two cannot drift apart.
--
-- Additive only: no existing function, table, policy, or RLS rule is touched.
-- The approval decision itself is still enforced by the write RPC, which this
-- migration does not alter, so the worst outcome of a stale probe is a button
-- that the database then refuses.
-- =============================================================================

drop function if exists public.can_decide_leave_steps(jsonb);

-- Returns the subset of `p_targets` the calling employee may decide.
--
-- `p_targets` is a JSON array of objects shaped {"id": <uuid>, "lvl": <int|null>}.
-- `lvl` is the level to probe for, and null means "any pending level", matching
-- the null case of `can_decide_leave_step`.
--
-- `security definer` here only allows the body to invoke
-- `can_decide_leave_step` without a second grant. That function resolves the
-- caller through `current_employee_id()`, so every row is still evaluated as
-- the requesting employee rather than as the definer.
create function public.can_decide_leave_steps(
  p_targets jsonb
)
returns table (request_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_targets is null then
    return;
  end if;

  -- Validate the envelope here rather than letting jsonb_to_recordset raise a
  -- type error that would surface to the client as a 500. An empty array is the
  -- ordinary "nothing to probe" case and returns no rows.
  if jsonb_typeof(p_targets) is distinct from 'array' then
    raise exception 'can_decide_leave_steps: expected a JSON array of {id, lvl} objects, got %', jsonb_typeof(p_targets)
      using errcode = '22023';
  end if;

  return query
    select t.id
    from jsonb_to_recordset(p_targets) as t(id uuid, lvl int)
    where public.can_decide_leave_step(t.id, t.lvl);
end;
$$;

comment on function public.can_decide_leave_steps(jsonb) is
  'Set-shaped wrapper over can_decide_leave_step: returns the requests in the given {id,lvl} array that the calling employee may decide. Exists so the approvals inbox can probe a whole inbox in one round trip.';

-- Same exposure as the single-row function it delegates to: usable by a signed
-- in employee, never by an anonymous caller.
revoke execute on function public.can_decide_leave_steps(jsonb) from public, anon;
grant execute on function public.can_decide_leave_steps(jsonb) to authenticated, service_role;