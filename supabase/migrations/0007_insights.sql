-- =============================================================================
-- OrgFlow — 0007_insights.sql
-- Workforce intelligence. Deterministic rules only; no model is involved, so
-- every number below is reproducible and can be asserted in a test.
--
-- Rule 1: these are business rules, so they live in Postgres. The UI renders
-- what these functions return and never recomputes a ratio itself.
--
-- The one judgement call worth stating up front: "the team" means the whole
-- reporting line — the manager plus their direct reports. That matches how the
-- calendar and the Phase 5 dashboard already scope a team, and it counts the
-- manager as available capacity, which is who actually covers. So for Sanjay
-- Kapoor the team is 4 (Sanjay, Neha, Karthik, Priya).
--
-- Only `approved` leave counts as "on leave". A pending request changes nothing
-- until it is decided, otherwise a manager would see phantom risk for requests
-- they are about to reject. The single exception is get_leave_impact, which
-- deliberately assumes the request under review is granted — otherwise it would
-- answer "what changes if I approve this?" with the figures from before.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- is_working_day(date) -> boolean
-- Rule 4 is Mon–Fri inclusive with weekends excluded. Weekends are still
-- reported by get_availability (so a heatmap has no holes) but are flagged and
-- excluded from every risk calculation.
-- =============================================================================
create or replace function public.is_working_day(p_date date)
returns boolean
language sql
immutable
strict
as $$
  select extract(isodow from p_date) < 6
$$;

-- =============================================================================
-- team_size(p_manager_id) -> int
-- The manager plus their direct reports. 0 when the id is not a real employee.
-- =============================================================================
create or replace function public.team_size(p_manager_id uuid)
returns int
language sql
stable
set search_path = public
as $$
  select (
    select count(*)::int
    from public.employees e
    where e.is_active and (e.id = p_manager_id or e.manager_id = p_manager_id)
  )
$$;

-- =============================================================================
-- availability_rows(p_from, p_to, p_department, p_manager_id, p_assume_away)
--
-- The engine behind get_availability. Split out so get_leave_impact can ask the
-- same question with one extra rule: treat `p_assume_away` as on leave for the
-- whole range, even though the request being reviewed is still pending. Without
-- that, approving a request would look free.
--
-- Internal: not granted to any client role.
-- =============================================================================
create or replace function public.availability_rows(
  p_from         date,
  p_to           date,
  p_department   text,
  p_manager_id   uuid,
  p_assume_away  uuid
)
returns table (
  date             date,
  is_weekend       boolean,
  team_size        int,
  on_leave_count   int,
  available_count  int,
  availability_pct numeric,
  names_on_leave   text[],
  ids_on_leave     uuid[]
)
language sql
stable
set search_path = public
as $$
  with scoped as (
    select e.id, e.name
    from public.employees e
    where e.is_active
      and (
        (p_manager_id is not null and (e.id = p_manager_id or e.manager_id = p_manager_id))
        or (p_manager_id is null and p_department is not null and e.department = p_department)
        or (p_manager_id is null and p_department is null)
      )
  ),
  days as (
    select g.d::date as day
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g(d)
  ),
  away as (
    -- Distinct per (day, person) so overlapping approved requests for the same
    -- person still count them away once.
    select distinct d.day, lr.employee_id
    from days d
    join public.leave_requests lr
      on lr.status = 'approved'
     and d.day between lr.start_date and lr.end_date
    join scoped s on s.id = lr.employee_id

    union

    -- The person whose request is under review, for every day they asked for.
    select d.day, p_assume_away
    from days d
    where p_assume_away is not null
      and exists (select 1 from scoped s where s.id = p_assume_away)
  )
  select
    d.day,
    not public.is_working_day(d.day),
    (select count(*)::int from scoped)::int,
    count(a.employee_id)::int,
    ((select count(*)::int from scoped) - count(a.employee_id))::int,
    case
      when (select count(*)::int from scoped) = 0 then 100.0
      else round(
        (((select count(*)::int from scoped) - count(a.employee_id)) * 100.0
          / (select count(*)::int from scoped))::numeric, 1
      )
    end,
    coalesce(
      (select array_agg(s2.name order by s2.name)
         from scoped s2
         join away a2 on a2.employee_id = s2.id and a2.day = d.day),
      '{}'::text[]
    ),
    coalesce(
      (select array_agg(s2.id order by s2.name)
         from scoped s2
         join away a2 on a2.employee_id = s2.id and a2.day = d.day),
      '{}'::uuid[]
    )
  from days d
  left join away a on a.day = d.day
  group by d.day
  order by d.day
$$;

-- =============================================================================
-- get_availability(p_from, p_to, p_department, p_manager_id)
--
-- One row per calendar day between p_from and p_to, with the team size, how many
-- are on approved leave, and who.
--
-- SECURITY DEFINER, because it has to call the internal `availability_rows`,
-- which is not granted to any client role.
--
-- Scope is resolved HERE, from the session, not from the parameters:
--   manager -> always their own reporting line; any p_manager_id or
--              p_department they pass is ignored, so a direct PostgREST call
--              cannot widen their view
--   hr      -> the organisation by default, and free to narrow to a manager or a
--              department via the parameters
--   anyone else -> 42501
-- The API route applies the same rules before it calls this, so the two agree;
-- doing it here too means the database is the enforcement layer rather than the
-- route.
-- =============================================================================
create or replace function public.get_availability(
  p_from        date default current_date,
  p_to          date default (current_date + 41),
  p_department  text default null,
  p_manager_id  uuid  default null
)
returns table (
  date             date,
  is_weekend       boolean,
  team_size        int,
  on_leave_count   int,
  available_count  int,
  availability_pct numeric,
  names_on_leave   text[],
  ids_on_leave     uuid[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_viewer  record;
  v_manager uuid;
  v_dept    text;
begin
  select e.id, e.app_role
  into v_viewer
  from public.employees e
  where e.auth_user_id = auth.uid() and e.is_active
  limit 1;

  if v_viewer is null then
    raise exception 'FORBIDDEN: no employee record for the current session'
      using errcode = '42501';
  end if;

  -- Admin inherits HR's ability to inspect any line.
  if v_viewer.app_role in ('hr', 'admin') then
    v_manager := p_manager_id;
    v_dept    := p_department;
  elsif v_viewer.app_role = 'manager' then
    -- A manager is pinned to their own line whatever they ask for.
    v_manager := v_viewer.id;
    v_dept    := null;
  else
    raise exception 'FORBIDDEN: only a manager or HR may read availability'
      using errcode = '42501';
  end if;

  -- The columns are listed rather than `select *`: this function declares an
  -- OUT parameter called `date`, which shadows the `date` type inside the body
  -- and makes a bare star expansion fail to resolve.
  return query
    select
      r.date,
      r.is_weekend,
      r.team_size,
      r.on_leave_count,
      r.available_count,
      r.availability_pct,
      r.names_on_leave,
      r.ids_on_leave
    from public.availability_rows(p_from, p_to, v_dept, v_manager, null) r;
end;
$$;

comment on function public.get_availability(date, date, text, uuid) is
  'Per-day team availability from approved leave. Weekends are flagged and excluded from risk. Scope comes from the session: a manager always sees their own reporting line, HR may narrow to a manager or a department. Anyone else gets SQLSTATE 42501.';

-- =============================================================================
-- get_leave_impact(p_request_id)
--
-- What happens to the team if this request is approved. Read-only, and it
-- assumes the request IS granted, so a manager sees the cost of saying yes.
--
-- Authorisation is checked in two places on purpose: the API refuses anyone who
-- is not the requester's manager or HR, and this function repeats the check and
-- raises 42501, so the rule still holds if the API is bypassed. The employee
-- themself is not allowed either — self-approval is refused by the Phase 3
-- decision RPCs and must not be readable as an "impact" either.
--
-- Risk is a pure function of the worst working day's availability:
--   >= 75%  low
--   50-74%  medium
--   < 50%   high
-- A request that falls entirely on a weekend has no working day, and so no risk
-- level at all.
-- =============================================================================
create or replace function public.get_leave_impact(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_request  record;
  v_viewer   record;
  v_team     int;
  v_worst_pct    numeric;
  v_worst_date   date;
  v_working_days int;
  v_risk     text;
  v_overlap  jsonb;
begin
  select lr.*, e.name as employee_name, e.manager_id
  into v_request
  from public.leave_requests lr
  join public.employees e on e.id = lr.employee_id
  where lr.id = p_request_id;

  if not found then
    raise exception 'NOT_FOUND: no leave request with that id' using errcode = 'P0002';
  end if;

  select e.id, e.app_role
  into v_viewer
  from public.employees e
  where e.auth_user_id = auth.uid() and e.is_active
  limit 1;

  if v_viewer is null
     or (v_viewer.app_role <> 'hr'
         and (v_request.manager_id is null or v_viewer.id <> v_request.manager_id)) then
    raise exception 'FORBIDDEN: only the manager or HR may read leave impact'
      using errcode = '42501';
  end if;

  v_team := public.team_size(v_request.manager_id);

  -- The requester is passed as `p_assume_away` so their own days count against
  -- availability even while the request is still pending.
  select
    min(a.availability_pct),
    count(*) filter (where not a.is_weekend)::int
  into v_worst_pct, v_working_days
  from public.availability_rows(
    v_request.start_date, v_request.end_date, null, v_request.manager_id,
    v_request.employee_id
  ) a
  where not a.is_weekend;

  -- Earliest day that is as bad as the worst day, so the callout names the first
  -- date the manager would actually be short.
  select min(a.date)
  into v_worst_date
  from public.availability_rows(
    v_request.start_date, v_request.end_date, null, v_request.manager_id,
    v_request.employee_id
  ) a
  where not a.is_weekend
    and a.availability_pct = v_worst_pct;

  v_risk := case
    when v_worst_pct is null then null
    when v_worst_pct >= 75 then 'low'
    when v_worst_pct >= 50 then 'medium'
    else 'high'
  end;

  -- Who else is already away across the same dates, restricted to the reporting
  -- line. The requester is excluded: this is the knock-on effect on the team,
  -- not the request itself.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'employee_id', e.id,
      'name',       e.name,
      'start_date', lr.start_date,
      'end_date',   lr.end_date,
      'days',       lr.days
    ) order by e.name
  ), '[]'::jsonb)
  into v_overlap
  from public.leave_requests lr
  join public.employees e on e.id = lr.employee_id
  where lr.status = 'approved'
    and lr.employee_id <> v_request.employee_id
    and lr.start_date <= v_request.end_date
    and lr.end_date >= v_request.start_date
    and (e.id = v_request.manager_id or e.manager_id = v_request.manager_id);

  return jsonb_build_object(
    'request_id',        v_request.id,
    'employee_id',       v_request.employee_id,
    'employee_name',     v_request.employee_name,
    'status',            v_request.status,
    'start_date',        v_request.start_date,
    'end_date',          v_request.end_date,
    'days',              v_request.days,
    'team_size',         v_team,
    'already_on_leave',  jsonb_array_length(v_overlap),
    'overlapping_leave', v_overlap,
    'working_days',      v_working_days,
    'worst_date',        v_worst_date,
    'worst_day_availability_pct', v_worst_pct,
    'risk',              v_risk,
    'per_day', coalesce((
      select jsonb_agg(to_jsonb(a) - 'ids_on_leave' order by a.date)
        from public.availability_rows(
          v_request.start_date, v_request.end_date, null, v_request.manager_id,
          v_request.employee_id
        ) a
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.get_leave_impact(uuid) is
  'Coverage impact of a leave request on the requester''s reporting line, assuming it is granted, plus a Low/Medium/High risk level from the worst working day. Restricted to the requester''s manager or HR (SQLSTATE 42501 otherwise).';

-- =============================================================================
-- generate_alerts()
--
-- Idempotent: every rule checks for a matching UNREAD alert before inserting, so
-- calling it on every dashboard load does not pile up duplicates, and dismissing
-- an alert lets a still-true condition raise it again later.
--
-- Rules:
--   (a) two or more people in one reporting line away on the same upcoming day
--   (b) a department below 60% availability on a working day in the next 14
--   (c) a leave request still pending more than 3 days after it was submitted
--   (d) a casual / annual / sick balance fully spent
--   (e) 30% or more of the organisation away on a day in the next 14
--
-- `scope_employee_id` is what makes the read side work: an org-wide alert (rule
-- b and e) has NULL scope, a manager's team alert (rule a) is scoped to the
-- manager, a balance alert (rule d) to the person, and a stale-pending alert
-- (rule c) to the person who must act on it.
--
-- Returns the number of rows inserted, so a caller can tell "ran" from "found
-- nothing new".
-- =============================================================================
create or replace function public.generate_alerts()
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_total   int := 0;
  v_rows    int := 0;
  v_today   date := current_date;
  v_horizon date := current_date + 14;
  v_row     record;
begin
  -- (a) Two or more people in the same reporting line away on the same day.
  for v_row in
    select
      m.id as manager_id,
      d.day,
      count(distinct lr.employee_id) as away_count,
      (select array_agg(e2.name order by e2.name)
         from public.employees e2
         join public.leave_requests l2
           on l2.employee_id = e2.id
          and l2.status = 'approved'
          and d.day between l2.start_date and l2.end_date
        where e2.manager_id = m.id) as names
    from public.employees m
    join public.leave_requests lr on lr.employee_id in (
      select e.id from public.employees e where e.manager_id = m.id and e.is_active
    )
    cross join lateral (select generate_series(v_today, v_horizon, interval '1 day')::date as day) d
    where lr.status = 'approved'
      and public.is_working_day(d.day)
      and d.day between lr.start_date and lr.end_date
      and lr.end_date >= v_today
    group by m.id, d.day
    having count(distinct lr.employee_id) >= 2
  loop
    insert into public.alerts (scope_employee_id, type, severity, message, related_date)
    select v_row.manager_id, 'team_absent', 'warning',
      format('%s are both away on %s — %s people out of this reporting line.',
        array_to_string(v_row.names, ' and '),
        to_char(v_row.day, 'DD FMMonth'),
        v_row.away_count),
      v_row.day
    where not exists (
      select 1 from public.alerts a
      where a.scope_employee_id = v_row.manager_id
        and a.type = 'team_absent'
        and a.related_date = v_row.day
        and not a.is_read
    );
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end loop;

  -- (b) Department availability below 60% on a working day within 14 days.
  for v_row in
    select
      e.department,
      d.day,
      count(distinct e.id) as dept_size,
      count(distinct lr.employee_id) as away_count
    from public.employees e
    cross join lateral (select generate_series(v_today, v_horizon, interval '1 day')::date as day) d
    left join public.leave_requests lr
      on lr.employee_id = e.id
     and lr.status = 'approved'
     and d.day between lr.start_date and lr.end_date
    where e.is_active
      and public.is_working_day(d.day)
    group by e.department, d.day
    having ((count(distinct e.id) - count(distinct lr.employee_id)) * 100.0
            / count(distinct e.id)) < 60
  loop
    insert into public.alerts (scope_employee_id, type, severity, message, related_date)
    select null, 'upcoming_leave', 'warning',
      format('%s drops to %s%% availability on %s.',
        v_row.department,
        round(((v_row.dept_size - v_row.away_count) * 100.0 / v_row.dept_size)::numeric),
        to_char(v_row.day, 'DD FMMonth')),
      v_row.day
    where not exists (
      select 1 from public.alerts a
      where a.scope_employee_id is null
        and a.type = 'upcoming_leave'
        and a.related_date = v_row.day
        and a.severity = 'warning'
        and a.message like v_row.department || '%'
        and not a.is_read
    );
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end loop;

  -- (c) A request still pending more than 3 days after it was submitted.
  for v_row in
    select
      e.manager_id as scope_id,
      lr.id,
      lr.start_date,
      -- Exposed explicitly: the alert message below formats this date, and a
      -- record loop only exposes the columns actually selected. Deriving
      -- `age_days` from it does not make `created_at` visible.
      lr.created_at,
      e.name,
      (current_date - lr.created_at::date) as age_days
    from public.leave_requests lr
    join public.employees e on e.id = lr.employee_id
    where lr.status = 'pending'
      and lr.created_at < (now() - interval '3 days')
      and e.manager_id is not null
  loop
    insert into public.alerts (scope_employee_id, type, severity, message, related_date)
    select v_row.scope_id, 'leave_pending', 'info',
      format('%s''s request from %s has been waiting %s days.',
        v_row.name, to_char(v_row.created_at, 'DD FMMonth'), v_row.age_days),
      v_row.start_date
    where not exists (
      select 1 from public.alerts a
      where a.type = 'leave_pending'
        and a.scope_employee_id = v_row.scope_id
        and a.message like '%''' || v_row.name || '''' || '%'
        and not a.is_read
    );
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end loop;

  -- (d) A casual, annual or sick balance fully spent.
  for v_row in
    select lb.employee_id, e.name, lb.leave_type
    from public.leave_balances lb
    join public.employees e on e.id = lb.employee_id
    where lb.year = extract(year from current_date)::int
      and lb.allocated > 0
      and lb.remaining = 0
      and lb.leave_type in ('casual', 'sick', 'annual')
      and e.is_active
  loop
    insert into public.alerts (scope_employee_id, type, severity, message, related_date)
    select v_row.employee_id, 'balance_low', 'warning',
      format('%s has used all of their %s leave for %s.',
        v_row.name, v_row.leave_type, extract(year from current_date)::int),
      current_date
    where not exists (
      select 1 from public.alerts a
      where a.scope_employee_id = v_row.employee_id
        and a.type = 'balance_low'
        and a.message like '% ' || v_row.leave_type || ' leave%'
        and not a.is_read
    );
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end loop;

  -- (e) 30% or more of the organisation away on a day in the next 14.
  for v_row in
    select
      d.day,
      count(distinct e.id) as org_size,
      count(distinct lr.employee_id) as away_count
    from public.employees e
    cross join lateral (select generate_series(v_today, v_horizon, interval '1 day')::date as day) d
    left join public.leave_requests lr
      on lr.employee_id = e.id
     and lr.status = 'approved'
     and d.day between lr.start_date and lr.end_date
    where e.is_active and public.is_working_day(d.day)
    group by d.day
    having (count(distinct lr.employee_id) * 100.0 / count(distinct e.id)) >= 30
  loop
    insert into public.alerts (scope_employee_id, type, severity, message, related_date)
    select null, 'upcoming_leave', 'critical',
      format('%s%% of the organisation (%s of %s) is away on %s.',
        round((v_row.away_count * 100.0 / v_row.org_size)::numeric),
        v_row.away_count, v_row.org_size, to_char(v_row.day, 'DD FMMonth')),
      v_row.day
    where not exists (
      select 1 from public.alerts a
      where a.scope_employee_id is null
        and a.type = 'upcoming_leave'
        and a.related_date = v_row.day
        and a.severity = 'critical'
        and not a.is_read
    );
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end loop;

  return v_total;
end;
$$;

comment on function public.generate_alerts() is
  'Rule-based alert generator, idempotent: each rule skips insertion when a matching unread alert exists. Covers team absence, low department availability, stale pending requests, exhausted balances and high-absence days. Returns how many rows were inserted.';

-- The generator is a server-side job. It is not callable by a session; the
-- refresh route uses the service-role client to run it, and only for hr/manager.
revoke all on function public.generate_alerts() from public, anon, authenticated;
grant execute on function public.generate_alerts() to service_role;

-- The engine is internal; only the two documented entry points are exposed.
revoke all on function public.availability_rows(date, date, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_availability(date, date, text, uuid) to authenticated, service_role;
grant execute on function public.get_leave_impact(uuid) to authenticated, service_role;

-- =============================================================================
-- Scheduling
--
-- pg_cron is available on Supabase but is not installed in this project, and
-- enabling it is a project-level change rather than DDL. The schedule is
-- therefore created only when the extension is actually present, so this
-- migration stays safe to (re)run either way.
--
-- The primary path is on-demand: POST /api/alerts/refresh, called on dashboard
-- load. Once `create extension pg_cron` has been run in this project, re-applying
-- this file registers the nightly job with no other change.
-- =============================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'orgflow-generate-alerts') then
      perform cron.schedule(
        'orgflow-generate-alerts',
        '15 6 * * *',
        'select public.generate_alerts()'
      );
    end if;
  end if;
end
$$;
