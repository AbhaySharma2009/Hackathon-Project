-- =============================================================================
-- OrgFlow — 0004b_hierarchical_approval.sql
-- Multi-level leave approval driven by the reporting hierarchy.
--
-- Rule 1 still holds: every approval decision, and every rule about who may
-- decide, lives in Postgres. The UI renders a chain it did not build and the
-- client never names an approver.
--
-- Design notes that the rest of this file depends on:
--
--  * A chain is SNAPSHOT. `leave_approval_steps.approver_employee_id` is frozen at
--    submission time, so changing `employees.manager_id` later never rewrites
--    history — it only affects requests created afterwards. There is no trigger
--    on employees that touches this table.
--  * Steps are created up front for every required level, with `skipped` written
--    immediately where a level resolves to somebody already on the chain (or to
--    the requester, who may never approve their own leave). The ACTIVE step is
--    `leave_requests.current_approval_level`; a step is never "activated" by
--    changing its own status, so an un-reached step stays `pending` and is
--    simply not the current level.
--  * The balance is spent only when the LAST actionable step is approved, inside
--    that same transaction, under the same row lock as before (rule 2).
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- REDEFINED FUNCTIONS
--
-- Postgres will not let CREATE OR REPLACE change a parameter's name, and several
-- of these are being re-issued under the same signature. Drop first, recreate
-- below. Same approach as `working_days` in 0003.
-- =============================================================================
-- `can_manage` is referenced by three policies, and a policy is a hard
-- dependency, so those are dropped and re-issued further down with the function.
drop policy if exists leave_requests_select   on public.leave_requests;
drop policy if exists leave_requests_update_manage on public.leave_requests;
drop policy if exists leave_balances_select    on public.leave_balances;

drop function if exists public.can_manage(uuid);
drop function if exists public.can_decide_leave(uuid);
drop function if exists public.create_leave_request(public.leave_type, date, date, text);
drop function if exists public.approve_leave_request(uuid, text);
drop function if exists public.reject_leave_request(uuid, text);
drop function if exists public.leave_type_of(uuid);
drop function if exists public.build_approval_chain(uuid);
drop function if exists public.notify_approval_turn(uuid, int, boolean);
drop function if exists public.generate_approval_alerts(int);
drop function if exists public.get_approval_chain(uuid);
drop function if exists public.can_decide_leave_step(uuid, int);
drop function if exists public.resolve_department_head(uuid);
drop function if exists public.resolve_hr_approver(uuid);
drop function if exists public.resolve_direct_manager(uuid);
drop function if exists public.required_approval_levels(numeric);

-- =============================================================================
-- ENUMS
-- =============================================================================
do $$ begin
  create type public.approval_step_status as enum ('pending', 'approved', 'rejected', 'skipped');
exception when duplicate_object then null; end $$;

-- The *kind* of approval a step represents. Distinct from `employees.app_role`:
-- a department head is a manager by `app_role`, but this step is what makes
-- them the second signature on a long request.
do $$ begin
  create type public.approval_step_role as enum ('manager', 'department_head', 'hr');
exception when duplicate_object then null; end $$;

-- A request that cannot be routed is parked, not auto-approved. This is a
-- distinct status rather than an error so the employee can see *why* on their
-- own list, and so HR retains the override path.
do $$ begin
  alter type public.leave_status add value if not exists 'approval_blocked';
exception when duplicate_object then null; end $$;

-- =============================================================================
-- leave_requests: current level + why it is blocked
-- =============================================================================
alter table public.leave_requests
  add column if not exists current_approval_level int,
  add column if not exists blocked_reason      text;

-- 0001 asserted that any non-pending request records who decided it and when.
-- `approval_blocked` is exactly the case that has no decider, so the original
-- rule has to admit it explicitly.
alter table public.leave_requests
  drop constraint if exists leave_requests_decision_fields;
alter table public.leave_requests
  add constraint leave_requests_decision_fields check (
    status in ('pending', 'approval_blocked')
    or (decided_by is not null and decided_at is not null)
  );

create index if not exists leave_requests_current_level_idx
  on public.leave_requests (current_approval_level)
  where status = 'pending';

-- =============================================================================
-- leave_approval_steps
-- =============================================================================
create table if not exists public.leave_approval_steps (
  id                   uuid primary key default gen_random_uuid(),
  leave_request_id     uuid        not null references public.leave_requests (id) on delete cascade,
  -- 1-based. Ascending order IS the order of signature.
  level                int         not null check (level > 0),
  -- Frozen at submission. Deliberately NOT a live lookup of employees.manager_id.
  approver_employee_id uuid        not null references public.employees (id) on delete restrict,
  approver_role        public.approval_step_role not null,
  status               public.approval_step_status not null default 'pending',
  comment              text,
  decided_at           timestamptz,
  created_at           timestamptz not null default now(),
  -- One step per level per request.
  constraint leave_approval_steps_unique_level unique (leave_request_id, level),
  -- Only a settled step may carry a comment or a timestamp.
  constraint leave_approval_steps_decision_fields check (
    status in ('pending', 'skipped') or decided_at is not null
  )
);

create index if not exists leave_approval_steps_request_idx
  on public.leave_approval_steps (leave_request_id, level);

-- The "my turn" query behind the manager inbox.
create index if not exists leave_approval_steps_approver_status_idx
  on public.leave_approval_steps (approver_employee_id, status);

comment on table public.leave_approval_steps is
  'Frozen approval chain for one leave request. Rows are written at submission and never rewritten when the org hierarchy changes.';

comment on column public.leave_approval_steps.approver_employee_id is
  'Snapshot of the approver at submission time, so historical chains stay accurate after a manager change.';

-- =============================================================================
-- ALERTS: idempotency key + the new approval types
--
-- Rule 7 of the phase list: a refresh must not duplicate an alert. A unique
-- dedupe_key gives that for free via `on conflict do nothing`, instead of
-- trying to make the generator idempotent by comparison.
-- =============================================================================
alter table public.alerts
  add column if not exists dedupe_key text,
  add column if not exists related_request_id uuid references public.leave_requests (id) on delete cascade;

create unique index if not exists alerts_dedupe_key_idx
  on public.alerts (dedupe_key)
  where dedupe_key is not null;

alter table public.alerts drop constraint if exists alerts_type_valid;
alter table public.alerts add constraint alerts_type_valid check (
  type in (
    'leave_approved', 'leave_rejected', 'leave_pending', 'balance_low',
    'upcoming_leave', 'team_absent',
    -- Phase 3.5: the next approver's turn, and the escalation to them.
    'approval_pending', 'approval_escalated',
    -- A step that has waited past the configured threshold.
    'approval_overdue'
  )
);

-- =============================================================================
-- HIERARCHY RESOLUTION
-- =============================================================================

-- How many signatures a request of this length needs.
--   1-3 working days -> manager
--   4-7 working days -> manager + department head
--   8+ working days  -> manager + department head + HR
create or replace function public.required_approval_levels(p_days numeric)
returns int
language sql
immutable
as $$
  select case when p_days > 7 then 3 when p_days > 3 then 2 else 1 end;
$$;

-- The department head is derived, never configured: the TOPMOST ancestor in the
-- reporting chain who sits in the same department as the employee. Walking to
-- the top (rather than taking the first same-department ancestor) matters for a
-- stacked department like Engineering, where both Sanjay and Aditya qualify and
-- Aditya is the actual head.
--
-- Returns NULL when the employee has no same-department ancestor at all, which
-- is a real configuration gap and must block rather than auto-approve.
create or replace function public.resolve_department_head(p_employee_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dept        text;
  -- The ancestor currently being examined, and the next one up. They must be
  -- separate variables: reading `department, manager_id` into one pair would
  -- compare the grandparent's department against the parent employee and drop
  -- the top of the chain.
  v_current     uuid;
  v_next        uuid;
  v_cursor_dept text;
  v_head        uuid;
  v_depth       int := 0;
begin
  select e.department into v_dept
  from public.employees e
  where e.id = p_employee_id and e.is_active;

  if v_dept is null then
    return null;
  end if;

  select e.manager_id into v_current
  from public.employees e
  where e.id = p_employee_id;

  while v_current is not null and v_depth < 50 loop
    select e.department, e.manager_id into v_cursor_dept, v_next
    from public.employees e
    where e.id = v_current and e.is_active;

    -- An inactive or missing ancestor ends the walk; the last same-department
    -- ancestor seen before that is still the best answer we have.
    exit when not found;

    if v_cursor_dept = v_dept then
      v_head := v_current;
    end if;

    v_current := v_next;
    v_depth := v_depth + 1;
  end loop;

  return v_head;
end;
$$;

-- The HR signatory. Single-org today, so this is "the active HR"; ordered so the
-- choice is deterministic if an org ever has more than one. The requester is
-- excluded, because nobody may approve their own leave at any level.
create or replace function public.resolve_hr_approver(p_employee_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id
  from public.employees e
  where e.app_role = 'hr'
    and e.is_active
    and e.id <> p_employee_id
  order by e.join_date, e.id
  limit 1;
$$;

-- The top of the reporting chain above this person: the last active ancestor
-- reachable by walking `manager_id` upwards.
--
-- This is the fallback for a department that has no head of its own — most
-- importantly HR, whose only ancestor usually sits in a different department and
-- so never satisfies `resolve_department_head`. Without this fallback the only
-- HR in the organisation cannot route their own 4+ day request, and because the
-- sole HR is the requester there is nobody left who could override it either, so
-- the request is stuck forever.
--
-- Never returns the employee themselves: the walk starts at `manager_id`, so the
-- result is always strictly above them. That is what makes it safe as a fallback
-- for a person who must not approve their own leave.
create or replace function public.resolve_organization_head(p_employee_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_current uuid;
  v_next    uuid;
  v_top     uuid;
  v_depth   int := 0;
begin
  if p_employee_id is null then
    return null;
  end if;

  select e.manager_id into v_current
  from public.employees e
  where e.id = p_employee_id;

  while v_current is not null and v_depth < 50 loop
    select e.manager_id into v_next
    from public.employees e
    where e.id = v_current and e.is_active;

    -- An inactive or missing ancestor ends the walk; the last active ancestor
    -- seen before that is still the highest authority available.
    exit when not found;

    v_top := v_current;
    v_current := v_next;
    v_depth := v_depth + 1;
  end loop;

  return v_top;
end;
$$;

-- The direct manager, or NULL if the employee reports to nobody.
create or replace function public.resolve_direct_manager(p_employee_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.id
  from public.employees e
    join public.employees m on m.id = e.manager_id and m.is_active
  where e.id = p_employee_id and e.is_active;
$$;

-- RLS on `employees` and `leave_requests` keys off `can_manage`, which until
-- now meant "direct manager or HR". A department head is NOT the direct manager
-- of most of their department, so without this widening a level-2 approver would
-- not even be able to READ the request they are required to sign.
create or replace function public.can_manage(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_hr()
      or exists (
        select 1 from public.employees e
        where e.id = target
          and e.auth_user_id = auth.uid()
          and e.is_active
          and e.app_role in ('manager', 'hr')
      )
      -- assigned on an existing chain step (survives a later manager change)
      or exists (
        select 1 from public.leave_approval_steps s
        where s.approver_employee_id = public.current_employee_id()
          and s.leave_request_id in (
            select r.id from public.leave_requests r where r.employee_id = target
          )
      );
$$;

-- Re-issued from 0001 against the widened `can_manage`. Text is unchanged; only
-- the definition it calls has grown.
create policy leave_requests_select on public.leave_requests
  for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or public.can_manage(employee_id)
  );

create policy leave_requests_update_manage on public.leave_requests
  for update to authenticated
  using (public.can_manage(employee_id))
  with check (public.can_manage(employee_id));

create policy leave_balances_select on public.leave_balances
  for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or public.can_manage(employee_id)
  );

-- Same question, answered for a specific request: may this caller act on it?
-- The chain is the authority — a caller who is HR may always override, and
-- otherwise must hold the ACTIVE step. Self-approval is refused outright, so a
-- requester can never satisfy this by being named on their own chain.
create or replace function public.can_decide_leave_step(
  p_request_id uuid,
  p_level      int default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.leave_requests r
    where r.id = p_request_id
      and r.employee_id is distinct from public.current_employee_id()
      and (
        public.is_hr()
        or exists (
          select 1
          from public.leave_approval_steps s
          where s.leave_request_id = r.id
            and s.approver_employee_id = public.current_employee_id()
            and s.status = 'pending'
            and (p_level is null or s.level = p_level)
        )
      )
  );
$$;

revoke execute on function public.can_decide_leave_step(uuid, int) from public, anon;
grant execute on function public.can_decide_leave_step(uuid, int) to authenticated, service_role;

-- =============================================================================
-- CHAIN CONSTRUCTION
--
-- Called from create_leave_request inside the same transaction as the insert.
-- Returns the outcome so the caller can surface a blocked reason to the
-- employee immediately rather than silently dropping the request.
-- =============================================================================
create or replace function public.build_approval_chain(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req      public.leave_requests%rowtype;
  v_levels   int;
  v_manager  uuid;
  v_head     uuid;
  v_hr       uuid;
  v_reason   text;
  v_first    int;
begin
  select * into v_req from public.leave_requests r where r.id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'That leave request no longer exists.');
  end if;

  v_levels := public.required_approval_levels(v_req.days);
  v_manager := public.resolve_direct_manager(v_req.employee_id);

  -- ---- level 1: the direct manager is not optional ----------------------------
  -- Without it there is nobody who can start the chain, and routing past it to
  -- HR would be exactly the auto-approval the phase forbids.
  if v_manager is null then
    v_reason := format(
      'No direct manager is set up for you, so this request cannot be routed for approval. HR has been notified and can decide it as an override.'
    );
  else
    -- ---- level 2: department head -------------------------------------------
    if v_levels >= 2 then
      v_head := public.resolve_department_head(v_req.employee_id);

      -- Fall back to the top of the org chart when the requester's own
      -- department has no head. HR is the normal case: their manager sits in
      -- another department, so the same-department walk finds nothing. If the
      -- fallback also collapses onto level 1, the insert below records the step
      -- as `skipped` rather than asking one person to sign twice.
      if v_head is null then
        v_head := public.resolve_organization_head(v_req.employee_id);
      end if;

      if v_head is null then
        v_reason := format(
          'No department head is set up in the %s reporting line, so this request cannot be routed for approval. HR has been notified and can decide it as an override.',
          (select e.department from public.employees e where e.id = v_req.employee_id)
        );
      end if;
    end if;

    -- ---- level 3: HR ---------------------------------------------------------
    if v_reason is null and v_levels >= 3 then
      v_hr := public.resolve_hr_approver(v_req.employee_id);

      -- Nobody may approve their own leave, so this level excludes the
      -- requester. When the requester *is* the only HR that leaves nobody, and
      -- the correct escalation is the top of the org chart -- not a request
      -- parked as blocked that only the requester could ever clear.
      if v_hr is null then
        v_hr := public.resolve_organization_head(v_req.employee_id);
      end if;

      if v_hr is null then
        v_reason := 'No active HR approver is configured, so this request cannot be routed for approval.';
      end if;
    end if;
  end if;

  -- ---- blocked: park the request, keeping any resolvable steps for HR --------
  if v_reason is not null then
    -- Still record the steps we could resolve, so the chain the UI shows and the
    -- steps HR settles during an override are the same rows.
    if v_manager is not null then
      insert into public.leave_approval_steps
        (leave_request_id, level, approver_employee_id, approver_role, status)
      values (p_request_id, 1, v_manager, 'manager', 'skipped')
      on conflict (leave_request_id, level) do nothing;

      if v_levels >= 2 and v_head is not null then
        insert into public.leave_approval_steps
          (leave_request_id, level, approver_employee_id, approver_role, status)
        values (p_request_id, 2, v_head, 'department_head',
                case when v_head = v_manager then 'skipped' else 'pending' end)
        on conflict (leave_request_id, level) do nothing;
      end if;
    end if;

    update public.leave_requests r
    set status        = 'approval_blocked',
        blocked_reason = v_reason,
        current_approval_level = null
    where r.id = p_request_id;

    insert into public.alerts
      (scope_employee_id, type, severity, message, related_request_id, dedupe_key)
    values (
      v_req.employee_id, 'approval_pending', 'critical',
      'Your leave request could not be routed for approval: ' || v_reason,
      p_request_id,
      'approval_blocked:' || p_request_id::text
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;

    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;

  -- ---- routable: write the whole chain up front ------------------------------
  insert into public.leave_approval_steps
    (leave_request_id, level, approver_employee_id, approver_role, status)
  values (p_request_id, 1, v_manager, 'manager', 'pending')
  on conflict (leave_request_id, level) do nothing;

  if v_levels >= 2 then
    insert into public.leave_approval_steps
      (leave_request_id, level, approver_employee_id, approver_role, status)
    values (
      p_request_id, 2, v_head, 'department_head',
      -- A stacked department often makes the direct manager the department head
      -- too. Recording it as `skipped` keeps the three-level UI honest without
      -- asking one person to sign twice for the same request.
      case when v_head = v_manager
           then 'skipped'::public.approval_step_status
           else 'pending'::public.approval_step_status end
    )
    on conflict (leave_request_id, level) do nothing;
  end if;

  if v_levels >= 3 then
    insert into public.leave_approval_steps
      (leave_request_id, level, approver_employee_id, approver_role, status)
    values (
      p_request_id, 3, v_hr, 'hr',
      case
        when v_hr = v_manager then 'skipped'::public.approval_step_status
        when v_hr = v_head    then 'skipped'::public.approval_step_status
        else 'pending'::public.approval_step_status
      end
    )
    on conflict (leave_request_id, level) do nothing;
  end if;

  -- The first level that is actually actionable.
  select min(s.level) into v_first
  from public.leave_approval_steps s
  where s.leave_request_id = p_request_id and s.status = 'pending';

  update public.leave_requests r
  set current_approval_level = v_first
  where r.id = p_request_id;

  perform public.notify_approval_turn(p_request_id, v_first, true);

  return jsonb_build_object('ok', true, 'reason', null, 'first_level', v_first);
end;
$$;

-- =============================================================================
-- ALERTS
--
-- Every insert carries a deterministic dedupe_key and does `on conflict do
-- nothing`, so replaying a transition (or refreshing the page) can never double
-- an alert.
-- =============================================================================

-- Tell the approver whose turn it is, and tell the employee it moved along.
create or replace function public.notify_approval_turn(
  p_request_id uuid,
  p_level      int,
  p_first      boolean default false
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req   public.leave_requests%rowtype;
  v_step  public.leave_approval_steps%rowtype;
  v_emp   public.employees%rowtype;
begin
  select * into v_req from public.leave_requests r where r.id = p_request_id;
  select * into v_step from public.leave_approval_steps s
  where s.leave_request_id = p_request_id and s.level = p_level;
  select * into v_emp from public.employees e where e.id = v_req.employee_id;

  if v_step.id is null then
    return;
  end if;

  insert into public.alerts
    (scope_employee_id, type, severity, message, related_request_id, dedupe_key)
  values (
    v_step.approver_employee_id, 'approval_pending',
    case when p_first then 'warning' else 'info' end,
    format(
      '%s''s %s for %s to %s (%s working %s) is waiting for your approval as %s.',
      v_emp.name,
      initcap(v_req.leave_type::text),
      to_char(v_req.start_date, 'DD Mon'),
      to_char(v_req.end_date, 'DD Mon'),
      trim_scale(v_req.days),
      case when v_req.days = 1 then 'day' else 'days' end,
      initcap(replace(v_step.approver_role::text, '_', ' '))
    ),
    p_request_id,
    'approval_turn:' || p_request_id::text || ':' || p_level::text
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  -- The employee only hears about a move once one has happened; on first
  -- routing the "request submitted" alert already covers it.
  if not p_first then
    insert into public.alerts
      (scope_employee_id, type, severity, message, related_request_id, dedupe_key)
    values (
      v_req.employee_id, 'approval_escalated', 'info',
      format(
        'Your %s leave for %s to %s moved to the next approval level (%s).',
        v_req.leave_type,
        to_char(v_req.start_date, 'DD Mon'),
        to_char(v_req.end_date, 'DD Mon'),
        initcap(replace(v_step.approver_role::text, '_', ' '))
      ),
      p_request_id,
      'approval_escalated:' || p_request_id::text || ':' || p_level::text
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;
end;
$$;

-- A step that has been waiting past the threshold. Idempotent per (request,
-- level), so this can be run from the alert refresh on a schedule.
create or replace function public.generate_approval_alerts(p_threshold_days int default 2)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row   record;
  v_count int := 0;
begin
  for v_row in
    select s.id            as step_id,
           s.level         as level,
           s.leave_request_id as request_id,
           s.approver_employee_id as approver_id,
           r.leave_type,
           r.start_date,
           r.end_date,
           r.days,
           e.name          as employee_name
    from public.leave_approval_steps s
      join public.leave_requests r on r.id = s.leave_request_id
      join public.employees   e on e.id = r.employee_id
    where r.status = 'pending'
      and s.status = 'pending'
      and s.level = r.current_approval_level
      and r.created_at < now() - make_interval(days => p_threshold_days)
  loop
    insert into public.alerts
      (scope_employee_id, type, severity, message, related_request_id, dedupe_key)
    values (
      v_row.approver_id, 'approval_overdue', 'warning',
      format(
        '%s''s %s leave from %s has been waiting %s day(s) for your approval.',
        v_row.employee_name,
        initcap(v_row.leave_type::text),
        to_char(v_row.start_date, 'DD Mon'),
        p_threshold_days
      ),
      v_row.request_id,
      'approval_overdue:' || v_row.request_id::text || ':' || v_row.level::text
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;

    get diagnostics v_count = row_count;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.generate_approval_alerts(int) to service_role;
revoke execute on function public.generate_approval_alerts(int) from public, anon, authenticated;
grant execute on function public.notify_approval_turn(uuid, int, boolean) to service_role;
revoke execute on function public.notify_approval_turn(uuid, int, boolean) from public, anon, authenticated;

-- =============================================================================
-- DECISIONS
--
-- approve_leave_request / reject_leave_request now settle ONE step. The request
-- only becomes `approved` — and the balance is only spent — when the final
-- actionable step is signed. A rejection at any level ends the request outright.
--
-- A blocked request has no active step, so HR decides it directly: the override
-- path required by the phase, recorded as a real step so the audit trail is not
-- a special case.
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
  v_comment      text  := nullif(btrim(coalesce(p_comment, '')), '');
  v_remaining    numeric;
  v_balance_year int;
  v_conflict     record;
  v_updated      public.leave_requests%rowtype;
  v_step         public.leave_approval_steps%rowtype;
  v_level        int;
  v_next         int;
  v_is_final     boolean := false;
  v_override     boolean := false;
begin
  if v_actor is null then
    return public.decision_error('FORBIDDEN', 'No active employee record is linked to this account.');
  end if;

  if v_comment is not null and length(v_comment) > 500 then
    return public.decision_error('VALIDATION', 'Keep the comment under 500 characters.');
  end if;

  -- ---- (1) lock the request ---------------------------------------------------
  -- Unchanged from 0004 and still the thing that makes a double click safe: a
  -- concurrent approver blocks here, then re-reads a status it can no longer act
  -- on.
  select r.employee_id, r.status, r.leave_type, r.start_date, r.end_date,
         r.days, r.current_approval_level
  into   v_employee, v_status, v_leave_type, v_start, v_end, v_days, v_level
  from public.leave_requests r
  where r.id = p_request_id
  for update;

  if not found then
    return public.decision_error('NOT_FOUND', 'That leave request no longer exists.');
  end if;

  if v_employee = v_actor then
    return public.decision_error('FORBIDDEN', 'You cannot approve your own leave request.');
  end if;

  -- A pending request with no chain is one that predates this phase (or was
  -- inserted directly). Routing it here rather than rejecting it keeps the old
  -- rows decidable, and `build_approval_chain` is idempotent, so a request that
  -- already has steps is left exactly as it is.
  if v_status = 'pending'
     and not exists (
       select 1 from public.leave_approval_steps s where s.leave_request_id = p_request_id
     )
  then
    perform public.build_approval_chain(p_request_id);

    select r.current_approval_level into v_level
    from public.leave_requests r where r.id = p_request_id;

    -- Routing may have parked it as approval_blocked instead.
    select r.status into v_status
    from public.leave_requests r where r.id = p_request_id;

    if v_status = 'approval_blocked' then
      if not public.is_hr() then
        return public.decision_error(
          'FORBIDDEN',
          'This request could not be routed for approval and only HR can decide it.');
      end if;
      v_override := true;
      v_level := coalesce(v_level, 1);
    end if;
  end if;

  -- ---- (2) blocked requests: HR override ------------------------------------
  if v_status = 'approval_blocked' then
    if not public.is_hr() then
      return public.decision_error(
        'FORBIDDEN',
        'This request could not be routed for approval and only HR can decide it.');
    end if;

    v_override := true;
    v_level := coalesce(v_level, 1);
  elsif v_status <> 'pending' then
    return public.decision_error(
      'VALIDATION',
      'This request was already ' || v_status || '. Refresh to see the latest.',
      jsonb_build_object('status', v_status));
  end if;

  -- ---- (3) lock and authorise the ACTIVE step --------------------------------
  select * into v_step
  from public.leave_approval_steps s
  where s.leave_request_id = p_request_id
    and s.level = v_level
  for update;

  if v_step.id is null and not v_override then
    return public.decision_error('NOT_FOUND', 'This request has no approval step at this level.');
  end if;

  if not v_override then
    if v_step.status = 'skipped' then
      return public.decision_error(
        'VALIDATION', 'This approval level is not required for this request.');
    end if;

    if v_step.status <> 'pending' then
      return public.decision_error(
        'VALIDATION',
        'This approval step was already ' || v_step.status || '. Refresh to see the latest.',
        jsonb_build_object('step_status', v_step.status));
    end if;

    -- HR may sign any step as an override; nobody else may sign a step that is
    -- not theirs, which is what keeps one manager out of another team's chain.
    if v_step.approver_employee_id <> v_actor and not public.is_hr() then
      return public.decision_error(
        'FORBIDDEN',
        'This step is assigned to somebody else. Only the assigned approver or HR can sign it.');
    end if;

    update public.leave_approval_steps s
    set status     = 'approved',
        comment    = v_comment,
        decided_at = now()
    where s.id = v_step.id;
  else
    -- The override step is written as a real row so the history an employee sees
    -- explains itself, then treated as the final and only actionable step.
    insert into public.leave_approval_steps
      (leave_request_id, level, approver_employee_id, approver_role, status, comment, decided_at)
    values (p_request_id, v_level, v_actor, 'hr', 'approved', v_comment, now())
    on conflict (leave_request_id, level) do update
      set status     = 'approved',
          comment    = excluded.comment,
          decided_at = now();
  end if;

  -- ---- (4) is another level still to come? -----------------------------------
  -- A level the requester already sat on was written as `skipped`, so the next
  -- actionable level is simply the next `pending` one.
  if not v_override then
    select min(s.level) into v_next
    from public.leave_approval_steps s
    where s.leave_request_id = p_request_id
      and s.level > v_level
      and s.status = 'pending';

    v_is_final := v_next is null;
  else
    v_is_final := true;
  end if;

  -- ---- (5) not the last signature: hand over, spend nothing ------------------
  if not v_is_final then
    update public.leave_requests r
    set current_approval_level = v_next
    where r.id = p_request_id;

    perform public.notify_approval_turn(p_request_id, v_next, false);

    select * into v_updated from public.leave_requests r where r.id = p_request_id;

    return jsonb_build_object(
      'ok', true, 'error_code', null, 'error_message', null,
      'request', to_jsonb(v_updated),
      'awaiting_level', v_next,
      'final_approval', false);
  end if;

  -- ---- (6) FINAL signature: re-check and spend, exactly once ----------------
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

  -- Re-checked only now: a mid-chain approval must not spend the balance, and a
  -- collision can appear while the request sits at level 2 or 3.
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

  if v_leave_type <> 'unpaid' then
    update public.leave_balances b
    set used = b.used + v_days
    where b.employee_id = v_employee
      and b.year = v_balance_year
      and b.leave_type = v_leave_type;
  end if;

  update public.leave_requests r
  set status               = 'approved',
      manager_comment      = v_comment,
      decided_by           = v_actor,
      decided_at           = now(),
      current_approval_level = null,
      blocked_reason       = null
  where r.id = p_request_id
  returning r.* into v_updated;

  insert into public.alerts
    (scope_employee_id, type, severity, message, related_request_id, dedupe_key)
  values (
    v_employee, 'leave_approved', 'info',
    'Your ' || v_leave_type || ' leave from ' || to_char(v_start, 'DD Mon') ||
    ' to ' || to_char(v_end, 'DD Mon') || ' was approved.',
    p_request_id,
    'leave_approved:' || p_request_id::text
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object(
    'ok', true, 'error_code', null, 'error_message', null,
    'request', to_jsonb(v_updated) || jsonb_build_object(
      'available_balance', case when v_leave_type = 'unpaid' then null
                                else v_remaining - v_days end
    ),
    'awaiting_level', null,
    'final_approval', true);
end;
$$;

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
  v_leave_type public.leave_type;
  v_comment    text  := nullif(btrim(coalesce(p_comment, '')), '');
  v_updated  public.leave_requests%rowtype;
  v_step     public.leave_approval_steps%rowtype;
  v_level    int;
  v_override boolean := false;
begin
  if v_actor is null then
    return public.decision_error('FORBIDDEN', 'No active employee record is linked to this account.');
  end if;

  if v_comment is null or length(v_comment) < 3 then
    return public.decision_error(
      'VALIDATION', 'Give a reason of at least 3 characters so the employee knows what to change.');
  end if;

  if length(v_comment) > 500 then
    return public.decision_error('VALIDATION', 'Keep the comment under 500 characters.');
  end if;

  select r.employee_id, r.status, r.current_approval_level, r.leave_type
  into   v_employee, v_status, v_level, v_leave_type
  from public.leave_requests r
  where r.id = p_request_id
  for update;

  if not found then
    return public.decision_error('NOT_FOUND', 'That leave request no longer exists.');
  end if;

  if v_employee = v_actor then
    return public.decision_error('FORBIDDEN', 'You cannot decide your own leave request.');
  end if;

  -- Same lazy routing as approve: an unrouted pending request is routed first,
  -- so a row created before this phase is still rejectable.
  if v_status = 'pending'
     and not exists (
       select 1 from public.leave_approval_steps s where s.leave_request_id = p_request_id
     )
  then
    perform public.build_approval_chain(p_request_id);

    select r.current_approval_level, r.status into v_level, v_status
    from public.leave_requests r where r.id = p_request_id;

    if v_status = 'approval_blocked' then
      if not public.is_hr() then
        return public.decision_error(
          'FORBIDDEN',
          'This request could not be routed for approval and only HR can decide it.');
      end if;
      v_override := true;
      v_level := coalesce(v_level, 1);
    end if;
  end if;

  if v_status = 'approval_blocked' then
    if not public.is_hr() then
      return public.decision_error(
        'FORBIDDEN',
        'This request could not be routed for approval and only HR can decide it.');
    end if;
    v_override := true;
    v_level := coalesce(v_level, 1);
  elsif v_status <> 'pending' then
    return public.decision_error(
      'VALIDATION',
      'This request was already ' || v_status || '. Refresh to see the latest.',
      jsonb_build_object('status', v_status));
  end if;

  if not v_override then
    select * into v_step
    from public.leave_approval_steps s
    where s.leave_request_id = p_request_id
      and s.level = v_level
    for update;

    if v_step.id is null then
      return public.decision_error('NOT_FOUND', 'This request has no approval step at this level.');
    end if;

    if v_step.status = 'skipped' then
      return public.decision_error(
        'VALIDATION', 'This approval level is not required for this request.');
    end if;

    if v_step.status <> 'pending' then
      return public.decision_error(
        'VALIDATION',
        'This approval step was already ' || v_step.status || '. Refresh to see the latest.',
        jsonb_build_object('step_status', v_step.status));
    end if;

    if v_step.approver_employee_id <> v_actor and not public.is_hr() then
      return public.decision_error(
        'FORBIDDEN',
        'This step is assigned to somebody else. Only the assigned approver or HR can sign it.');
    end if;

    update public.leave_approval_steps s
    set status     = 'rejected',
        comment    = v_comment,
        decided_at = now()
    where s.id = v_step.id;
  else
    insert into public.leave_approval_steps
      (leave_request_id, level, approver_employee_id, approver_role, status, comment, decided_at)
    values (p_request_id, v_level, v_actor, 'hr', 'rejected', v_comment, now())
    on conflict (leave_request_id, level) do update
      set status     = 'rejected',
          comment    = excluded.comment,
          decided_at = now();
  end if;

  -- A rejection at ANY level ends the request immediately. Steps still to come
  -- are recorded as skipped rather than left dangling, and the balance is
  -- untouched because it was never spent.
  update public.leave_approval_steps s
  set status = 'skipped', decided_at = now()
  where s.leave_request_id = p_request_id
    and s.status = 'pending'
    and s.level <> v_level;

  update public.leave_requests r
  set status               = 'rejected',
      manager_comment      = v_comment,
      decided_by           = v_actor,
      decided_at           = now(),
      current_approval_level = null,
      blocked_reason       = null
  where r.id = p_request_id
  returning r.* into v_updated;

  insert into public.alerts
    (scope_employee_id, type, severity, message, related_request_id, dedupe_key)
  values (
    v_employee, 'leave_rejected', 'warning',
    'Your ' || v_leave_type || ' leave from ' ||
    to_char(v_updated.start_date, 'DD Mon') || ' to ' ||
    to_char(v_updated.end_date, 'DD Mon') || ' was rejected: ' || v_comment,
    p_request_id,
    'leave_rejected:' || p_request_id::text
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object(
    'ok', true, 'error_code', null, 'error_message', null,
    'request', to_jsonb(v_updated),
    'awaiting_level', null,
    'final_approval', false);
end;
$$;

-- =============================================================================
-- READ MODEL: GET /api/leave-requests/:id/approval-chain
--
-- Returns the frozen chain with names resolved for display. Authorization is the
-- same rule as the decision RPC: the requester, an approver on the chain, or HR.
-- =============================================================================
create or replace function public.get_approval_chain(p_request_id uuid)
returns jsonb
language plpgsql
-- volatile, not stable: an unrouted pending request is routed on read, so this
-- can write. Declaring it stable would let the planner cache a chain that a
-- concurrent decision has just settled.
volatile
security definer
set search_path = public
as $$
declare
  v_req      public.leave_requests%rowtype;
  v_actor    uuid := public.current_employee_id();
  v_levels   int;
  v_steps    jsonb;
begin
  select * into v_req from public.leave_requests r where r.id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'error_message', 'That leave request no longer exists.');
  end if;

  if v_req.employee_id <> v_actor
     and not public.is_hr()
     and not exists (
       select 1 from public.leave_approval_steps s
       where s.leave_request_id = p_request_id
         and s.approver_employee_id = v_actor
     )
  then
    return jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'error_message', 'You are not part of this request''s approval chain.');
  end if;

  v_levels := public.required_approval_levels(v_req.days);

  -- Read-time routing for a request that predates this phase, so the API never
  -- reports an empty timeline for something genuinely awaiting a signature.
  -- Only for `pending` rows: a decided request keeps whatever history it
  -- actually has rather than growing a fabricated one.
  if v_req.status = 'pending'
     and not exists (
       select 1 from public.leave_approval_steps s where s.leave_request_id = p_request_id
     )
  then
    perform public.build_approval_chain(p_request_id);
    select * into v_req from public.leave_requests r where r.id = p_request_id;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',                s.id,
      'level',             s.level,
      'approver_employee_id', s.approver_employee_id,
      'approver_name',     a.name,
      'approver_role',     s.approver_role,
      'status',            s.status,
      'comment',           s.comment,
      'decided_at',        s.decided_at,
      'created_at',        s.created_at,
      'is_current',        s.level = v_req.current_approval_level
    ) order by s.level
  ), '[]'::jsonb)
  into v_steps
  from public.leave_approval_steps s
    left join public.employees a on a.id = s.approver_employee_id
  where s.leave_request_id = p_request_id;

  return jsonb_build_object(
    'ok', true,
    'chain', jsonb_build_object(
      'request_id',         p_request_id,
      'status',             v_req.status,
      'blocked_reason',     v_req.blocked_reason,
      'current_approval_level', v_req.current_approval_level,
      'required_levels',    v_levels,
      'days',               v_req.days,
      'steps',              v_steps,
      'viewer_can_decide',  public.can_decide_leave_step(p_request_id)
    )
  );
end;
$$;

grant execute on function public.get_approval_chain(uuid) to authenticated, service_role;

-- =============================================================================
-- BACKFILL
--
-- Requests that are still pending were routed under the old single-approver
-- flow. Routing them now is what makes them decidable through the new chain, and
-- it is deliberately done for PENDING rows only: a request that was already
-- approved or rejected keeps the history it actually has, because inventing
-- steps for it would be a false record.
-- =============================================================================
do $$
declare
  r record;
begin
  for r in
    select id from public.leave_requests
    where status = 'pending'
      and not exists (
        select 1 from public.leave_approval_steps s where s.leave_request_id = leave_requests.id
      )
  loop
    perform public.build_approval_chain(r.id);
  end loop;
end $$;

-- =============================================================================
-- Hook chain construction into submission
--
-- create_leave_request keeps its original signature and its original validation;
-- only the routing after the insert is new. `public` because both are
-- SECURITY DEFINER in the same schema.
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
  v_chain    jsonb;
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

  -- Route it. A chain that cannot be built is NOT a validation failure: the
  -- request exists and the employee can see why it is parked, so this is folded
  -- into the response rather than rolled back.
  v_chain := public.build_approval_chain(v_id);

  return jsonb_build_object(
    'valid', true,
    'id', v_id,
    'days', (v_check->>'days')::numeric,
    'available_balance', v_check->'available_balance',
    'error_code', null,
    'error_message', null,
    'conflicts', '[]'::jsonb,
    'approval_blocked', not (v_chain->>'ok')::boolean,
    'approval_blocked_reason', v_chain->'reason',
    'current_approval_level', v_chain->'first_level');
end;
$$;

-- =============================================================================
-- RLS on the chain
-- =============================================================================
alter table public.leave_approval_steps enable row level security;

-- Visible to the requester, anybody named on the chain, and HR. Nobody else —
-- an unrelated manager cannot read the steps of another team's request.
drop policy if exists leave_approval_steps_select on public.leave_approval_steps;
create policy leave_approval_steps_select on public.leave_approval_steps
  for select to authenticated
  using (
    public.is_hr()
    or approver_employee_id = public.current_employee_id()
    or exists (
      select 1 from public.leave_requests r
      where r.id = leave_approval_steps.leave_request_id
        and r.employee_id = public.current_employee_id()
    )
  );

-- No insert/update/delete policy: the chain is written only by the SECURITY
-- DEFINER RPCs above, so a client cannot forge an approver or settle a step.
revoke insert, update, delete on public.leave_approval_steps from authenticated, anon;

-- The new alert columns are readable through the existing alerts policy.
alter table public.alerts enable row level security;

-- =============================================================================
-- GRANTS
-- =============================================================================
grant select on public.leave_approval_steps to authenticated, service_role;
grant execute on function public.required_approval_levels(numeric) to authenticated, service_role;
grant execute on function public.resolve_department_head(uuid) to authenticated, service_role;
grant execute on function public.resolve_hr_approver(uuid) to authenticated, service_role;
grant execute on function public.resolve_direct_manager(uuid) to authenticated, service_role;
grant execute on function public.resolve_organization_head(uuid) to authenticated, service_role;
grant execute on function public.build_approval_chain(uuid) to service_role;
revoke execute on function public.build_approval_chain(uuid) from public, anon, authenticated;
grant execute on function public.can_manage(uuid) to authenticated, service_role;
grant execute on function public.approve_leave_request(uuid, text) to authenticated, service_role;
grant execute on function public.reject_leave_request(uuid, text) to authenticated, service_role;

-- Keep the 0004 guard meaningful: it now also has to refuse when the caller holds
-- no step at all.
create or replace function public.can_decide_leave(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_employee_id() is not null
     and p_employee_id <> public.current_employee_id()
     and (public.is_hr() or public.is_manager_of(p_employee_id)
          or public.resolve_department_head(p_employee_id) = public.current_employee_id()
          -- Mirror the fallback in build_approval_chain: when a department has no
          -- head of its own the step is assigned to the top of the org chart, so
          -- that person is an authorised decider too.
          or public.resolve_organization_head(p_employee_id) = public.current_employee_id());
$$;

revoke execute on function public.can_decide_leave(uuid) from public, anon, authenticated;

-- Realtime: a step changing must reach the employee's My Leaves page.
do $$
declare
  t text;
begin
  foreach t in array array['public.leave_approval_steps'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname || '.' || tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %s', t);
    end if;
  end loop;
end $$;
