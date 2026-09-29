-- =============================================================================
-- OrgFlow — 0004_approval_rpc.sql
-- The approval workflow. This is the only place a balance is ever decremented.
--
-- Rule 2: the balance moves ONLY on approval, inside one transaction, with the
-- request row and the balance row locked FOR UPDATE. Two managers clicking
-- Approve at the same instant therefore serialise on the request row: the
-- second caller sees status='approved' and is rejected, so days are spent once.
--
-- Rule 1: every check the UI performed at submit time is re-run here, because
-- the world may have moved between submit and approve (a new overlapping leave
-- was approved, HR reduced the allocation, another request consumed the
-- balance). A dry run is never trusted.
--
-- There is deliberately NO update policy on leave_requests (see 0002), so these
-- RPCs are the only path to a decided state.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- Shared decision guard. SECURITY DEFINER so the authorisation decision is made
-- in the database and cannot be bypassed by a crafted request.
--
-- TRUE when the caller may decide `p_employee_id`'s leave: HR org-wide, or the
-- direct manager. An employee is never allowed to decide their own leave, even
-- if they happen to be a manager or HR.
-- =============================================================================
create or replace function public.can_decide_leave(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_employee_id() is not null
     and p_employee_id <> public.current_employee_id()
     and (public.is_hr() or public.is_manager_of(p_employee_id));
$$;

-- The shape every decision RPC returns on failure. Built in one place so the
-- two RPCs cannot drift apart.
create or replace function public.decision_error(
  p_code    text,
  p_message text,
  p_details jsonb default '{}'::jsonb
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'ok', false,
    'error_code', p_code,
    'error_message', p_message,
    'details', coalesce(p_details, '{}'::jsonb)
  );
$$;

-- =============================================================================
-- approve_leave_request(request_id, comment) -> json
--
-- Order of operations inside the single transaction:
--   1. lock the request FOR UPDATE, read status + employee
--   2. authorise the caller (can_decide_leave)
--   3. lock the matching leave_balances row FOR UPDATE
--   4. re-check overlap against other APPROVED leaves
--   5. re-check remaining >= days (skipped for unpaid, which is uncapped)
--   6. used += days
--   7. status = 'approved' + comment + decided_by + decided_at
--
-- Any failure returns before step 6, so a rejected approval leaves both the
-- balance and the request untouched — the whole function is one statement, so a
-- returned error also rolls back nothing that was written.
-- =============================================================================
create or replace function public.approve_leave_request(
  p_request_id uuid,
  p_comment    text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor        uuid  := public.current_employee_id();
  v_employee     uuid;
  v_status       public.leave_status;
  v_leave_type   public.leave_type;
  v_start        date;
  v_end          date;
  v_days         numeric;
  v_created_at   timestamptz;
  v_reason       text;
  v_remaining    numeric;
  v_balance_year int;
  v_comment      text  := nullif(btrim(coalesce(p_comment, '')), '');
  v_conflict     record;
  v_updated      public.leave_requests%rowtype;
begin
  if v_actor is null then
    return public.decision_error(
      'FORBIDDEN', 'No active employee record is linked to this account.');
  end if;

  if v_comment is not null and length(v_comment) > 500 then
    return public.decision_error(
      'VALIDATION', 'Keep the comment under 500 characters.');
  end if;

  -- ---- (1) lock the request -------------------------------------------------
  -- FOR UPDATE is what makes a double click safe: a concurrent approver blocks
  -- here until this transaction commits, then re-reads status='approved'.
  select r.employee_id, r.status, r.leave_type, r.start_date, r.end_date,
         r.days, r.created_at, r.reason
  into   v_employee, v_status, v_leave_type, v_start, v_end, v_days, v_created_at, v_reason
  from public.leave_requests r
  where r.id = p_request_id
  for update;

  if not found then
    return public.decision_error('NOT_FOUND', 'That leave request no longer exists.');
  end if;

  if v_status <> 'pending' then
    return public.decision_error(
      'VALIDATION',
      'This request was already ' || v_status || ' by someone else. Refresh to see the latest.',
      jsonb_build_object('status', v_status));
  end if;

  -- ---- (2) authorisation ----------------------------------------------------
  if not public.can_decide_leave(v_employee) then
    return public.decision_error(
      'FORBIDDEN',
      'Only this employee''s direct manager or HR can decide this request.');
  end if;

  -- ---- (3) lock the ledger row, then re-check the balance -------------------
  -- Unpaid leave has no cap: skip the balance entirely so there is no row to
  -- lock and no limit to enforce.
  v_balance_year := extract(year from v_start)::int;

  if v_leave_type <> 'unpaid' then
    select b.remaining into v_remaining
    from public.leave_balances b
    where b.employee_id = v_employee
      and b.year = v_balance_year
      and b.leave_type = v_leave_type
    for update;

    v_remaining := coalesce(v_remaining, 0);

    if v_days > v_remaining then
      return public.decision_error(
        'INSUFFICIENT_BALANCE',
        'Cannot approve: only ' || trim_scale(v_remaining) || ' ' || v_leave_type ||
        ' day' || case when trim_scale(v_remaining) = '1' then '' else 's' end ||
        ' remain, but this request needs ' || trim_scale(v_days) ||
        '. The balance changed after the request was submitted.',
        jsonb_build_object('days', v_days, 'available_balance', v_remaining));
    end if;
  end if;

  -- ---- (4) re-check overlap against other APPROVED leave --------------------
  -- A pending request cannot collide with another pending request here, because
  -- `create_leave_request` already blocks that. What can change is that someone
  -- else was approved for the same days in the meantime. Locked rows keep this
  -- check from racing another approver, and the
  -- `leave_requests_no_overlap_approved` exclusion constraint from 0001 is the
  -- database-level backstop even if it somehow does.
  select r.id, r.start_date, r.end_date into v_conflict
  from public.leave_requests r
  where r.employee_id = v_employee
    and r.id <> p_request_id
    and r.status = 'approved'
    and daterange(r.start_date, r.end_date, '[]')
        && daterange(v_start, v_end, '[]')
  order by r.start_date
  limit 1
  for update;

  if found then
    return public.decision_error(
      'OVERLAP',
      'This request now clashes with approved leave from ' ||
      to_char(v_conflict.start_date, 'DD Mon') || ' to ' ||
      to_char(v_conflict.end_date, 'DD Mon') || '.',
      jsonb_build_object('conflicts', jsonb_build_array(jsonb_build_object(
        'id',         v_conflict.id,
        'status',     'approved',
        'start_date', v_conflict.start_date,
        'end_date',   v_conflict.end_date
      ))));
  end if;

  -- ---- (6) Spend the days --------------------------------------------------
  -- The CHECK (used <= allocated) is the last line of defence; the lock above is
  -- what makes this correct under concurrency.
  if v_leave_type <> 'unpaid' then
    update public.leave_balances b
    set used = b.used + v_days
    where b.employee_id = v_employee
      and b.year = v_balance_year
      and b.leave_type = v_leave_type;
  end if;

  -- ---- (7) record the decision ---------------------------------------------
  update public.leave_requests r
  set status          = 'approved',
      manager_comment = v_comment,
      decided_by      = v_actor,
      decided_at      = now()
  where r.id = p_request_id
  returning r.* into v_updated;

  return jsonb_build_object(
    'ok', true,
    'error_code', null,
    'error_message', null,
    'request', to_jsonb(v_updated) || jsonb_build_object(
      'available_balance', case when v_leave_type = 'unpaid' then null
                                else v_remaining - v_days end
    )
  );
end;
$$;

-- =============================================================================
-- reject_leave_request(request_id, comment) -> json
--
-- Same locking and authorisation as approve, minus the ledger. A rejection never
-- touches leave_balances, and the reason is mandatory so the employee is told
-- something actionable.
-- =============================================================================
create or replace function public.reject_leave_request(
  p_request_id uuid,
  p_comment    text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor      uuid  := public.current_employee_id();
  v_employee   uuid;
  v_status     public.leave_status;
  v_comment    text  := nullif(btrim(coalesce(p_comment, '')), '');
  v_updated    public.leave_requests%rowtype;
begin
  if v_actor is null then
    return public.decision_error(
      'FORBIDDEN', 'No active employee record is linked to this account.');
  end if;

  if v_comment is null or length(v_comment) < 3 then
    return public.decision_error(
      'VALIDATION', 'Give a reason of at least 3 characters so the employee knows what to change.');
  end if;

  if length(v_comment) > 500 then
    return public.decision_error('VALIDATION', 'Keep the comment under 500 characters.');
  end if;

  -- Same lock as approve: a concurrent decision loses the race and is told the
  -- request is no longer pending.
  select r.employee_id, r.status into v_employee, v_status
  from public.leave_requests r
  where r.id = p_request_id
  for update;

  if not found then
    return public.decision_error('NOT_FOUND', 'That leave request no longer exists.');
  end if;

  if v_status <> 'pending' then
    return public.decision_error(
      'VALIDATION',
      'This request was already ' || v_status || ' by someone else. Refresh to see the latest.',
      jsonb_build_object('status', v_status));
  end if;

  if not public.can_decide_leave(v_employee) then
    return public.decision_error(
      'FORBIDDEN',
      'Only this employee''s direct manager or HR can decide this request.');
  end if;

  update public.leave_requests r
  set status          = 'rejected',
      manager_comment = v_comment,
      decided_by      = v_actor,
      decided_at      = now()
  where r.id = p_request_id
  returning r.* into v_updated;

  return jsonb_build_object(
    'ok', true,
    'error_code', null,
    'error_message', null,
    'request', to_jsonb(v_updated)
  );
end;
$$;

-- =============================================================================
-- Grants. `can_decide_leave` is an internal guard, not a client entry point;
-- the two decision RPCs are the only client-facing surface.
-- =============================================================================
revoke execute on function public.can_decide_leave(uuid) from public, anon, authenticated;
revoke execute on function public.decision_error(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.approve_leave_request(uuid, text) to authenticated, service_role;
grant execute on function public.reject_leave_request(uuid, text) to authenticated, service_role;

-- =============================================================================
-- Realtime: publish the two tables the UI watches, so a manager's decision
-- reaches the employee's My Leaves page without a manual reload. Guarded by
-- pg_publication_tables, so re-running the migration is a no-op.
-- =============================================================================
do $$
declare
  t text;
begin
  foreach t in array array['public.leave_requests', 'public.leave_balances'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname || '.' || tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %s', t);
    end if;
  end loop;
end $$;
