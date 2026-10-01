-- =============================================================================
-- OrgFlow — 0006_analytics.sql
-- HR dashboard aggregates.
--
-- Rule 1: these numbers are computed in Postgres so the UI, the charts and any
-- later AI layer all read the same figures from one implementation. Nothing
-- here counts rows in JavaScript.
--
-- Design: one client-reachable entry point, `get_dashboard_summary()`, which is
-- SECURITY DEFINER and role-checked. The individual aggregate helpers take an
-- explicit employee-id array and are deliberately NOT granted to `authenticated`,
-- so the only way to read them is through the checked entry point. They are
-- SECURITY INVOKER, but that is safe: they are only ever reached from inside the
-- definer function, where the current user is already the function owner.
--
-- That indirection exists because scope has to be resolved *before* aggregating.
-- A manager sees their own team; HR sees the organisation. Filtering the output
-- of an org-wide aggregate would give a manager wrong totals, so the set of
-- employees is decided first and every metric is computed over just that set.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- Aggregate helpers. Each takes the already-resolved scope as an array of
-- employee ids. An empty array yields zeros rather than an error, which is what
-- a manager with no reports should see.
-- =============================================================================

-- Headcount, and headcount per department.
create or replace function public.dashboard_headcount_by_department(p_employees uuid[])
returns table (department text, headcount bigint)
language sql
stable
set search_path = public
as $$
  select e.department as department, count(*)::bigint as headcount
  from public.employees e
  where e.is_active and e.id = any (p_employees)
  group by e.department
  order by count(*) desc, e.department
$$;

-- Requests waiting on a decision, and how long the oldest has been waiting.
create or replace function public.dashboard_pending_approvals(p_employees uuid[])
returns table (pending_count bigint, oldest_pending_at timestamptz, oldest_pending_age_days int)
language sql
stable
set search_path = public
as $$
  select
    count(*)::bigint,
    min(lr.created_at),
    coalesce(
      (extract(epoch from (now() - min(lr.created_at))) / 86400)::int,
      0
    )
  from public.leave_requests lr
  where lr.status = 'pending' and lr.employee_id = any (p_employees)
$$;

-- Balance totals for the current year, by leave type and by department.
-- `unpaid` has no allocation by design, so it reports zeros rather than
-- distorting the average the KPI card shows.
create or replace function public.dashboard_leave_balances(p_employees uuid[])
returns table (
  bucket        text,
  leave_type    public.leave_type,
  allocated     numeric,
  used          numeric,
  remaining     numeric,
  people        bigint
)
language sql
stable
set search_path = public
as $$
  select
    e.department::text                                          as bucket,
    lb.leave_type,
    sum(lb.allocated)::numeric                                  as allocated,
    sum(lb.used)::numeric                                       as used,
    sum(lb.remaining)::numeric                                  as remaining,
    count(distinct lb.employee_id)::bigint                      as people
  from public.leave_balances lb
  join public.employees e on e.id = lb.employee_id
  where e.is_active
    and lb.employee_id = any (p_employees)
    and lb.year = extract(year from current_date)::int
  group by e.department, lb.leave_type

  union all

  -- One roll-up row per leave type across the whole scope, bucketed as
  -- 'ALL', so the chart has both a per-department and a total series.
  select
    'ALL'::text                                                 as bucket,
    lb.leave_type,
    sum(lb.allocated)::numeric                                  as allocated,
    sum(lb.used)::numeric                                       as used,
    sum(lb.remaining)::numeric                                  as remaining,
    count(distinct lb.employee_id)::bigint                      as people
  from public.leave_balances lb
  join public.employees e on e.id = lb.employee_id
  where e.is_active
    and lb.employee_id = any (p_employees)
    and lb.year = extract(year from current_date)::int
  group by lb.leave_type
$$;

-- Mean remaining balance per person, across every allocated leave type. This is
-- the "average remaining balance" KPI, so `unpaid` rows are excluded: including
-- them would drag a meaningless zero into the average.
create or replace function public.dashboard_average_remaining(p_employees uuid[])
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(round(avg(lb.remaining), 1), 0)::numeric
  from public.leave_balances lb
  join public.employees e on e.id = lb.employee_id
  where e.is_active
    and lb.employee_id = any (p_employees)
    and lb.year = extract(year from current_date)::int
    and lb.leave_type <> 'unpaid'
$$;

-- Who took the most approved leave this quarter.
create or replace function public.dashboard_top_leave_takers(
  p_employees    uuid[],
  p_quarter_start date
)
returns table (
  employee_id uuid,
  name        text,
  photo       text,
  department  text,
  days        numeric,
  requests    bigint
)
language sql
stable
set search_path = public
as $$
  select
    e.id,
    e.name,
    e.photo,
    e.department,
    sum(lr.days)::numeric as days,
    count(*)::bigint       as requests
  from public.leave_requests lr
  join public.employees e on e.id = lr.employee_id
  where lr.status = 'approved'
    and lr.employee_id = any (p_employees)
    -- Counted by the days that fall inside the quarter, not by the request's
    -- start date, so leave begun last quarter but taken now still counts.
    and lr.end_date >= p_quarter_start
    and lr.start_date <= (p_quarter_start + interval '3 months - 1 day')::date
  group by e.id, e.name, e.photo, e.department
  order by days desc, e.name
  limit 5
$$;

-- The last few submitted/decided requests, newest first, with whoever acted.
create or replace function public.dashboard_recent_activity(
  p_employees uuid[],
  p_limit     int default 10
)
returns table (
  id             uuid,
  event          text,
  employee_id    uuid,
  employee_name  text,
  employee_photo text,
  department     text,
  leave_type     public.leave_type,
  start_date     date,
  end_date       date,
  days           numeric,
  status         public.leave_status,
  actor_name     text,
  decided_at     timestamptz,
  created_at     timestamptz,
  occurred_at    timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    lr.id,
    case
      when lr.status = 'pending' then 'submitted'
      when lr.decided_at is not null then lr.status::text
      else 'submitted'
    end                                          as event,
    lr.employee_id,
    e.name                                       as employee_name,
    e.photo                                      as employee_photo,
    e.department,
    lr.leave_type,
    lr.start_date,
    lr.end_date,
    lr.days,
    lr.status,
    coalesce(actor.name, '—')                    as actor_name,
    lr.decided_at,
    lr.created_at,
    -- A decision is the moment of the story, so it sorts above the submission
    -- it answers; a still-pending request is stamped with its creation.
    coalesce(lr.decided_at, lr.created_at)       as occurred_at
  from public.leave_requests lr
  join public.employees e on e.id = lr.employee_id
  left join public.employees actor on actor.id = lr.decided_by
  where lr.employee_id = any (p_employees)
    and lr.status <> 'cancelled'
  order by occurred_at desc, lr.id
  limit greatest(p_limit, 0)
$$;

-- Per-department availability for right now.
create or replace function public.dashboard_department_workforce(p_employees uuid[])
returns table (
  department       text,
  headcount        bigint,
  on_leave_today   bigint,
  available_today  bigint,
  availability_pct numeric,
  pending_requests bigint
)
language sql
stable
set search_path = public
as $$
  with scoped as (
    select e.id, e.department
    from public.employees e
    where e.is_active and e.id = any (p_employees)
  ),
  away as (
    -- An employee on more than one overlapping approved request is still one
    -- person away, so this counts distinct employees rather than requests.
    select distinct s.department, s.id
    from scoped s
    join public.leave_requests lr on lr.employee_id = s.id
    where lr.status = 'approved'
      and current_date between lr.start_date and lr.end_date
  ),
  waiting as (
    select s.department, count(*)::bigint as pending
    from scoped s
    join public.leave_requests lr on lr.employee_id = s.id
    where lr.status = 'pending'
    group by s.department
  ),
  counts as (
    select
      s.department,
      count(*)::bigint                                        as headcount,
      count(a.id)::bigint                                     as on_leave_today,
      (select coalesce(w.pending, 0) from waiting w
        where w.department = s.department)::bigint            as pending_requests
    from scoped s
    left join away a on a.id = s.id and a.department = s.department
    group by s.department
  )
  select
    c.department,
    c.headcount,
    c.on_leave_today,
    (c.headcount - c.on_leave_today)::bigint as available_today,
    -- A department with nobody in it is 100% available, not a divide by zero.
    case
      when c.headcount = 0 then 100.0
      else round(((c.headcount - c.on_leave_today) * 100.0 / c.headcount)::numeric, 1)
    end                    as availability_pct,
    c.pending_requests
  from counts c
  order by c.department
$$;

-- =============================================================================
-- get_dashboard_summary() -> jsonb
--
-- The single entry point the dashboard reads, returning every figure in one
-- payload so the page cannot show a half-updated mix of old and new numbers.
--
-- Authorisation, decided here and not in the UI (rule: role checks are
-- server-side and in the database):
--   hr      -> the whole organisation
--   manager -> their direct reports plus themselves ("a reduced version for
--              their team"), flagged with org_wide = false so the UI can say so
--   anyone else -> error 42501, which the route maps to FORBIDDEN
--
-- The scope is derived from auth.uid() alone; it is never a parameter.
-- =============================================================================
create or replace function public.get_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_viewer    record;
  v_scope     uuid[];
  v_org_wide  boolean;
  v_quarter   date;
  v_summary   jsonb;
begin
  select e.id, e.app_role
  into v_viewer
  from public.employees e
  where e.auth_user_id = auth.uid() and e.is_active
  limit 1;

  if v_viewer is null then
    -- 42501 is PostgreSQL's insufficient_privilege; the route turns it into
    -- the standard FORBIDDEN body.
    raise exception 'FORBIDDEN: no active employee for the current session'
      using errcode = '42501';
  end if;

  -- Admin inherits HR's org-wide read scope.
  if v_viewer.app_role in ('hr', 'admin') then
    v_org_wide := true;
    select coalesce(array_agg(e.id), '{}'::uuid[])
    into v_scope
    from public.employees e
    where e.is_active;

  elsif v_viewer.app_role = 'manager' then
    v_org_wide := false;
    -- The same team definition the calendar uses: direct reports plus self.
    select coalesce(array_agg(e.id), '{}'::uuid[])
    into v_scope
    from public.employees e
    where e.is_active
      and (e.id = v_viewer.id or e.manager_id = v_viewer.id);

  else
    raise exception 'FORBIDDEN: the dashboard is available to HR and managers only'
      using errcode = '42501';
  end if;

  v_quarter := date_trunc('quarter', current_date)::date;

  select jsonb_build_object(
    'scope', jsonb_build_object(
      'app_role', v_viewer.app_role,
      'org_wide', v_org_wide,
      'employee_count', cardinality(v_scope)
    ),
    'generated_at', now(),

    'kpis', jsonb_build_object(
      'headcount_total', (
        select coalesce(sum(h.headcount), 0)::bigint
        from public.dashboard_headcount_by_department(v_scope) h
      ),
      'on_leave_today', (
        select coalesce(sum(w.on_leave_today), 0)::bigint
        from public.dashboard_department_workforce(v_scope) w
      ),
      'pending_approvals', (
        select p.pending_count from public.dashboard_pending_approvals(v_scope) p
      ),
      'oldest_pending_age_days', (
        select p.oldest_pending_age_days from public.dashboard_pending_approvals(v_scope) p
      ),
      'average_remaining_balance', public.dashboard_average_remaining(v_scope)
    ),

    'headcount_by_department', coalesce(
      (select jsonb_agg(to_jsonb(h) order by to_jsonb(h)->>'department')
         from public.dashboard_headcount_by_department(v_scope) h),
      '[]'::jsonb
    ),

    'leave_balance_by_type', coalesce(
      (select jsonb_agg(to_jsonb(b) order by b.leave_type)
         from public.dashboard_leave_balances(v_scope) b
        where b.bucket = 'ALL'),
      '[]'::jsonb
    ),

    'leave_balance_by_department', coalesce(
      (select jsonb_agg(to_jsonb(b) order by b.bucket, b.leave_type)
         from public.dashboard_leave_balances(v_scope) b
        where b.bucket <> 'ALL'),
      '[]'::jsonb
    ),

    'top_leave_takers', coalesce(
      (select jsonb_agg(to_jsonb(t))
         from public.dashboard_top_leave_takers(v_scope, v_quarter) t),
      '[]'::jsonb
    ),

    'recent_activity', coalesce(
      (select jsonb_agg(to_jsonb(a))
         from public.dashboard_recent_activity(v_scope, 10) a),
      '[]'::jsonb
    ),

    'department_workforce', coalesce(
      (select jsonb_agg(to_jsonb(w) order by w.department)
         from public.dashboard_department_workforce(v_scope) w),
      '[]'::jsonb
    ),

    'quarter', jsonb_build_object(
      'start', v_quarter,
      -- `Q` is a to_char pattern (the quarter number), so the label is built by
      -- concatenation instead of a single format string.
      'label', to_char(v_quarter, 'YYYY') || ' Q' || extract(quarter from v_quarter)::int
    )
  )
  into v_summary;

  return v_summary;
end;
$$;

comment on function public.get_dashboard_summary() is
  'Every HR dashboard figure in one payload. Org-wide for hr, direct reports plus self for a manager; raises 42501 for anyone else.';

-- The helpers are internal. Without this an employee could call
-- `dashboard_headcount_by_department(array[])` for an arbitrary list of ids and
-- read the numbers straight out of Postgres, bypassing the role check above.
revoke all on function public.dashboard_headcount_by_department(uuid[]) from public, anon, authenticated;
revoke all on function public.dashboard_pending_approvals(uuid[]) from public, anon, authenticated;
revoke all on function public.dashboard_leave_balances(uuid[]) from public, anon, authenticated;
revoke all on function public.dashboard_average_remaining(uuid[]) from public, anon, authenticated;
revoke all on function public.dashboard_top_leave_takers(uuid[], date) from public, anon, authenticated;
revoke all on function public.dashboard_recent_activity(uuid[], int) from public, anon, authenticated;
revoke all on function public.dashboard_department_workforce(uuid[]) from public, anon, authenticated;

grant execute on function public.get_dashboard_summary() to authenticated, service_role;
