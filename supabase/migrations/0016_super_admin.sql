-- =============================================================================
-- 0016_super_admin.sql — the Super Admin tier (Phase 15)
--
-- Phase 14 built Admin > HR > Manager > Employee. Phase 15 inserts one more
-- tier above it and wires it into the approval chain:
--
--     Super Admin > Admin > HR > Manager > Employee
--
-- `alter type ... add value` cannot run inside a transaction block, and the new
-- value cannot be used by the transaction that adds it. As with `admin` in 0010,
-- the enum change is issued separately before this file:
--
--   alter type public.app_role add value if not exists 'super_admin';
--
-- ## Identity vs privilege
--
-- Same split 0010 used, extended one level:
--
--   is_hr()          identity      "is this person HR?" — unchanged, so an
--                                  Admin still does not appear as HR anywhere.
--   is_admin()       identity      Admin only. Super Admin is deliberately NOT
--                                  included: it answers "who is an Admin?", and
--                                  folding the top tier in would make Super
--                                  Admin appear as an Admin in the directory.
--   is_super_admin() identity      Super Admin only.
--   is_hr_or_admin() privilege      "may this person exercise org-wide
--                                  authority?" — widened to include Super Admin,
--                                  so the top tier inherits Admin's whole reach.
--   is_admin_or_super_admin()       privilege for the admin_* surfaces.
--
-- ## Approval
--
--   Admin leave       -> Super Admin
--   Super Admin leave -> a configured fallback approver, never themselves
--
-- Nobody may approve their own leave at any level, so the chain for an Admin
-- resolves to the Super Admin precisely because the requester is not one.
--
-- ## Self-escalation
--
-- The dangerous part of a new top tier is not the dashboard, it is `super_admin`
-- itself becoming something an Admin can hand out. `admin_update_employee` and
-- `admin_create_employee` therefore refuse to write the new role unless the
-- actor already holds it, so an Admin can never mint a peer or a superior.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- 1. Role ranking — Super Admin is the new ceiling
-- =============================================================================
create or replace function public.role_rank(p_role public.app_role)
returns int
language sql
immutable
as $$
  select case p_role
    when 'super_admin' then 5
    when 'admin'       then 4
    when 'hr'          then 3
    when 'manager'     then 2
    when 'employee'    then 1
    else 0
  end;
$$;

-- =============================================================================
-- 2. Identity and privilege helpers
-- =============================================================================
create or replace function public.is_super_admin()
returns boolean
language sql
immutable
security definer
set search_path = public
as $$
  select coalesce(public.current_app_role() = 'super_admin', false);
$$;

-- Unchanged on purpose: this stays an Admin-or-nothing question.
create or replace function public.is_admin()
returns boolean
language sql
immutable
security definer
set search_path = public
as $$
  select coalesce(public.current_app_role() = 'admin', false);
$$;

-- Org-wide authority now includes the top tier.
create or replace function public.is_hr_or_admin()
returns boolean
language sql
immutable
security definer
set search_path = public
as $$
  select public.current_app_role() in ('hr', 'admin', 'super_admin');
$$;

-- The privilege question behind every /api/admin and /api/super-admin surface.
create or replace function public.is_admin_or_super_admin()
returns boolean
language sql
immutable
security definer
set search_path = public
as $$
  select public.current_app_role() in ('admin', 'super_admin');
$$;

create or replace function public.can_administer(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_employee_id() is not null
     and (public.is_hr_or_admin() or public.is_manager_of(p_employee_id));
$$;

revoke execute on function public.is_super_admin() from public, anon;
revoke execute on function public.is_admin_or_super_admin() from public, anon;

grant execute on function public.is_super_admin() to authenticated, service_role;
grant execute on function public.is_admin_or_super_admin() to authenticated, service_role;
grant execute on function public.role_rank(public.app_role) to authenticated, service_role;
grant execute on function public.has_role_at_least(public.app_role) to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_hr_or_admin() to authenticated, service_role;
grant execute on function public.can_administer(uuid) to service_role;

-- =============================================================================
-- 3. Who may write the Super Admin role
--
-- Only somebody who already holds it. Without this, `app_role = 'super_admin'`
-- on an update payload would be a privilege-escalation primitive available to
-- every Admin. Returns false for an unauthenticated or non-super-admin actor,
-- so the caller treats "cannot grant" as a hard refusal.
-- =============================================================================
create or replace function public.can_grant_super_admin(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employees e
    where e.id = p_actor and e.is_active and e.app_role = 'super_admin'
  );
$$;

revoke execute on function public.can_grant_super_admin(uuid) from public, anon, authenticated;
grant execute on function public.can_grant_super_admin(uuid) to service_role;

-- =============================================================================
-- 4. The actor guard used by every admin_* / super_admin_* RPC
--
-- 0015's `assert_admin_actor` was Admin-only. This is the same check with the
-- ceiling raised, and it is what the RPCs call instead. The old name is kept as
-- a thin wrapper so nothing that already calls it breaks.
-- =============================================================================
create or replace function public.assert_admin_or_super_admin_actor(p_actor uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.app_role;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: no acting employee was supplied' using errcode = '42501';
  end if;

  select e.app_role into v_role from public.employees e where e.id = p_actor and e.is_active;

  if v_role is null then
    raise exception 'FORBIDDEN: the acting employee is not active' using errcode = '42501';
  end if;

  if v_role not in ('admin', 'super_admin') then
    raise exception 'FORBIDDEN: only an administrator may perform this action'
      using errcode = '42501';
  end if;

  return p_actor;
end;
$$;

-- The super-admin-only variant, for the surfaces an Admin must not reach.
create or replace function public.assert_super_admin_actor(p_actor uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_admin_or_super_admin_actor(p_actor);

  if not public.can_grant_super_admin(p_actor) then
    raise exception 'FORBIDDEN: this action is restricted to a Super Admin'
      using errcode = '42501';
  end if;

  return p_actor;
end;
$$;

create or replace function public.assert_admin_actor(p_actor uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- An Admin-actor check that a Super Admin also satisfies: the top tier may do
  -- anything an Admin may, plus the things an Admin may not.
  return public.assert_admin_or_super_admin_actor(p_actor);
end;
$$;

revoke execute on function public.assert_admin_or_super_admin_actor(uuid) from public;
revoke execute on function public.assert_super_admin_actor(uuid) from public;
revoke execute on function public.assert_admin_actor(uuid) from public;

grant execute on function public.assert_admin_or_super_admin_actor(uuid) to service_role;
grant execute on function public.assert_super_admin_actor(uuid) to service_role;
grant execute on function public.assert_admin_actor(uuid) to service_role;

-- =============================================================================
-- 5. Approval routing — Admin leave escalates to Super Admin
--
-- `resolve_hr_approver` is the function the chain already calls for its final
-- level, so the Admin case is added here rather than in a new branch of
-- `build_approval_chain`. That keeps one place that answers "who signs when
-- there is nobody above the requester", which is exactly the case the top tier
-- introduces.
--
-- Super Admin's own leave is a different problem and is handled in 6.
-- =============================================================================
create or replace function public.resolve_admin_approver(p_employee_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id
  from public.employees e
  where e.app_role = 'super_admin'
    and e.is_active
    and e.id <> p_employee_id
  order by e.join_date, e.id
  limit 1;
$$;

revoke execute on function public.resolve_admin_approver(uuid) from public, anon;
grant execute on function public.resolve_admin_approver(uuid) to service_role;

-- =============================================================================
-- 6. The fallback approver for a Super Admin's own leave
--
-- A Super Admin has nobody above them, and self-approval is forbidden, so the
-- request has to go somewhere configured rather than to a person the role
-- inherits. `approval_policy.super_admin_fallback_employee_id` names that
-- person; NULL means the org has not configured one and the request is parked
-- as blocked rather than silently auto-approved.
--
-- The fallback must be active and must not be the requester.
-- =============================================================================
alter table public.approval_policy
  add column if not exists super_admin_fallback_employee_id uuid
    references public.employees (id) on delete set null;

comment on column public.approval_policy.super_admin_fallback_employee_id is
  'Who signs a Super Admin''s own leave. NULL means unconfigured, and the request is parked as blocked — never self-approved.';

-- Resolve the configured fallback, excluding the requester and anybody inactive.
create or replace function public.resolve_super_admin_fallback(p_employee_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id
  from public.approval_policy p
    join public.employees e
      on e.id = p.super_admin_fallback_employee_id
     and e.is_active
  where p.id
    and e.id is distinct from p_employee_id;
$$;

revoke execute on function public.resolve_super_admin_fallback(uuid) from public, anon;
grant execute on function public.resolve_super_admin_fallback(uuid) to service_role;

-- =============================================================================
-- 7. Chain construction for the two new cases
--
-- Only the Admin/Super-Admin paths change. Every other role keeps the existing
-- manager -> department head -> HR chain, so a normal employee's request is
-- routed exactly as it was in Phase 14.
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
  v_top_role public.app_role;
  v_top      uuid;
begin
  select * into v_req from public.leave_requests r where r.id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'That leave request no longer exists.');
  end if;

  select e.app_role into v_top_role
  from public.employees e
  where e.id = v_req.employee_id;

  -- ---- the top two tiers are routed differently from everybody else ----------
  -- Neither has a manager, so the ordinary level-1 requirement would park every
  -- one of their requests as blocked. Instead the chain is a single explicit
  -- signature, decided by whoever is configured above them.
  if v_top_role in ('admin', 'super_admin') then
    if v_top_role = 'admin' then
      -- Admin leave -> Super Admin. Excludes the requester, so an Admin can
      -- never end up approving their own even if they also held the role.
      v_top := public.resolve_admin_approver(v_req.employee_id);
    else
      -- Super Admin leave -> the configured external/top-level approver.
      v_top := public.resolve_super_admin_fallback(v_req.employee_id);
    end if;

    if v_top is null then
      if v_top_role = 'admin' then
        v_reason := 'No active Super Admin is configured, so an administrator''s leave request cannot be routed for approval.';
      else
        v_reason := 'No fallback approver is configured for a Super Admin''s leave, so this request cannot be routed. It has been left unapproved rather than self-approved.';
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

    -- One signature, recorded as the HR-level step so the existing UI, the
    -- `approval_step_role` enum and the balance-spending trigger all keep working
    -- unchanged. The chain the user sees is "Admin -> Super Admin".
    insert into public.leave_approval_steps
      (leave_request_id, level, approver_employee_id, approver_role, status)
    values (p_request_id, 1, v_top, 'hr', 'pending')
    on conflict (leave_request_id, level) do nothing;

    update public.leave_requests r
    set current_approval_level = 1
    where r.id = p_request_id;

    perform public.notify_approval_turn(p_request_id, 1, true);

    return jsonb_build_object('ok', true, 'reason', null, 'first_level', 1);
  end if;

  -- ---- everybody else: the Phase 14 chain, unchanged ------------------------
  v_levels := public.required_approval_levels(v_req.days);
  v_manager := public.resolve_direct_manager(v_req.employee_id);

  if v_manager is null then
    v_reason := format(
      'No direct manager is set up for you, so this request cannot be routed for approval. HR has been notified and can decide it as an override.'
    );
  else
    if v_levels >= 2 then
      v_head := public.resolve_department_head(v_req.employee_id);

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

    if v_reason is null and v_levels >= 3 then
      v_hr := public.resolve_hr_approver(v_req.employee_id);

      if v_hr is null then
        v_hr := public.resolve_organization_head(v_req.employee_id);
      end if;

      if v_hr is null then
        v_reason := 'No active HR approver is configured, so this request cannot be routed for approval.';
      end if;
    end if;
  end if;

  if v_reason is not null then
    if v_manager is not null then
      insert into public.leave_approval_steps
        (leave_request_id, level, approver_employee_id, approver_role, status)
      values (p_request_id, 1, v_manager, 'manager', 'skipped')
      on conflict (leave_request_id, level) do nothing;

      if v_levels >= 2 and v_head is not null then
        insert into public.leave_approval_steps
          (leave_request_id, level, approver_employee_id, approver_role, status)
        values (p_request_id, 2, v_head, 'department_head',
                case when v_head = v_manager then 'skipped'::public.approval_step_status
               else 'pending'::public.approval_step_status end)
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

  insert into public.leave_approval_steps
    (leave_request_id, level, approver_employee_id, approver_role, status)
  values (p_request_id, 1, v_manager, 'manager', 'pending')
  on conflict (leave_request_id, level) do nothing;

  if v_levels >= 2 then
    insert into public.leave_approval_steps
      (leave_request_id, level, approver_employee_id, approver_role, status)
    values (p_request_id, 2, v_head, 'department_head',
            case when v_head = v_manager
                 then 'skipped'::public.approval_step_status
                 else 'pending'::public.approval_step_status end)
    on conflict (leave_request_id, level) do nothing;
  end if;

  if v_levels >= 3 then
    -- Every branch is cast: an uncast CASE resolves to `text`, and Postgres
    -- refuses to assign `text` to the `approval_step_status` column.
    insert into public.leave_approval_steps
      (leave_request_id, level, approver_employee_id, approver_role, status)
    values (p_request_id, 3, v_hr, 'hr',
            case
              when v_hr = v_manager then 'skipped'::public.approval_step_status
              when v_hr = v_head    then 'skipped'::public.approval_step_status
              else 'pending'::public.approval_step_status
            end)
    on conflict (leave_request_id, level) do nothing;
  end if;

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
-- 8. Nobody approves their own leave, at any level
--
-- Already enforced by `can_decide_leave_step` and the decision RPCs, but the two
-- new tiers are the case where it is easiest to get wrong: an Admin whose
-- approver resolves to themselves, or a Super Admin approving their own
-- fallback.
--
-- This has to be a trigger rather than a CHECK constraint, because a CHECK may
-- not contain a subquery and the requester lives in another table. The trigger
-- makes a self-approval unwritable even from a privileged caller, which a check
-- inside the RPC alone would not.
-- =============================================================================
create or replace function public.guard_no_self_approval_step()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester uuid;
begin
  select r.employee_id into v_requester
  from public.leave_requests r
  where r.id = new.leave_request_id;

  if v_requester is not null and new.approver_employee_id = v_requester then
    raise exception 'FORBIDDEN: an approver may never be the requester'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_leave_approval_steps_no_self_approval on public.leave_approval_steps;

create trigger trg_leave_approval_steps_no_self_approval
  before insert or update on public.leave_approval_steps
  for each row execute function public.guard_no_self_approval_step();

revoke execute on function public.guard_no_self_approval_step() from public, anon, authenticated;
grant execute on function public.guard_no_self_approval_step() to service_role;

-- =============================================================================
-- 9. Self-escalation guards on the admin RPCs
--
-- `admin_update_employee` and `admin_create_employee` are the only paths that
-- write `app_role`. Both refuse the Super Admin value unless the actor already
-- holds it. An Admin can therefore still create and manage HR, Manager and
-- Employee accounts, but cannot mint a peer or a superior.
-- =============================================================================
create or replace function public.admin_update_employee(
  p_actor        uuid,
  p_employee_id  uuid,
  p_app_role     public.app_role default null,
  p_department   text           default null,
  p_manager_id   uuid           default null,
  p_job_title    text           default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_target     public.employees%rowtype;
  v_new_role   public.app_role;
  v_new_dept   text;
begin
  perform public.assert_admin_or_super_admin_actor(p_actor);

  select * into v_target from public.employees e where e.id = p_employee_id;
  if not found then
    raise exception 'NOT_FOUND: no employee with that id' using errcode = 'P0002';
  end if;

  v_new_role := coalesce(p_app_role, v_target.app_role);
  v_new_dept := coalesce(nullif(btrim(p_department), ''), v_target.department);

  -- --- self-escalation and peer-escalation ---------------------------------
  -- Three separate refusals, because each is a distinct mistake:
  --   1. anyone changing their OWN role, however small the step;
  --   2. an Admin (not Super Admin) touching the Super Admin role at all;
  --   3. demoting or deactivating the last active Super Admin, which would
  --      leave nobody able to approve an Admin's leave and no way back.
  if p_employee_id = p_actor and p_app_role is not null and p_app_role <> v_target.app_role then
    raise exception 'FORBIDDEN: you cannot change your own role'
      using errcode = '42501';
  end if;

  if p_app_role = 'super_admin' and not public.can_grant_super_admin(p_actor) then
    raise exception 'FORBIDDEN: only a Super Admin may appoint another Super Admin'
      using errcode = '42501';
  end if;

  -- A Super Admin may only be demoted or deactivated by another Super Admin.
  if v_target.app_role = 'super_admin'
     and not public.can_grant_super_admin(p_actor) then
    raise exception 'FORBIDDEN: only a Super Admin may change a Super Admin account'
      using errcode = '42501';
  end if;

  if v_target.app_role = 'super_admin' and v_new_role <> 'super_admin' then
    if (select count(*) from public.employees e
         where e.app_role = 'super_admin' and e.is_active and e.id <> p_employee_id) = 0 then
      raise exception 'VALIDATION: this is the last active Super Admin and cannot be demoted'
        using errcode = '22023';
    end if;
  end if;

  if p_manager_id is not null then
    if not exists (select 1 from public.employees e
                   where e.id = p_manager_id and e.is_active) then
      raise exception 'VALIDATION: the chosen manager is not an active employee'
        using errcode = '22023';
    end if;
    if v_new_role = 'employee'
       and not exists (select 1 from public.employees e
                       where e.id = p_manager_id and e.app_role <> 'employee') then
      raise exception 'VALIDATION: a manager must hold the manager, HR or admin role'
        using errcode = '22023';
    end if;
  end if;

  if v_new_dept is not null
     and not exists (select 1 from public.departments d where d.name = v_new_dept) then
    raise exception 'VALIDATION: unknown department "%" — create it under Departments first', v_new_dept
      using errcode = '22023';
  end if;

  update public.employees e
  set app_role   = v_new_role,
      department = v_new_dept,
      manager_id = coalesce(p_manager_id, e.manager_id),
      role       = coalesce(nullif(btrim(p_job_title), ''), e.role)
  where e.id = p_employee_id;

  return jsonb_build_object('ok', true, 'id', p_employee_id);
end;
$$;

create or replace function public.admin_create_employee(
  p_actor       uuid,
  p_employee_id uuid,
  p_email       text,
  p_full_name   text,
  p_app_role    public.app_role default 'employee',
  p_department  text           default null,
  p_manager_id  uuid           default null,
  p_job_title   text           default 'Employee'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email   text := lower(btrim(p_email));
  v_dept    text := nullif(btrim(p_department), '');
  v_manager uuid;
begin
  perform public.assert_admin_or_super_admin_actor(p_actor);

  -- An Admin may hire anybody EXCEPT a Super Admin.
  if p_app_role = 'super_admin' and not public.can_grant_super_admin(p_actor) then
    raise exception 'FORBIDDEN: only a Super Admin may create another Super Admin'
      using errcode = '42501';
  end if;

  if p_employee_id is null then
    raise exception 'VALIDATION: an auth user must be created first and its id supplied'
      using errcode = '22023';
  end if;

  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'VALIDATION: a valid email address is required' using errcode = '22023';
  end if;

  if nullif(btrim(p_full_name), '') is null then
    raise exception 'VALIDATION: a name is required' using errcode = '22023';
  end if;

  if exists (select 1 from public.employees e where e.id = p_employee_id) then
    raise exception 'VALIDATION: that id is already in use' using errcode = '22023';
  end if;

  if exists (select 1 from public.employees e where lower(e.email) = v_email) then
    raise exception 'VALIDATION: that email is already in use' using errcode = '22023';
  end if;

  if v_dept is null then
    v_dept := 'Unassigned';
    insert into public.departments (name) values (v_dept) on conflict do nothing;
  elsif not exists (select 1 from public.departments d where d.name = v_dept) then
    raise exception 'VALIDATION: unknown department "%" — create it under Departments first', v_dept
      using errcode = '22023';
  end if;

  v_manager := nullif(p_manager_id, p_employee_id);

  if v_manager is not null
     and not exists (select 1 from public.employees e
                     where e.id = v_manager and e.is_active) then
    raise exception 'VALIDATION: the chosen manager is not an active employee'
      using errcode = '22023';
  end if;

  insert into public.employees
    (id, email, name, app_role, department, manager_id, role, is_active)
  values (
    p_employee_id,
    v_email,
    btrim(p_full_name),
    coalesce(p_app_role, 'employee'),
    v_dept,
    v_manager,
    coalesce(nullif(btrim(p_job_title), ''), 'Employee'),
    true
  );

  insert into public.leave_balances (employee_id, year, leave_type, allocated, used)
  select p_employee_id,
         extract(year from current_date)::int,
         t.leave_type,
         case t.leave_type
           when 'casual' then 12
           when 'sick'   then 10
           when 'annual' then 20
           else 0
         end,
         0
  from unnest(enum_range(null::public.leave_type)) as t(leave_type)
  on conflict (employee_id, year, leave_type) do nothing;

  return jsonb_build_object('ok', true, 'id', p_employee_id, 'email', v_email);
end;
$$;

-- The last active Super Admin cannot be deactivated, for the same reason the
-- last active Admin could not be in 0015.
create or replace function public.admin_set_employee_active(
  p_actor       uuid,
  p_employee_id uuid,
  p_is_active   boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.assert_admin_or_super_admin_actor(p_actor);

  if not exists (select 1 from public.employees e where e.id = p_employee_id) then
    raise exception 'NOT_FOUND: no employee with that id' using errcode = 'P0002';
  end if;

  -- An Admin may not touch a Super Admin account.
  if not p_is_active
     and exists (select 1 from public.employees e
                 where e.id = p_employee_id and e.app_role = 'super_admin')
     and not public.can_grant_super_admin(p_actor) then
    raise exception 'FORBIDDEN: only a Super Admin may deactivate a Super Admin account'
      using errcode = '42501';
  end if;

  if not p_is_active
     and exists (select 1 from public.employees e
                 where e.id = p_employee_id and e.app_role = 'super_admin' and e.is_active)
     and (select count(*) from public.employees e
          where e.app_role = 'super_admin' and e.is_active and e.id <> p_employee_id) = 0 then
    raise exception 'VALIDATION: this is the last active Super Admin and cannot be deactivated'
      using errcode = '22023';
  end if;

  if not p_is_active
     and exists (select 1 from public.employees e
                 where e.id = p_employee_id and e.app_role = 'admin' and e.is_active)
     and (select count(*) from public.employees e
          where e.app_role = 'admin' and e.is_active and e.id <> p_employee_id) = 0 then
    raise exception 'VALIDATION: this is the last active administrator and cannot be deactivated'
      using errcode = '22023';
  end if;

  update public.employees e set is_active = p_is_active where e.id = p_employee_id;

  if not p_is_active then
    update public.leave_approval_steps s
    set status = 'skipped'
    where s.approver_employee_id = p_employee_id and s.status = 'pending';
  end if;

  return jsonb_build_object('ok', true, 'id', p_employee_id, 'is_active', p_is_active);
end;
$$;

-- =============================================================================
-- 10. Super-admin-only surfaces
--
-- The activity/audit feed and the department list stay on the Admin surfaces —
-- an Admin legitimately needs both. What is Super-Admin-only is the ability to
-- grant the Super Admin role, which is why the console reads
-- `admin_list_employees` plus a dedicated escalation check.
-- =============================================================================
create or replace function public.admin_role_assignable(
  p_actor       uuid,
  p_target_role public.app_role
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_admin_or_super_admin_actor(p_actor);

  if p_target_role is null or p_target_role <> 'super_admin' then
    return true;
  end if;

  if not public.can_grant_super_admin(p_actor) then
    raise exception 'FORBIDDEN: only a Super Admin may assign the Super Admin role'
      using errcode = '42501';
  end if;

  return true;
end;
$$;

revoke execute on function public.admin_role_assignable(uuid, public.app_role) from public, anon, authenticated;
grant execute on function public.admin_role_assignable(uuid, public.app_role) to service_role;

-- The list the Super Admin console renders: every role in the enum, whether THIS
-- actor may assign it, and how many active people already hold it. Answered in
-- the database because the answer is viewer-dependent — an Admin gets
-- `super_admin: false`, a Super Admin gets `true` — and the UI must not be the
-- thing deciding that.
create or replace function public.admin_role_catalog(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_admin_or_super_admin_actor(p_actor);

  return jsonb_build_object(
    'can_assign_super_admin', public.can_grant_super_admin(p_actor),
    'roles', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'value', r.value::text,
            'rank', public.role_rank(r.value),
            -- An Admin may not hand out the tier above them. The refusal is
            -- returned as data here so the console can grey the row out; the
            -- write itself is refused again by admin_create/admin_update.
            'assignable',
              case
                when r.value = 'super_admin' then public.can_grant_super_admin(p_actor)
                else true
              end,
            'active_count', (
              select count(*)::int
              from public.employees e
              where e.app_role = r.value and e.is_active
            )
          )
          order by public.role_rank(r.value) desc
        ),
        '[]'::jsonb
      )
      from unnest(enum_range(null::public.app_role)) as r(value)
    ),
    'fallback_approver_id', (
      select p.super_admin_fallback_employee_id from public.approval_policy p where p.id
    )
  );
end;
$$;

revoke execute on function public.admin_role_catalog(uuid) from public, anon, authenticated;
grant execute on function public.admin_role_catalog(uuid) to service_role;

-- =============================================================================
-- 11. Super Admin org-wide read reach
--
-- `is_hr_or_admin()` already includes the top tier, which carries Super Admin
-- through every policy and summary function that used it. The one place that
-- needed widening explicitly is the approval inbox, so a Super Admin sees the
-- Admin requests waiting on them.
-- =============================================================================
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