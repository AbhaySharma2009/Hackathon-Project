-- =============================================================================
-- OrgFlow — 0009_hr_query_functions.sql
-- The fixed catalog behind Smart HR Query.
--
-- Rule 5: the model may choose a function and fill in its parameters, and
-- nothing else. There is no `query(text)` entry point, no string of SQL is ever
-- accepted, and no `execute` of caller-supplied SQL exists anywhere in this file.
-- Every function below takes typed parameters (dates, a department name, a
-- threshold, a row limit) and returns a table of a shape decided here.
--
-- These are SECURITY DEFINER so they can read across the whole organisation,
-- which is exactly why the role assertion inside each one is the control rather
-- than decoration. Every function repeats the same check:
--
--     the caller must have an active employee record whose app_role is 'hr',
--     otherwise SQLSTATE 42501.
--
-- Doing it in the database rather than only in the route is deliberate: a
-- crafted PostgREST call straight to /rest/rpc/q_count_on_leave with somebody
-- else's session is refused by the same code path as the API, so the rule holds
-- even when the route is bypassed. The route checks the role first too, so the
-- two agree and a non-HR request never reaches a model at all.
--
-- Named 0009 rather than 0007: 0007_insights.sql already exists in this project.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- assert_hr() -> void
--
-- The single authorisation gate, factored out so all seven functions cannot
-- drift apart. Raises 42501, which PostgREST and supabase-js both surface, and
-- which the API maps to FORBIDDEN.
--
-- Internal: not granted to any client role.
-- =============================================================================
create or replace function public.assert_hr()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role app_role;
begin
  select e.app_role
  into v_role
  from public.employees e
  where e.auth_user_id = auth.uid() and e.is_active
  limit 1;

  if v_role is null then
    raise exception 'FORBIDDEN: no active employee record for the current session'
      using errcode = '42501';
  end if;

  if v_role <> 'hr' then
    raise exception 'FORBIDDEN: Smart HR Query is limited to HR'
      using errcode = '42501';
  end if;
end;
$$;

-- =============================================================================
-- working_days_between(p_from, p_to) -> int
--
-- Rule 4 again: Mon–Fri inclusive, weekends excluded. Reused by the usage and
-- availability functions so "a day of leave" means one thing across the app
-- rather than being recomputed slightly differently in each report.
--
-- The range is assumed valid (from <= to); the callers clamp before calling.
-- =============================================================================
create or replace function public.working_days_between(p_from date, p_to date)
returns int
language sql
immutable
strict
as $$
  select count(*)::int
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g(d)
  where public.is_working_day(g.d::date)
$$;

-- =============================================================================
-- q_on_leave_between(p_from, p_to, p_department)
--
-- Who is on approved leave anywhere in [p_from, p_to].
--
-- Overlap, not containment: a request that started last month and ends next
-- week is on leave next week, so the test is start <= p_to and end >= p_from.
-- A person with two overlapping approved requests appears twice, because each
-- row is a request and the caller may want to see why.
--
-- Only `approved` counts. A pending request changes nothing until it is decided,
-- which is the same rule the Phase 6 calendar and dashboard already use.
-- =============================================================================
create or replace function public.q_on_leave_between(
  p_from       date,
  p_to         date,
  p_department text default null
)
returns table (
  employee      text,
  employee_id   uuid,
  department    text,
  leave_type    leave_type,
  start_date    date,
  end_date      date,
  days          numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_hr();

  return query
    select e.name, e.id, e.department, lr.leave_type, lr.start_date, lr.end_date, lr.days
    from public.leave_requests lr
    join public.employees e on e.id = lr.employee_id
    where lr.status = 'approved'
      and e.is_active
      and lr.start_date <= p_to
      and lr.end_date >= p_from
      and (p_department is null or e.department = p_department)
    order by lr.start_date, e.name;
end;
$$;

-- =============================================================================
-- q_count_on_leave(p_date, p_department)
--
-- Headcount away on a single day. Distinct per person, so two overlapping
-- approved requests for one person still count them once — unlike the row
-- listing above, which is per request on purpose.
-- =============================================================================
create or replace function public.q_count_on_leave(
  p_date       date,
  p_department text default null
)
returns table (
  on_leave_date date,
  department    text,
  headcount     int,
  names         text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_hr();

  -- Reported per department, so "how many in Engineering" and "how many in the
  -- whole company" are the same query with a different filter rather than two
  -- functions that can disagree.
  return query
    select
      p_date,
      e.department,
      count(distinct e.id)::int,
      coalesce(array_agg(e.name order by e.name), '{}'::text[])
    from public.employees e
    join public.leave_requests lr
      on lr.employee_id = e.id
     and lr.status = 'approved'
     and p_date between lr.start_date and lr.end_date
    where e.is_active
      and (p_department is null or e.department = p_department)
    group by e.department
    order by headcount desc, e.department;
end;
$$;

-- =============================================================================
-- q_leave_usage_by_department(p_from, p_to)
--
-- Leave days consumed per department over a window.
--
-- Days are counted inside the window and on working days only, so a request
-- that straddles the quarter boundary contributes only the days that fall in
-- it. Counting the stored `days` instead would overstate a window that cuts a
-- leave in half, and "this quarter" is exactly such a window.
-- =============================================================================
create or replace function public.q_leave_usage_by_department(
  p_from date,
  p_to   date
)
returns table (
  department     text,
  headcount      int,
  people_away    int,
  requests       int,
  leave_days     numeric,
  days_per_person numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_hr();

  return query
    with dept as (
      select e.department, count(*)::int as headcount
      from public.employees e
      where e.is_active
      group by e.department
    ),
    used as (
      select
        e.department,
        count(distinct lr.employee_id)::int as people_away,
        count(*)::int as requests,
        sum(
          public.working_days_between(
            greatest(lr.start_date, p_from),
            least(lr.end_date, p_to)
          )
        )::numeric as leave_days
      from public.leave_requests lr
      join public.employees e on e.id = lr.employee_id
      where lr.status = 'approved'
        and e.is_active
        and lr.start_date <= p_to
        and lr.end_date >= p_from
      group by e.department
    )
    -- The whole projection is wrapped and ordered on the outside. `leave_days` is
    -- an OUT parameter, so an unqualified `order by leave_days` in the same
    -- statement is ambiguous between the parameter and the column; a qualified
    -- `t.leave_days` is not, because PL/pgSQL only substitutes unqualified names.
    select
      t.department, t.headcount, t.people_away, t.requests, t.leave_days, t.days_per_person
    from (
      select
        d.department as department,
        d.headcount as headcount,
        coalesce(u.people_away, 0) as people_away,
        coalesce(u.requests, 0) as requests,
        coalesce(u.leave_days, 0) as leave_days,
        case
          when d.headcount = 0 then 0
          else round(coalesce(u.leave_days, 0) / d.headcount, 2)
        end as days_per_person
      from dept d
      left join used u on u.department = d.department
    ) t
    order by t.leave_days desc, t.department;
end;
$$;

-- =============================================================================
-- q_employees_low_balance(p_threshold, p_leave_type)
--
-- Active employees below a remaining-days threshold for the current year.
--
-- `unpaid` is excluded by default because it has no balance cap (stated in the
-- project assumptions), so a threshold against it is meaningless. Passing
-- leave_type = 'unpaid' explicitly returns nothing rather than a misleading
-- answer, since the caller asked for it.
-- =============================================================================
create or replace function public.q_employees_low_balance(
  p_threshold numeric,
  p_leave_type leave_type default null
)
returns table (
  employee    text,
  employee_id uuid,
  department  text,
  leave_type  leave_type,
  allocated   numeric,
  used        numeric,
  remaining   numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_hr();

  return query
    select e.name, e.id, e.department, lb.leave_type, lb.allocated, lb.used, lb.remaining
    from public.leave_balances lb
    join public.employees e on e.id = lb.employee_id
    where lb.year = extract(year from current_date)::int
      and e.is_active
      and lb.remaining < p_threshold
      and (p_leave_type is null or lb.leave_type = p_leave_type)
      and (
        p_leave_type is not null
        or lb.leave_type <> 'unpaid'
      )
    order by lb.remaining, e.name;
end;
$$;

-- =============================================================================
-- q_pending_approvals_count(p_department)
--
-- Requests still awaiting a decision, optionally scoped to a department.
-- =============================================================================
create or replace function public.q_pending_approvals_count(
  p_department text default null
)
returns table (
  department    text,
  pending_count int,
  oldest_days   int,
  names         text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_hr();

  return query
    select
      e.department,
      count(*)::int,
      max((current_date - lr.created_at::date))::int,
      coalesce(array_agg(e.name order by e.name), '{}'::text[])
    from public.leave_requests lr
    join public.employees e on e.id = lr.employee_id
    where lr.status = 'pending'
      and e.is_active
      and (p_department is null or e.department = p_department)
    group by e.department
    order by pending_count desc, e.department;
end;
$$;

-- =============================================================================
-- q_department_availability(p_from, p_to)
--
-- Per department, how much of the team is available across the window.
--
-- `avg_availability_pct` is the mean over working days; `lowest_availability_pct`
-- and `lowest_date` are the worst single working day and when it falls, which is
-- the figure a manager actually reacts to. A department with nobody on leave
-- across the whole window is 100% and has no low day, so lowest_date is null
-- rather than a misleading "the 1st".
-- =============================================================================
create or replace function public.q_department_availability(
  p_from date,
  p_to   date
)
returns table (
  department              text,
  headcount               int,
  avg_availability_pct    numeric,
  lowest_availability_pct numeric,
  lowest_date             date
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_hr();

  return query
    with scoped as (
      select e.id, e.department
      from public.employees e
      where e.is_active
    ),
    days as (
      select g.d::date as day
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g(d)
      where public.is_working_day(g.d::date)
    ),
    per_day as (
      select
        s.department,
        d.day,
        count(*)::int as headcount,
        count(a.employee_id)::int as away
      from scoped s
      cross join days d
      left join (
        select distinct lr.employee_id, g.d::date as day
        from public.leave_requests lr
        cross join lateral (
          select generate_series(
            lr.start_date::timestamp, lr.end_date::timestamp, interval '1 day'
          ) as d
        ) g
        where lr.status = 'approved'
      ) a on a.employee_id = s.id and a.day = d.day
      group by s.department, d.day
    ),
    scored as (
      -- Qualified throughout: `department` and `headcount` are OUT parameters of
      -- this function, so an unqualified reference to either would be ambiguous
      -- with the CTE's own column of the same name.
      select
        p.department as department,
        p.day as day,
        p.headcount as headcount,
        case
          when p.headcount = 0 then 100.0
          else round(((p.headcount - p.away) * 100.0 / p.headcount)::numeric, 1)
        end as pct
      from per_day p
    )
    -- As in q_leave_usage_by_department, the ordering happens on the outside of
    -- a derived table so the sort key is a qualified column reference.
    select
      t.department, t.headcount, t.avg_pct, t.lowest_pct, t.lowest_date
    from (
      select
        s.department as department,
        max(s.headcount)::int as headcount,
        round(avg(s.pct), 1) as avg_pct,
        min(s.pct) as lowest_pct,
        -- Null when the department was never short: "lowest on the 5th at 100%"
        -- is not a finding, it is an absence of one, and naming a date would
        -- dress it up as a problem.
        case
          when min(s.pct) < 100 then (array_agg(s.day order by s.pct asc, s.day asc))[1]
          else null
        end as lowest_date
      from scored s
      group by s.department
    ) t
    order by t.lowest_pct asc, t.department;
end;
$$;

-- =============================================================================
-- q_top_leave_takers(p_from, p_to, p_limit)
--
-- Who took the most leave in a window. Ranked by working days inside the
-- window, for the same reason the usage report does.
--
-- Ties are broken by name so the ordering is stable between calls and the
-- result can be asserted in a test.
-- =============================================================================
create or replace function public.q_top_leave_takers(
  p_from  date,
  p_to    date,
  p_limit int default 5
)
returns table (
  employee    text,
  employee_id uuid,
  department  text,
  requests    int,
  leave_days  numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_hr();

  return query
    select
      e.name,
      e.id,
      e.department,
      count(*)::int,
      sum(
        public.working_days_between(
          greatest(lr.start_date, p_from),
          least(lr.end_date, p_to)
        )
      )::numeric
    from public.leave_requests lr
    join public.employees e on e.id = lr.employee_id
    where lr.status = 'approved'
      and e.is_active
      and lr.start_date <= p_to
      and lr.end_date >= p_from
    group by e.name, e.id, e.department
    order by leave_days desc, e.name
    limit greatest(1, least(p_limit, 50));
end;
$$;

-- =============================================================================
-- Comments
-- =============================================================================
comment on function public.assert_hr() is
  'Raises SQLSTATE 42501 unless the caller is an active employee with app_role hr. Called by every q_* function; not exposed to clients.';

comment on function public.q_on_leave_between(date, date, text) is
  'Employees on approved leave overlapping a date range, one row per request, optionally filtered to a department. HR only (42501 otherwise).';

comment on function public.q_count_on_leave(date, text) is
  'Headcount away on a single date, grouped by department, distinct per person. HR only (42501 otherwise).';

comment on function public.q_leave_usage_by_department(date, date) is
  'Leave days consumed per department over a window, counting only working days inside the window. Includes departments with no leave as zero. HR only (42501 otherwise).';

comment on function public.q_employees_low_balance(numeric, leave_type) is
  'Active employees below a remaining-days threshold for the current year. Excludes unpaid leave unless it is explicitly requested. HR only (42501 otherwise).';

comment on function public.q_pending_approvals_count(text) is
  'Leave requests still awaiting a decision, grouped by department, with the oldest waiting age in days. HR only (42501 otherwise).';

comment on function public.q_department_availability(date, date) is
  'Per-department average and worst working-day availability over a window, with the date of the worst day. HR only (42501 otherwise).';

comment on function public.q_top_leave_takers(date, date, int) is
  'Employees ranked by leave days taken in a window, limited to 50 rows. HR only (42501 otherwise).';

-- =============================================================================
-- Grants
--
-- `assert_hr` and `working_days_between` are internal: the seven q_* functions
-- call them under SECURITY DEFINER, and a client calling them directly would
-- bypass nothing, but there is no reason to widen the surface.
--
-- The q_* functions are granted to `authenticated` rather than only to
-- `service_role` on purpose. The API calls them on the cookie-bound session
-- client, so the database performs the HR check for real. Granting them to the
-- service role alone would mean the route's own gate was the only thing standing
-- between a manager and org-wide data, because the service role bypasses it.
-- =============================================================================
revoke all on function public.assert_hr() from public, anon, authenticated;
revoke all on function public.working_days_between(date, date) from public, anon, authenticated;

revoke all on function public.q_on_leave_between(date, date, text) from public, anon;
revoke all on function public.q_count_on_leave(date, text) from public, anon;
revoke all on function public.q_leave_usage_by_department(date, date) from public, anon;
revoke all on function public.q_employees_low_balance(numeric, leave_type) from public, anon;
revoke all on function public.q_pending_approvals_count(text) from public, anon;
revoke all on function public.q_department_availability(date, date) from public, anon;
revoke all on function public.q_top_leave_takers(date, date, int) from public, anon;

grant execute on function public.assert_hr() to service_role;
grant execute on function public.working_days_between(date, date) to service_role;

grant execute on function public.q_on_leave_between(date, date, text) to authenticated, service_role;
grant execute on function public.q_count_on_leave(date, text) to authenticated, service_role;
grant execute on function public.q_leave_usage_by_department(date, date) to authenticated, service_role;
grant execute on function public.q_employees_low_balance(numeric, leave_type) to authenticated, service_role;
grant execute on function public.q_pending_approvals_count(text) to authenticated, service_role;
grant execute on function public.q_department_availability(date, date) to authenticated, service_role;
grant execute on function public.q_top_leave_takers(date, date, int) to authenticated, service_role;
