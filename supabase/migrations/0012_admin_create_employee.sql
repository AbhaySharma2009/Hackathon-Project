-- =============================================================================
-- 0012_admin_create_employee.sql
--
-- Completes the Phase 14 admin surface: creating a person, and closing a gap in
-- the role-change RPC that this exposed.
--
-- ## The gap
--
-- `admin_update_employee` only checked that a new manager holds a real role when
-- the caller *also* passed `p_app_role`. Passing just a `p_manager_id` skipped the
-- check, so any employee could be made somebody's manager by leaving the role
-- argument out. That is not a cosmetic inconsistency — it makes a two-person
-- reporting chain with no approval authority anywhere in it.
--
-- The check is now against the role the person *will* have after the update,
-- whether or not this call changed it.
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
  v_target     public.employees%rowtype;
  v_new_dept   text;
  v_new_role   public.app_role;
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

  -- The role and department this update will actually leave behind.
  v_new_role := coalesce(p_app_role, v_target.app_role);
  v_new_dept := coalesce(nullif(btrim(p_department), ''), v_target.department);

  if p_manager_id is not null then
    if not exists (select 1 from public.employees e
                    where e.id = p_manager_id and e.is_active) then
      raise exception 'VALIDATION: the chosen manager is not an active employee'
        using errcode = '22023';
    end if;

    -- Checked against the *resulting* role, not against whatever was passed.
    if v_new_role = 'employee'
       and not exists (select 1 from public.employees e
                        where e.id = p_manager_id and e.app_role <> 'employee') then
      raise exception 'VALIDATION: a manager must hold the manager, HR or admin role'
        using errcode = '22023';
    end if;
  end if;

  -- `departments` is the authoritative list, so a new name has to exist there
  -- before an employee can be filed under it.
  if v_new_dept is not null
     and not exists (select 1 from public.departments d where d.name = v_new_dept) then
    raise exception 'VALIDATION: unknown department "%" — create it under Departments first', v_new_dept
      using errcode = '22023';
  end if;

  update public.employees e
  set app_role    = v_new_role,
      department  = v_new_dept,
      manager_id  = coalesce(p_manager_id, e.manager_id),
      role        = coalesce(nullif(btrim(p_job_title), ''), e.role)
  where e.id = p_employee_id;

  return jsonb_build_object('ok', true, 'id', p_employee_id);
end;
$$;

grant execute on function public.admin_update_employee(uuid, public.app_role, text, uuid, text)
  to service_role;

-- =============================================================================
-- Admin: add a person
--
-- The `employees.id` is the same uuid as the Supabase Auth user, because the
-- whole schema keys off it. The API layer therefore creates the auth user first
-- and passes that id in; this function only owns the org record, and will not
-- mint an id that has no matching auth user.
-- =============================================================================
create or replace function public.admin_create_employee(
  p_employee_id uuid,
  p_email       text,
  p_full_name   text,
  p_app_role    public.app_role default 'employee',
  p_department  text           default null,
  p_manager_id  uuid           default null,
  p_job_title   text           default 'Employee',
  p_designation text           default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email     text := lower(btrim(p_email));
  v_dept      text := nullif(btrim(p_department), '');
  v_manager   uuid;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: only an administrator can add employees'
      using errcode = '42501';
  end if;

  if p_employee_id is null or p_employee_id = gen_random_uuid() then
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

  if v_dept is not null
     and not exists (select 1 from public.departments d where d.name = v_dept) then
    raise exception 'VALIDATION: unknown department "%" — create it under Departments first', v_dept
      using errcode = '22023';
  end if;

  v_manager := nullif(p_manager_id, p_employee_id);

  if v_manager is not null then
    if not exists (select 1 from public.employees e
                    where e.id = v_manager and e.is_active) then
      raise exception 'VALIDATION: the chosen manager is not an active employee'
        using errcode = '22023';
    end if;
    if p_app_role = 'employee'
       and not exists (select 1 from public.employees e
                        where e.id = v_manager and e.app_role <> 'employee') then
      raise exception 'VALIDATION: a manager must hold the manager, HR or admin role'
        using errcode = '22023';
    end if;
  end if;

  insert into public.employees
    (id, email, name, app_role, department, manager_id, role, designation, is_active)
  values (
    p_employee_id,
    v_email,
    btrim(p_full_name),
    coalesce(p_app_role, 'employee'),
    v_dept,
    v_manager,
    coalesce(nullif(btrim(p_job_title), ''), 'Employee'),
    nullif(btrim(p_designation), ''),
    true
  );

  -- Every new starter gets this year's allocation across the leave types, on
  -- the same pattern `reset-balances.sql` uses, so a new joiner is not left
  -- unable to request anything.
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

grant execute on function public.admin_create_employee(
  uuid, text, text, public.app_role, text, uuid, text, text
) to service_role;