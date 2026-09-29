-- =============================================================================
-- OrgFlow — 0003_leave_rpc.sql
-- Leave request validation and creation, entirely in Postgres.
--
-- Rule 1: the UI and the AI may never bypass the leave rules, so every rule lives
-- in these two RPCs. `validate_leave_request` is the dry run shown to the user;
-- `create_leave_request` re-runs the identical checks inside its own transaction
-- and never trusts a previous dry run.
--
-- Nothing is approved in this phase: balances are NOT decremented here.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- working_days(start, end) -> numeric
-- Mon-Fri inclusive, weekends excluded. `end` is a reserved word, hence quoted.
-- Replaces the integer version from 0001 (same argument types, new return type).
-- =============================================================================
drop function if exists public.working_days(date, date);

create function public.working_days(start date, "end" date)
returns numeric
language sql
immutable
strict
as $$
  select count(*)::numeric
  from generate_series(start::timestamp, "end"::timestamp, interval '1 day') as g(d)
  where extract(isodow from g.d::date) < 6;
$$;

comment on function public.working_days(date, date) is
  'Working-day count between two dates inclusive, excluding Saturdays and Sundays.';

-- =============================================================================
-- validate_leave_request_internal(employee, type, start, end)
-- The single source of truth for the leave rules. Not callable by clients.
-- Returns the same jsonb shape as validate_leave_request.
-- =============================================================================
create or replace function public.validate_leave_request_internal(
  p_employee_id  uuid,
  p_leave_type   public.leave_type,
  p_start        date,
  p_end          date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days       numeric;
  v_remaining  numeric := 0;
  v_conflicts  jsonb   := '[]'::jsonb;
  v_conflict   record;
  v_unpaid     boolean := (p_leave_type = 'unpaid');
begin
  -- ---- (a) date rules ------------------------------------------------------
  if p_start is null or p_end is null then
    return jsonb_build_object(
      'valid', false, 'days', 0, 'available_balance', null,
      'error_code', 'INVALID_DATES', 'error_message', 'Select a start and an end date.',
      'conflicts', '[]'::jsonb);
  end if;

  if p_end < p_start then
    return jsonb_build_object(
      'valid', false, 'days', 0, 'available_balance', null,
      'error_code', 'INVALID_DATES',
      'error_message', 'The end date must be on or after the start date.',
      'conflicts', '[]'::jsonb);
  end if;

  if p_start < current_date then
    return jsonb_build_object(
      'valid', false, 'days', 0, 'available_balance', null,
      'error_code', 'INVALID_DATES',
      'error_message', 'Leave cannot start in the past. Earliest selectable date is ' ||
                       to_char(current_date, 'DD Mon YYYY') || '.',
      'conflicts', '[]'::jsonb);
  end if;

  if extract(year from p_start) <> extract(year from p_end) then
    return jsonb_build_object(
      'valid', false, 'days', 0, 'available_balance', null,
      'error_code', 'INVALID_DATES',
      'error_message', 'A leave request cannot span more than one calendar year. ' ||
                       'Split it into two requests.',
      'conflicts', '[]'::jsonb);
  end if;

  v_days := public.working_days(p_start, p_end);

  if v_days = 0 then
    return jsonb_build_object(
      'valid', false, 'days', 0, 'available_balance', null,
      'error_code', 'INVALID_DATES',
      'error_message', 'The selected range has no working days — it is a weekend.',
      'conflicts', '[]'::jsonb);
  end if;

  -- ---- (b) overlap with approved OR pending requests ----------------------
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',         r.id,
               'status',     r.status,
               'start_date', r.start_date,
               'end_date',   r.end_date,
               'days',       r.days
             ) order by r.start_date
           ),
           '[]'::jsonb
         )
  into v_conflicts
  from public.leave_requests r
  where r.employee_id = p_employee_id
    and r.status in ('approved', 'pending')
    and daterange(r.start_date, r.end_date, '[]')
        && daterange(p_start, p_end, '[]');

  if jsonb_array_length(v_conflicts) > 0 then
    select c->>'status' as status,
           (c->>'start_date')::date as start_date,
           (c->>'end_date')::date as end_date
    into v_conflict
    from jsonb_array_elements(v_conflicts) c
    limit 1;

    return jsonb_build_object(
      'valid', false, 'days', v_days, 'available_balance', null,
      'error_code', 'OVERLAP',
      'error_message',
        'You already have ' || v_conflict.status || ' leave from ' ||
        to_char(v_conflict.start_date, 'DD Mon') || ' to ' ||
        to_char(v_conflict.end_date, 'DD Mon') || ' that overlaps with these dates' ||
        case when jsonb_array_length(v_conflicts) > 1
             then ' (and ' || (jsonb_array_length(v_conflicts) - 1) || ' more request' ||
                  case when jsonb_array_length(v_conflicts) > 2 then 's' else '' end || ').'
             else '.'
        end,
      'conflicts', v_conflicts);
  end if;

  -- ---- (c) balance ---------------------------------------------------------
  -- Unpaid leave is uncapped, so it has a ledger row but no limit.
  if v_unpaid then
    return jsonb_build_object(
      'valid', true, 'days', v_days, 'available_balance', null,
      'error_code', null, 'error_message', null, 'conflicts', '[]'::jsonb);
  end if;

  select b.remaining into v_remaining
  from public.leave_balances b
  where b.employee_id = p_employee_id
    and b.year = extract(year from p_start)::int
    and b.leave_type = p_leave_type;

  v_remaining := coalesce(v_remaining, 0);

  if v_days > v_remaining then
    return jsonb_build_object(
      'valid', false, 'days', v_days, 'available_balance', v_remaining,
      'error_code', 'INSUFFICIENT_BALANCE',
      'error_message', 'Insufficient leave balance. Available: ' || trim_scale(v_remaining) ||
                       ' days, Requested: ' || trim_scale(v_days) || ' days.',
      'conflicts', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'valid', true, 'days', v_days, 'available_balance', v_remaining,
    'error_code', null, 'error_message', null, 'conflicts', '[]'::jsonb);
end;
$$;

-- =============================================================================
-- validate_leave_request(type, start, end) -> json
-- Dry run for the UI. Always acts on the caller, never on a passed-in employee.
-- =============================================================================
create or replace function public.validate_leave_request(
  p_leave_type public.leave_type,
  p_start      date,
  p_end        date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.current_employee_id() is null then
    return jsonb_build_object(
      'valid', false, 'days', 0, 'available_balance', null,
      'error_code', 'FORBIDDEN', 'error_message', 'No active employee record is linked to this account.',
      'conflicts', '[]'::jsonb);
  end if;

  return public.validate_leave_request_internal(
    public.current_employee_id(), p_leave_type, p_start, p_end
  );
end;
$$;

-- =============================================================================
-- create_leave_request(type, start, end, reason) -> json
-- Re-validates inside this transaction, then inserts a 'pending' row.
-- Balance is deliberately untouched: only an approval may consume it.
-- =============================================================================
create or replace function public.create_leave_request(
  p_leave_type public.leave_type,
  p_start      date,
  p_end        date,
  p_reason     text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_employee uuid := public.current_employee_id();
  v_check    jsonb;
  v_id       uuid;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_employee is null then
    return jsonb_build_object(
      'valid', false, 'days', 0, 'available_balance', null,
      'error_code', 'FORBIDDEN', 'error_message', 'No active employee record is linked to this account.',
      'conflicts', '[]'::jsonb);
  end if;

  if v_reason is null or length(v_reason) < 5 or length(v_reason) > 500 then
    return jsonb_build_object(
      'valid', false, 'days', 0, 'available_balance', null,
      'error_code', 'VALIDATION',
      'error_message', 'Give a reason between 5 and 500 characters.',
      'conflicts', '[]'::jsonb);
  end if;

  -- The dry run the UI performed earlier is deliberately ignored.
  v_check := public.validate_leave_request_internal(v_employee, p_leave_type, p_start, p_end);

  if not (v_check->>'valid')::boolean then
    return v_check;
  end if;

  insert into public.leave_requests
    (employee_id, leave_type, start_date, end_date, days, reason, status)
  values
    (v_employee, p_leave_type, p_start, p_end,
     (v_check->>'days')::numeric, v_reason, 'pending')
  returning id into v_id;

  return jsonb_build_object(
    'valid', true,
    'id', v_id,
    'days', (v_check->>'days')::numeric,
    'available_balance', v_check->'available_balance',
    'error_code', null,
    'error_message', null,
    'conflicts', '[]'::jsonb);
end;
$$;

-- =============================================================================
-- Grants: the internal validator is not callable by clients.
-- =============================================================================
revoke execute on function public.validate_leave_request_internal(uuid, public.leave_type, date, date) from public, anon, authenticated;
grant execute on function public.working_days(date, date) to anon, authenticated, service_role;
grant execute on function public.validate_leave_request(public.leave_type, date, date) to authenticated, service_role;
grant execute on function public.create_leave_request(public.leave_type, date, date, text) to authenticated, service_role;
