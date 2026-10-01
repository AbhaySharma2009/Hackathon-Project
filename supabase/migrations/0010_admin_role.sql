-- =============================================================================
-- 0010_admin_role.sql — the Admin tier
--
-- Phase 14 adds a fourth role above HR: Admin > HR > Manager > Employee.
--
-- This file is applied in two steps on purpose. `alter type ... add value`
-- cannot run inside a transaction block, and the value cannot be used by the
-- transaction that adds it, so the enum change is issued separately before this
-- file:
--
--   alter type public.app_role add value if not exists 'admin';
--
-- ## Identity vs privilege
--
-- `is_hr()` stays an *identity* question ("is this person HR?"). It must not
-- answer true for an Admin, or an Admin would start appearing as HR in the
-- directory, the copilot and the org chart.
--
-- `is_hr_or_admin()` is the *privilege* question ("may this person exercise
-- org-wide authority?"). The RLS policies and the read-scope functions use it,
-- so Admin inherits HR's org-wide reach without impersonating HR.
--
-- The approval chain is deliberately NOT widened: `resolve_hr_approver` still
-- selects `app_role = 'hr'`, so a long leave still escalates to a human-resources
-- signatory rather than to an administrator. Admin powers stop at administering
-- the system, not at overriding a colleague's leave.
-- =============================================================================

-- =============================================================================
-- 1. Role ranking — the single source of truth for "at least this level"
-- =============================================================================
create or replace function public.role_rank(p_role public.app_role)
returns int
language sql
immutable
as $$
  select case p_role
    when 'admin'    then 4
    when 'hr'       then 3
    when 'manager'  then 2
    when 'employee' then 1
    else 0
  end;
$$;

-- True when the signed-in person holds at least the given level. A NULL floor
-- means "any signed-in employee", which is what self-service callers want.
create or replace function public.has_role_at_least(p_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_app_role() is not null
     and public.role_rank(public.current_app_role()) >= public.role_rank(p_role);
$$;

-- =============================================================================
-- 2. Admin identity and privilege
-- =============================================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_app_role() = 'admin', false);
$$;

-- Org-wide authority: HR's remit, which Admin inherits.
create or replace function public.is_hr_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_app_role() in ('hr', 'admin');
$$;

-- Same intent as `can_manage`, but phrased as a level so a new tier does not
-- mean another branch here. HR and Admin act org-wide, a manager only for their
-- own direct reports.
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

revoke execute on function public.role_rank(public.app_role) from public, anon;
revoke execute on function public.has_role_at_least(public.app_role) from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.can_administer(uuid) from public, anon, authenticated;

grant execute on function public.role_rank(public.app_role) to authenticated, service_role;
grant execute on function public.has_role_at_least(public.app_role) to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.can_administer(uuid) to service_role;

-- =============================================================================
-- 3. Directory reads: an Admin sees the full record, as HR does
-- =============================================================================
create or replace function public.get_employee_detail(p_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_employee_id() = e.id
      or public.is_hr_or_admin()
      or public.is_manager_of(e.id)
    then to_jsonb(e) - 'auth_user_id'
    else jsonb_build_object(
      'id',            e.id,
      'name',          e.name,
      'photo',         e.photo,
      'role',          e.role,
      'department',    e.department,
      'manager_id',    e.manager_id,
      'join_date',     e.join_date,
      'is_active',     e.is_active
    )
  end
  from public.employees e
  where e.id = p_employee_id
    and (e.is_active or public.is_hr_or_admin());
$$;

-- =============================================================================
-- 4. Policies: Admin inherits HR's write access to the directory
-- =============================================================================
drop policy if exists employees_select            on public.employees;
drop policy if exists employees_insert_hr         on public.employees;
drop policy if exists employees_update_hr         on public.employees;
drop policy if exists employees_update_own_or_hr   on public.employees;
drop policy if exists employees_delete_hr         on public.employees;

create policy employees_select on public.employees
  for select to authenticated
  using (is_active or public.is_hr_or_admin());

create policy employees_insert_hr on public.employees
  for insert to authenticated
  with check (public.is_hr_or_admin());

create policy employees_update_hr on public.employees
  for update to authenticated
  using (public.is_hr_or_admin())
  with check (public.is_hr_or_admin());

create policy employees_delete_hr on public.employees
  for delete to authenticated
  using (public.is_hr_or_admin());

-- Full-row read is needed to administer accounts. Without this an Admin cannot
-- read `app_role` or `auth_user_id` and so cannot manage roles.
grant select on public.employees to authenticated;

-- =============================================================================
-- 5. Alerts: an Admin may triage the whole queue
-- =============================================================================
drop policy if exists alerts_manage on public.alerts;

create policy alerts_manage on public.alerts
  for update to authenticated
  using (public.is_hr_or_admin())
  with check (public.is_hr_or_admin());

-- =============================================================================
-- 6. Department administration
--
-- Departments are currently a free-text column, so "manage departments" means
-- one source of truth for the valid set plus the ability to change the column
-- without leaving it to hand-edited strings.
-- =============================================================================
create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.departments is
  'Authoritative list of departments. employees.department references this by name.';

alter table public.departments enable row level security;

drop policy if exists departments_read   on public.departments;
drop policy if exists departments_write  on public.departments;

create policy departments_read on public.departments
  for select to authenticated
  using (is_active or public.is_hr_or_admin());

create policy departments_write on public.departments
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.departments to authenticated;
grant insert, update, delete on public.departments to authenticated;

-- Seed from whatever the existing employees already use, so adopting the table
-- never orphans a person.
insert into public.departments (name)
select distinct e.department
from public.employees e
where e.department is not null and btrim(e.department) <> ''
on conflict (name) do nothing;

-- =============================================================================
-- 7. Approval-hierarchy configuration
--
-- `required_approval_levels` is hardcoded in 0004b. Phase 14 asks an Admin to be
-- able to configure the hierarchy, so the thresholds become a table the function
-- reads. Defaults reproduce the shipped behaviour exactly.
-- =============================================================================
create table if not exists public.approval_policy (
  id                     boolean primary key default true,
  short_leave_max_days   numeric not null default 3,
  medium_leave_max_days  numeric not null default 7,
  require_hr_over_seven  boolean not null default true,
  updated_at             timestamptz not null default now(),
  constraint approval_policy_singleton check (id),
  constraint approval_policy_ordered check (short_leave_max_days < medium_leave_max_days)
);

comment on table public.approval_policy is
  'Singleton row holding the approval thresholds. Escalation: 1-<short> days -> manager, 1-<medium> -> manager + department head, above medium -> + HR.';

insert into public.approval_policy (id) values (true) on conflict (id) do nothing;

alter table public.approval_policy enable row level security;

drop policy if exists approval_policy_read  on public.approval_policy;
drop policy if exists approval_policy_write on public.approval_policy;

create policy approval_policy_read on public.approval_policy
  for select to authenticated
  using (true);

create policy approval_policy_write on public.approval_policy
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.approval_policy to authenticated;
grant insert, update, delete on public.approval_policy to authenticated;

create or replace function public.required_approval_levels(p_days numeric)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_short  numeric;
  v_medium numeric;
  v_hr     boolean;
begin
  select short_leave_max_days, medium_leave_max_days, require_hr_over_seven
  into v_short, v_medium, v_hr
  from public.approval_policy
  where id;

  -- Fall back to the shipped thresholds if the row is ever missing, so a bad
  -- delete cannot silently auto-approve every request.
  v_short  := coalesce(v_short, 3);
  v_medium := coalesce(v_medium, 7);
  v_hr     := coalesce(v_hr, true);

  return case
    when p_days > v_medium and v_hr     then 3
    when p_days > v_medium               then 2
    when p_days > v_short                then 2
    else 1
  end;
end;
$$;

grant execute on function public.required_approval_levels(numeric) to authenticated, service_role;

-- =============================================================================
-- 8. Admin: activate / deactivate an account
--
-- Deactivation is preferred to deletion: leaving rows in place keeps the
-- approval history and balance audit trail intact and honest.
-- =============================================================================
create or replace function public.admin_set_employee_active(
  p_employee_id uuid,
  p_is_active   boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_target  public.employees%rowtype;
  v_actor   uuid := public.current_employee_id();
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: only an administrator can change account status'
      using errcode = '42501';
  end if;

  select * into v_target from public.employees e where e.id = p_employee_id;
  if not found then
    raise exception 'NOT_FOUND: no employee with that id' using errcode = 'P0002';
  end if;

  -- Removing the last administrator would lock everyone out of administration.
  if v_target.app_role = 'admin' and not p_is_active then
    if (select count(*) from public.employees e
         where e.app_role = 'admin' and e.is_active and e.id <> p_employee_id) = 0 then
      raise exception 'VALIDATION: this is the last active administrator and cannot be deactivated'
        using errcode = '22023';
    end if;
  end if;

  update public.employees e
  set is_active = p_is_active
  where e.id = p_employee_id;

  return jsonb_build_object('ok', true, 'id', p_employee_id, 'is_active', p_is_active);
end;
$$;

grant execute on function public.admin_set_employee_active(uuid, boolean) to service_role;

-- =============================================================================
-- 9. Admin: change a person's role, department or reporting line
-- =============================================================================
create or replace function public.admin_update_employee(
  p_employee_id uuid,
  p_app_role     public.app_role default null,
  p_department  text         default null,
  p_manager_id  uuid         default null,
  p_job_title   text         default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_target public.employees%rowtype;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: only an administrator can change employee records'
      using errcode = '42501';
  end if;

  select * into v_target from public.employees e where e.id = p_employee_id;
  if not found then
    raise exception 'NOT_FOUND: no employee with that id' using errcode = 'P0002';
  end if;

  -- Never let the final active administrator demote themselves out of the role.
  if v_target.app_role = 'admin' and p_app_role is not null and p_app_role <> 'admin' then
    if (select count(*) from public.employees e
         where e.app_role = 'admin' and e.is_active and e.id <> p_employee_id) = 0 then
      raise exception 'VALIDATION: this is the last active administrator and cannot be demoted'
        using errcode = '22023';
    end if;
  end if;

  -- Self-reporting is rejected here; a longer cycle is rejected by the
  -- `prevent_manager_cycle` trigger armed in 0001, which fires on this update.
  if p_manager_id is not null and p_manager_id = p_employee_id then
    raise exception 'VALIDATION: an employee cannot report to themselves'
      using errcode = '22023';
  end if;

  if p_manager_id is not null then
    if not exists (select 1 from public.employees e
                    where e.id = p_manager_id and e.is_active) then
      raise exception 'VALIDATION: the chosen manager is not an active employee'
        using errcode = '22023';
    end if;
    if p_app_role = 'employee'
       and not exists (select 1 from public.employees e
                        where e.id = p_manager_id and e.app_role <> 'employee') then
      raise exception 'VALIDATION: a manager must hold the manager, HR or admin role'
        using errcode = '22023';
    end if;
  end if;

  update public.employees e
  set app_role    = coalesce(p_app_role, e.app_role),
      department  = coalesce(nullif(btrim(p_department), ''), e.department),
      manager_id  = coalesce(p_manager_id, e.manager_id),
      role        = coalesce(nullif(btrim(p_job_title), ''), e.role)
  where e.id = p_employee_id;

  return jsonb_build_object('ok', true, 'id', p_employee_id);
end;
$$;

grant execute on function public.admin_update_employee(uuid, public.app_role, text, uuid, text)
  to service_role;

-- =============================================================================
-- 10. Admin: system-wide activity log
--
-- Reads the AI audit trail, which employees cannot see, and counts live
-- workflows. Admin-only and service-role-executed from the API layer.
-- =============================================================================
create or replace function public.admin_activity_log(p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_audit jsonb;
  v_users jsonb;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: only an administrator can read the activity log'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb)
  into v_audit
  from (
    select a.id, a.employee_id, a.tool_name, a.arguments, a.success, a.error,
           a.duration_ms, a.created_at
    from public.ai_audit_log a
    order by a.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) t;

  select jsonb_build_object(
    'employees_total',   (select count(*) from public.employees e),
    'employees_active',  (select count(*) from public.employees e where e.is_active),
    'auth_accounts',     (select count(*) from public.employees e where e.auth_user_id is not null),
    'by_role', (
      select coalesce(jsonb_object_agg(e.app_role::text, e.n), '{}'::jsonb)
      from (select e.app_role, count(*) as n from public.employees e group by e.app_role) e
    ),
    'requests_pending',  (select count(*) from public.leave_requests r where r.status = 'pending'),
    'requests_blocked',  (select count(*) from public.leave_requests r where r.status = 'approval_blocked'),
    'approvals_open',    (select count(*) from public.leave_approval_steps s where s.status = 'pending'),
    'open_alerts',       (select count(*) from public.alerts a where not a.is_read)
  ) into v_users;

  return jsonb_build_object('ok', true, 'totals', v_users, 'ai_audit', v_audit);
end;
$$;

grant execute on function public.admin_activity_log(int) to service_role;

-- =============================================================================
-- 11. Re-grant HR-only surfaces to Admin
-- =============================================================================
-- Smart HR Query is already granted to `authenticated`; `assert_hr` in 0009 is
-- what enforces the role, and it now admits Admin as well as HR.
