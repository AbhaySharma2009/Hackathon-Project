-- =============================================================================
-- OrgFlow — 0001_schema.sql
-- Foundation schema: enums, tables, indexes, constraints, triggers, RLS.
-- Idempotent: safe to re-run.
-- =============================================================================

-- btree_gist gives us `uuid WITH =` inside GiST exclusion constraints.
create extension if not exists btree_gist;

-- Make operator classes from both `public` and Supabase's `extensions` schema
-- resolvable in the DDL below (Supabase pre-installs extensions there).
set search_path = public, extensions;

-- =============================================================================
-- ENUMS
-- =============================================================================
do $$ begin
  create type public.leave_type as enum ('casual', 'sick', 'annual', 'unpaid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.app_role as enum ('employee', 'manager', 'hr');
exception when duplicate_object then null; end $$;

-- =============================================================================
-- TABLES
-- =============================================================================
create table if not exists public.employees (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  name          text        not null,
  email         text        not null unique,
  photo         text,
  -- `role` is the job designation; `app_role` is the OrgFlow permission level.
  role          text        not null default 'Employee',
  app_role      public.app_role not null default 'employee',
  department    text        not null,
  manager_id    uuid        references public.employees (id) on delete set null,
  join_date     date        not null default current_date,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  constraint employees_no_self_manager check (manager_id is null or manager_id <> id)
);

create table if not exists public.leave_requests (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid        not null references public.employees (id) on delete cascade,
  leave_type      public.leave_type   not null,
  start_date      date        not null,
  end_date        date        not null,
  -- Whole working days (Mon–Fri inclusive), always computed server-side.
  days            numeric(5,1) not null default 0,
  reason          text,
  status          public.leave_status not null default 'pending',
  manager_comment text,
  decided_by      uuid        references public.employees (id) on delete set null,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint leave_requests_dates_valid check (end_date >= start_date),
  constraint leave_requests_days_positive check (days > 0),
  -- A decided request must record who decided it and when.
  constraint leave_requests_decision_fields check (
    status = 'pending' or (decided_by is not null and decided_at is not null)
  )
);

create table if not exists public.leave_balances (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid        not null references public.employees (id) on delete cascade,
  year        int         not null,
  leave_type  public.leave_type not null,
  allocated   numeric(5,1) not null default 0,
  used        numeric(5,1) not null default 0,
  remaining   numeric(5,1) generated always as (allocated - used) stored,
  constraint leave_balances_unique unique (employee_id, year, leave_type),
  constraint leave_balances_non_negative check (allocated >= 0 and used >= 0 and used <= allocated)
);

create table if not exists public.alerts (
  id                uuid primary key default gen_random_uuid(),
  -- NULL scope = org-wide alert visible to everyone.
  scope_employee_id uuid        references public.employees (id) on delete cascade,
  type              text        not null,
  severity          text        not null default 'info',
  message           text        not null,
  related_date      date,
  created_at        timestamptz not null default now(),
  is_read           boolean     not null default false,
  constraint alerts_type_valid check (
    type in ('leave_approved','leave_rejected','leave_pending','balance_low','upcoming_leave','team_absent')
  ),
  constraint alerts_severity_valid check (severity in ('info','warning','critical'))
);

-- =============================================================================
-- WORKING-DAYS HELPER (rule 4: Mon–Fri inclusive, weekends excluded)
-- Rule 1: business rules live in Postgres so the UI and the AI cannot bypass them.
-- =============================================================================
create or replace function public.working_days(p_start date, p_end date)
returns integer
language sql
immutable
strict
as $$
  select count(*)::int
  from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') as g(d)
  where extract(isodow from g.d::date) < 6;
$$;

comment on function public.working_days(date, date) is
  'Working-day count between two dates inclusive, excluding Saturdays and Sundays.';

-- =============================================================================
-- INDEXES
-- =============================================================================
create index if not exists employees_manager_id_idx    on public.employees (manager_id);
create index if not exists employees_department_idx    on public.employees (department) where is_active;
create index if not exists employees_app_role_idx      on public.employees (app_role) where is_active;
create index if not exists employees_auth_user_id_idx  on public.employees (auth_user_id);

create index if not exists leave_requests_employee_status_idx
  on public.leave_requests (employee_id, status);
create index if not exists leave_requests_status_idx
  on public.leave_requests (status);
create index if not exists leave_requests_decided_by_idx
  on public.leave_requests (decided_by);

-- Date-range GiST index: drives overlap checks and calendar range scans.
create index if not exists leave_requests_date_range_gist_idx
  on public.leave_requests using gist (
    employee_id,
    daterange(start_date, end_date, '[]')
  );

create index if not exists leave_balances_employee_year_idx
  on public.leave_balances (employee_id, year);

create index if not exists alerts_scope_employee_idx on public.alerts (scope_employee_id, created_at desc);

-- =============================================================================
-- CONSTRAINT: no two APPROVED leaves for the same employee may overlap.
-- This is the database-level guarantee behind rule 3 — it fires even for raw SQL
-- inserts that bypass the application server.
-- =============================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leave_requests_no_overlap_approved'
  ) then
    alter table public.leave_requests
      add constraint leave_requests_no_overlap_approved
      exclude using gist (
        employee_id with =,
        daterange(start_date, end_date, '[]') with &&
      ) where (status = 'approved');
  end if;
end $$;

-- =============================================================================
-- TRIGGER: prevent manager cycles (A manages B manages A)
-- =============================================================================
create or replace function public.prevent_manager_cycle()
returns trigger
language plpgsql
as $$
declare
  cursor_manager uuid;
  depth         int := 0;
begin
  if new.manager_id is null then
    return new;
  end if;

  if new.manager_id = new.id then
    raise exception 'An employee cannot be their own manager (%)', new.id;
  end if;

  -- Walk up the reporting chain; if we come back to this employee it is a cycle.
  cursor_manager := new.manager_id;
  while cursor_manager is not null and depth < 100 loop
    if cursor_manager = new.id then
      raise exception 'Manager cycle detected: setting manager_id of % would create a loop', new.id;
    end if;
    depth := depth + 1;
    select e.manager_id into cursor_manager
    from public.employees e
    where e.id = cursor_manager;
  end loop;

  return new;
end;
$$;

drop trigger if exists employees_prevent_manager_cycle on public.employees;
create trigger employees_prevent_manager_cycle
  before insert or update of manager_id on public.employees
  for each row
  execute function public.prevent_manager_cycle();

-- =============================================================================
-- RLS helpers
-- SECURITY DEFINER so policies on `employees` can read the row for the current
-- user without recursing through the employees RLS policy.
-- =============================================================================
create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id from public.employees e
  where e.auth_user_id = auth.uid() and e.is_active
  limit 1;
$$;

create or replace function public.is_hr()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employees e
    where e.auth_user_id = auth.uid() and e.is_active and e.app_role = 'hr'
  );
$$;

-- TRUE when the caller is hr, or is the direct manager of `target` (managers are
-- employees too, so they also pass `current_employee_id` checks on their own rows).
create or replace function public.can_manage(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_hr() or exists (
    select 1 from public.employees e
    where e.id = target
      and e.auth_user_id = auth.uid()
      and e.is_active
      and e.app_role in ('manager', 'hr')
  );
$$;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================
alter table public.employees      enable row level security;
alter table public.leave_requests enable row level security;
alter table public.leave_balances enable row level security;
alter table public.alerts         enable row level security;

-- employees: directory is readable by any signed-in user; writes are own-row or hr.
drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees
  for select to authenticated
  using (is_active or public.is_hr());

drop policy if exists employees_insert_self on public.employees;
create policy employees_insert_self on public.employees
  for insert to authenticated
  with check (auth_user_id = auth.uid() or public.is_hr());

drop policy if exists employees_update_own_or_hr on public.employees;
create policy employees_update_own_or_hr on public.employees
  for update to authenticated
  using (auth_user_id = auth.uid() or public.is_hr())
  with check (auth_user_id = auth.uid() or public.is_hr());

-- leave_requests: own rows, direct reports (managers), everything (hr).
drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests
  for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or public.can_manage(employee_id)
  );

drop policy if exists leave_requests_insert_own on public.leave_requests;
create policy leave_requests_insert_own on public.leave_requests
  for insert to authenticated
  with check (employee_id = public.current_employee_id());

drop policy if exists leave_requests_update_manage on public.leave_requests;
create policy leave_requests_update_manage on public.leave_requests
  for update to authenticated
  using (public.can_manage(employee_id))
  with check (public.can_manage(employee_id));

-- leave_balances: own rows, direct reports, everything (hr).
drop policy if exists leave_balances_select on public.leave_balances;
create policy leave_balances_select on public.leave_balances
  for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or public.can_manage(employee_id)
  );

drop policy if exists leave_balances_write_hr on public.leave_balances;
create policy leave_balances_write_hr on public.leave_balances
  for all to authenticated
  using (public.is_hr())
  with check (public.is_hr());

-- alerts: own scoped alerts, org-wide alerts, and everything for hr.
drop policy if exists alerts_select on public.alerts;
create policy alerts_select on public.alerts
  for select to authenticated
  using (
    scope_employee_id is null
    or scope_employee_id = public.current_employee_id()
    or public.is_hr()
  );

drop policy if exists alerts_update_own on public.alerts;
create policy alerts_update_own on public.alerts
  for update to authenticated
  using (scope_employee_id is null or scope_employee_id = public.current_employee_id() or public.is_hr())
  with check (scope_employee_id is null or scope_employee_id = public.current_employee_id() or public.is_hr());

-- =============================================================================
-- GRANTS
-- =============================================================================
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant insert, update, delete on public.leave_requests to authenticated;
grant update on public.alerts to authenticated;
grant update on public.employees to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to authenticated, anon, service_role;
