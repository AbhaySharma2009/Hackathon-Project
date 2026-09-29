-- =============================================================================
-- OrgFlow — 0002_rls.sql
-- Row Level Security hardening + column-level access control.
--
-- 0001 enabled RLS with a first-pass policy set. This migration replaces it with
-- the rules this app actually needs:
--   * column-level grants on `employees` so a signed-in browser session can only
--     read directory fields, never `email`, `app_role` or `auth_user_id`;
--   * privileged reads (your own full row, someone else's full row) go through
--     SECURITY DEFINER RPCs that make the authorisation decision in the database.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- 1. Drop the 0001 policies (a policy can be replaced outright with DROP+CREATE)
-- =============================================================================
drop policy if exists employees_select            on public.employees;
drop policy if exists employees_insert_self       on public.employees;
drop policy if exists employees_update_own_or_hr  on public.employees;
drop policy if exists employees_insert_hr         on public.employees;
drop policy if exists employees_update_hr         on public.employees;
drop policy if exists employees_delete_hr         on public.employees;
drop policy if exists leave_requests_select       on public.leave_requests;
drop policy if exists leave_requests_insert_own   on public.leave_requests;
drop policy if exists leave_requests_update_manage on public.leave_requests;
drop policy if exists leave_requests_insert_own_pending on public.leave_requests;
drop policy if exists leave_balances_select       on public.leave_balances;
drop policy if exists leave_balances_write_hr     on public.leave_balances;
drop policy if exists alerts_select               on public.alerts;
drop policy if exists alerts_update_own           on public.alerts;

-- =============================================================================
-- 2. Helper functions
--    SECURITY DEFINER so a policy on `employees` can resolve the caller without
--    recursing through the employees policy itself. All are STABLE so the planner
--    can evaluate them once per statement.
-- =============================================================================
drop function if exists public.can_manage(uuid);

create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id
  from public.employees e
  where e.auth_user_id = auth.uid()
    and e.is_active
  limit 1;
$$;

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select e.app_role
  from public.employees e
  where e.auth_user_id = auth.uid()
    and e.is_active
  limit 1;
$$;

-- Direct reports only: TRUE when `p_employee_id` reports to the caller.
create or replace function public.is_manager_of(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.employees e
    where e.id = p_employee_id
      and e.manager_id = public.current_employee_id()
      and e.is_active
  );
$$;

create or replace function public.is_hr()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_app_role() = 'hr', false);
$$;

-- Can the caller administer this employee's leave records? HR acts org-wide,
-- a manager only for their direct reports.
create or replace function public.can_manage(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_hr() or public.is_manager_of(p_employee_id);
$$;

-- =============================================================================
-- 3. Privileged read RPCs
-- =============================================================================

-- Your own employee row, in full. Used by getCurrentEmployee() on every request.
create or replace function public.current_employee()
returns public.employees
language sql
stable
security definer
set search_path = public
as $$
  select e.*
  from public.employees e
  where e.auth_user_id = auth.uid()
    and e.is_active
  limit 1;
$$;

-- One employee, with exactly as much detail as the caller is entitled to:
--   full record  -> self, HR, or the person's own manager
--   directory-only -> everyone else
-- `auth_user_id` is never returned to anyone.
create or replace function public.get_employee_detail(p_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_employee_id() = e.id
      or public.current_app_role() = 'hr'
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
    -- SECURITY DEFINER bypasses RLS, so visibility is enforced here instead:
    -- deactivated accounts stay hidden from everyone except HR.
    and (e.is_active or public.current_app_role() = 'hr');
$$;

-- =============================================================================
-- 4. Row policies
-- =============================================================================

-- ---- employees ---------------------------------------------------------------
-- Directory rows are readable by any signed-in user; inactive accounts are only
-- visible to HR so they can manage them.
create policy employees_select on public.employees
  for select to authenticated
  using (is_active or public.current_app_role() = 'hr');

create policy employees_insert_hr on public.employees
  for insert to authenticated
  with check (public.current_app_role() = 'hr');

create policy employees_update_hr on public.employees
  for update to authenticated
  using (public.current_app_role() = 'hr')
  with check (public.current_app_role() = 'hr');

create policy employees_delete_hr on public.employees
  for delete to authenticated
  using (public.current_app_role() = 'hr');

-- ---- leave_requests ---------------------------------------------------------
-- Readable by the owner, their manager, and HR. Insertable only as yourself and
-- only in the 'pending' state. There is deliberately NO update/delete policy:
-- approving, rejecting and cancelling happen through audited RPCs, never by
-- writing the row directly.
create policy leave_requests_select on public.leave_requests
  for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or public.can_manage(employee_id)
  );

create policy leave_requests_insert_own_pending on public.leave_requests
  for insert to authenticated
  with check (
    employee_id = public.current_employee_id()
    and status = 'pending'
  );

-- ---- leave_balances ---------------------------------------------------------
-- Read-only ledger. All mutations go through the transactional RPCs so a balance
-- can never drift away from the approved requests that consumed it.
create policy leave_balances_select on public.leave_balances
  for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or public.can_manage(employee_id)
  );

-- ---- alerts -----------------------------------------------------------------
-- Org-wide alerts (scope_employee_id IS NULL) plus your own; HR sees everything.
create policy alerts_select on public.alerts
  for select to authenticated
  using (
    scope_employee_id is null
    or scope_employee_id = public.current_employee_id()
    or public.is_hr()
  );

create policy alerts_update_own on public.alerts
  for update to authenticated
  using (
    scope_employee_id is null
    or scope_employee_id = public.current_employee_id()
    or public.is_hr()
  )
  with check (
    scope_employee_id is null
    or scope_employee_id = public.current_employee_id()
    or public.is_hr()
  );

-- =============================================================================
-- 5. Privileges
--    Column-level SELECT on `employees` is the "basic directory fields" rule:
--    a browser session physically cannot read email, app_role or auth_user_id.
-- =============================================================================
revoke all on public.employees from anon, authenticated;
grant select (
  id, name, photo, role, department, manager_id, join_date, is_active
) on public.employees to authenticated;
grant insert, update, delete on public.employees to authenticated;

revoke all on public.leave_requests from anon;
grant select, insert on public.leave_requests to authenticated;

revoke all on public.leave_balances from anon;
grant select on public.leave_balances to authenticated;

revoke all on public.alerts from anon;
grant select, update on public.alerts to authenticated;

-- Service role keeps full table access (it is only reachable from server code).
grant all on all tables in schema public to service_role;

grant execute on all functions in schema public to anon, authenticated, service_role;
