-- =============================================================================
-- 0015_admin_actor.sql
--
-- Makes the `admin_*` functions callable from the service role.
--
-- ## The problem
--
-- Each `admin_*` function guards itself with `if not public.is_admin()`. That is
-- the right guard for a call made with the caller's own session token — and it is
-- what stopped an employee reaching them during verification.
--
-- But the API layer has to call these with the *service role* key, because they
-- return `email`, `app_role` and the AI audit trail, which are deliberately not
-- granted to browser sessions (see 0013). A service-role connection carries no
-- user session, so `current_employee_id()` is null, `is_admin()` is false, and
-- every administrator request failed with FORBIDDEN.
--
-- ## The fix
--
-- The acting employee is passed explicitly and checked against the `employees`
-- table, which the service role can read. The route derives that id from the
-- verified session cookie, so it cannot be supplied by the client.
--
-- This is not a weaker check than before. The previous guard could only be
-- satisfied by a session that was already an admin; this one verifies the same
-- fact about the same id, and the caller must hold the service-role key either
-- way — which no browser can do.
-- =============================================================================

-- Resolves the acting employee and refuses anything that is not an administrator.
--
-- Replaced outright: the first draft of this migration carried a `designation`
-- argument and read a column that does not exist on `employees`.
create or replace function public.assert_admin_actor(p_actor uuid)
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

  if v_role <> 'admin' then
    raise exception 'FORBIDDEN: only an administrator may perform this action'
      using errcode = '42501';
  end if;

  return p_actor;
end;
$$;

revoke execute on function public.assert_admin_actor(uuid) from public;
grant execute on function public.assert_admin_actor(uuid) to service_role;

-- ---------------------------------------------------------------- admin_list
create or replace function public.admin_list_employees(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_admin_actor(p_actor);

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'email', e.email,
          'name', e.name,
          'photo', e.photo,
          'app_role', e.app_role,
          'department', e.department,
          'manager_id', e.manager_id,
          'role', e.role,
          'join_date', e.join_date,
          'is_active', e.is_active
        ) order by e.name
      )
      from public.employees e
    ),
    '[]'::jsonb
  );
end;
$$;

revoke execute on function public.admin_list_employees(uuid) from public;
grant execute on function public.admin_list_employees(uuid) to service_role;

-- ------------------------------------------------------------ admin_activity
create or replace function public.admin_activity_log(p_actor uuid, p_limit int default 50)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_users jsonb;
  v_audit jsonb;
begin
  perform public.assert_admin_actor(p_actor);

  select jsonb_build_object(
    'employees_total',   (select count(*) from public.employees e),
    'employees_active',  (select count(*) from public.employees e where e.is_active),
    'auth_accounts',     (select count(*) from auth.users),
    'by_role', (
      select coalesce(jsonb_object_agg(e.app_role::text, e.n), '{}'::jsonb)
      from (select e.app_role, count(*) as n from public.employees e group by e.app_role) e
    ),
    'requests_pending',  (select count(*) from public.leave_requests r where r.status = 'pending'),
    'requests_blocked',  (select count(*) from public.leave_requests r where r.status = 'approval_blocked'),
    'approvals_open',    (select count(*) from public.leave_approval_steps s where s.status = 'pending'),
    'open_alerts',       (select count(*) from public.alerts a where not a.is_read)
  ) into v_users;

  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb)
  into v_audit
  from (
    select a.id, a.created_at, a.tool_name, a.success, a.error, a.duration_ms, a.arguments
    from public.ai_audit_log a
    order by a.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 500))
  ) t;

  return jsonb_build_object('ok', true, 'totals', v_users, 'ai_audit', v_audit);
end;
$$;

revoke execute on function public.admin_activity_log(uuid, int) from public;
grant execute on function public.admin_activity_log(uuid, int) to service_role;

-- ------------------------------------------------------- admin_update_employee
create or replace function public.admin_update_employee(
  p_actor       uuid,
  p_employee_id uuid,
  p_app_role    public.app_role default null,
  p_department  text           default null,
  p_manager_id  uuid           default null,
  p_job_title   text           default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_target   public.employees%rowtype;
  v_new_dept text;
  v_new_role public.app_role;
begin
  perform public.assert_admin_actor(p_actor);

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

  if p_manager_id is not null and p_manager_id = p_employee_id then
    raise exception 'VALIDATION: an employee cannot report to themselves'
      using errcode = '22023';
  end if;

  v_new_role := coalesce(p_app_role, v_target.app_role);
  v_new_dept := coalesce(nullif(btrim(p_department), ''), v_target.department);

  -- Checked against the role the update actually leaves behind, so omitting
  -- `p_app_role` cannot be used to appoint a plain employee as a manager.
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

revoke execute on function public.admin_update_employee(uuid, uuid, public.app_role, text, uuid, text)
  from public;
grant execute on function public.admin_update_employee(uuid, uuid, public.app_role, text, uuid, text)
  to service_role;

-- --------------------------------------------------- admin_set_employee_active
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
  perform public.assert_admin_actor(p_actor);

  if not exists (select 1 from public.employees e where e.id = p_employee_id) then
    raise exception 'NOT_FOUND: no employee with that id' using errcode = 'P0002';
  end if;

  -- Deactivating the last active administrator would leave nobody able to undo it.
  if not p_is_active
     and exists (select 1 from public.employees e
                  where e.id = p_employee_id and e.app_role = 'admin' and e.is_active)
     and (select count(*) from public.employees e
           where e.app_role = 'admin' and e.is_active and e.id <> p_employee_id) = 0 then
    raise exception 'VALIDATION: this is the last active administrator and cannot be deactivated'
      using errcode = '22023';
  end if;

  update public.employees e set is_active = p_is_active where e.id = p_employee_id;

  -- An inactive employee must not keep resolving to a session.
  if not p_is_active then
    update public.leave_approval_steps s
    set status = 'skipped'
    where s.approver_employee_id = p_employee_id and s.status = 'pending';
  end if;

  return jsonb_build_object('ok', true, 'id', p_employee_id, 'is_active', p_is_active);
end;
$$;

revoke execute on function public.admin_set_employee_active(uuid, uuid, boolean) from public;
grant execute on function public.admin_set_employee_active(uuid, uuid, boolean) to service_role;

-- ------------------------------------------------------- admin_create_employee
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
  perform public.assert_admin_actor(p_actor);

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

  -- `employees.department` is NOT NULL, so somebody has to be filed somewhere.
  -- Rather than forcing an administrator to create a department before they can
  -- hire anyone, an unfiled person goes to "Unassigned", which is created here.
  -- A department the *caller* named must already exist — silently inventing one
  -- would hide a typo behind a person quietly landing in the wrong place.
  if v_dept is null then
    v_dept := 'Unassigned';
    insert into public.departments (name) values (v_dept) on conflict do nothing;
  elsif not exists (select 1 from public.departments d where d.name = v_dept) then
    raise exception 'VALIDATION: unknown department "%" — create it under Departments first', v_dept
      using errcode = '22023';
  end if;

  v_manager := nullif(p_manager_id, p_employee_id);

  if v_manager is not null then
    if not exists (select 1 from public.employees e where e.id = v_manager and e.is_active) then
      raise exception 'VALIDATION: the chosen manager is not an active employee'
        using errcode = '22023';
    end if;
    if coalesce(p_app_role, 'employee') = 'employee'
       and not exists (select 1 from public.employees e
                        where e.id = v_manager and e.app_role <> 'employee') then
      raise exception 'VALIDATION: a manager must hold the manager, HR or admin role'
        using errcode = '22023';
    end if;
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

  -- A new starter gets this year's allocation across the leave types, so they are
  -- not left unable to request anything. These are the baseline entitlements the
  -- demo seed uses; an admin can raise them afterwards from the balances UI.
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

-- The earlier draft took a `designation` argument, which never existed as a
-- column: `employees.role` already holds the job title.
drop function if exists public.admin_create_employee(
  uuid, uuid, text, text, public.app_role, text, uuid, text, text);

revoke execute on function public.admin_create_employee(
  uuid, uuid, text, text, public.app_role, text, uuid, text) from public;
grant execute on function public.admin_create_employee(
  uuid, uuid, text, text, public.app_role, text, uuid, text) to service_role;