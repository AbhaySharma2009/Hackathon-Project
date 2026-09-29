-- =============================================================================
-- OrgFlow — 0005_org_tree_rpc.sql
-- Org chart, assembled in Postgres.
--
-- The chart is a pure read: the UI never recurses or joins to build it, and an
-- HR edit to `manager_id` changes the shape immediately because the tree is
-- derived from the data, never stored.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- org_subtree(root_id, visited) -> jsonb
--
-- One employee and their reporting line, nested. `visited` is the path of ids
-- walked so far, which is the cycle guard: a node is only expanded when its own
-- id is not already on the path, so a corrupted `manager_id` chain is cut
-- instead of looping forever. The `prevent_manager_cycle` trigger from 0001
-- makes cycles impossible in the first place; this is the backstop.
--
-- Private: not granted to clients, only called by get_org_tree().
-- =============================================================================
create or replace function public.org_subtree(p_root uuid, p_visited uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_node      record;
  v_children  jsonb := '[]'::jsonb;
  v_child     record;
begin
  select e.id, e.name, e.photo, e.role, e.department, e.manager_id,
         (
           select count(*)::int
           from public.employees c
           where c.manager_id = e.id and c.is_active
         ) as direct_report_count
  into v_node
  from public.employees e
  where e.id = p_root and e.is_active;

  if not found then
    return null;
  end if;

  -- Only descend when this id is not already on the path we walked to get here.
  if not (v_node.id = any(p_visited)) then
    for v_child in
      select c.id
      from public.employees c
      where c.manager_id = v_node.id and c.is_active
      order by c.name
    loop
      v_children := v_children || coalesce(
        public.org_subtree(v_child.id, p_visited || v_node.id),
        '[]'::jsonb
      );
    end loop;
  end if;

  return jsonb_build_object(
    'id',                  v_node.id,
    'name',                v_node.name,
    'photo',               v_node.photo,
    'role',                v_node.role,
    'department',          v_node.department,
    'direct_report_count', v_node.direct_report_count,
    'children',            v_children
  );
end;
$$;

-- =============================================================================
-- get_org_tree() -> jsonb
--
-- The whole active org as a forest. Multiple roots are handled correctly: an
-- employee with no manager_id, or whose manager is inactive (so absent from the
-- chart entirely), is a top-level node rather than being dropped.
-- =============================================================================
create or replace function public.get_org_tree()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(node order by node->>'name'),
    '[]'::jsonb
  )
  from (
    select public.org_subtree(r.id) as node
    from public.employees r
    where r.is_active
      and (
        r.manager_id is null
        or not exists (
          select 1 from public.employees m
          where m.id = r.manager_id and m.is_active
        )
      )
  ) roots
  where node is not null
$$;

comment on function public.get_org_tree() is
  'Active org hierarchy as a nested jsonb forest: id, name, photo, role, department, direct_report_count, children. Roots are employees with no active manager; a cycle is cut by a path guard rather than looping.';

-- =============================================================================
-- org_tree_health() -> jsonb
--
-- Tells the chart whether anything was dropped, so it can say so rather than
-- quietly showing a smaller company.
--
-- `get_org_tree` cuts a cyclic branch to stay finite, and the cut nodes are then
-- simply absent from the result. An active employee missing from the flattened
-- tree is therefore the signature of a cycle. `trigger_enabled` says whether the
-- `prevent_manager_cycle` trigger is armed, which is what makes a cycle
-- possible at all.
-- =============================================================================
create or replace function public.org_tree_health()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with recursive flat as (
    select n->>'id' as id, n as node
    from jsonb_array_elements(public.get_org_tree()) n

    union all

    select child->>'id' as id, child as node
    from flat f
    cross join lateral jsonb_array_elements(f.node->'children') child
  ),
  -- Materialised once, since it is read by three aggregates below.
  reached as materialized (select distinct id from flat)
  select jsonb_build_object(
    'node_count', (select count(*) from reached),
    'active_count', (select count(*) from public.employees where is_active),
    'missing', (select count(*) from public.employees e
                 where e.is_active
                   and not exists (select 1 from reached r where r.id = e.id::text)),
    'trigger_enabled', coalesce(
      (select t.tgenabled = 'O'
         from pg_trigger t
        where t.tgrelid = 'public.employees'::regclass
          and t.tgname = 'employees_prevent_manager_cycle'
          and not t.tgisinternal
        limit 1),
      false
    )
  )
$$;

comment on function public.org_tree_health() is
  'Reports how many active employees the org tree rendered and how many it dropped; a non-zero "missing" means a manager_id cycle was truncated.';

revoke execute on function public.org_tree_health() from public, anon;
grant execute on function public.org_tree_health() to authenticated, service_role;

-- The subtree builder is an internal helper, not a client entry point.
revoke execute on function public.org_subtree(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.get_org_tree() to authenticated, service_role;

-- =============================================================================
-- get_calendar_leaves(p_month_start, p_department, p_team) -> setof jsonb
--
-- Approved leave overlapping a month, for the monthly team calendar.
--
-- Why this is a function and not a table select:
--   `leave_requests_select` deliberately allows a session to read only its own
--   requests plus the ones it manages. A calendar, though, is a team view — an
--   employee needs to see when their colleagues are out — so widening that policy
--   would also expose pending requests and the private `reason` of colleagues.
--
-- So the scope is enforced here instead, in one place, and the result is limited
-- to what a calendar actually renders. `reason` and `manager_comment` are never
-- returned, and only `status = 'approved'` is ever visible through this path.
--
-- Scope, from auth.uid() alone — never from a parameter:
--   hr       -> every active employee
--   manager  -> their direct reports, plus themselves
--   employee -> their teammates (same manager), plus themselves
-- `p_department` and `p_team` can only narrow that set, never widen it.
-- =============================================================================
create or replace function public.get_calendar_leaves(
  p_month_start  date,
  p_department   text default null,
  p_team         uuid  default null
)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  with viewer as (
    select e.id, e.app_role, e.manager_id
    from public.employees e
    where e.auth_user_id = auth.uid() and e.is_active
    limit 1
  ),
  -- The employees whose approved leave this caller may see.
  visible as (
    select p.id, p.name, p.photo, p.department, p.manager_id
    from public.employees p
    where p.is_active
      and exists (
        select 1
        from viewer v
        where
          -- HR sees the whole organisation.
          v.app_role = 'hr'
          -- A manager sees their own reports, and themselves.
          or (p.id = v.id or p.manager_id = v.id)
          -- Everyone sees their teammates, and themselves.
          or (p.id = v.id or p.manager_id = v.manager_id)
      )
      -- Optional filters, applied inside the scope.
      and (p_department is null or p.department = p_department)
      and (
        p_team is null
        or p.id = p_team
        or p.manager_id = p_team
      )
  )
  select jsonb_build_object(
    'id',                  lr.id,
    'employee_id',         lr.employee_id,
    'leave_type',          lr.leave_type,
    'start_date',          lr.start_date,
    'end_date',            lr.end_date,
    'days',                lr.days,
    'status',              lr.status,
    'employee_name',       v.name,
    'employee_photo',      v.photo,
    'employee_department', v.department
  )
  from public.leave_requests lr
  join visible v on v.id = lr.employee_id
  where lr.status = 'approved'
    -- A request belongs to the month if any of its days fall inside it, so a
    -- bar that starts in one month and ends in the next appears in both.
    and lr.start_date <= (p_month_start + interval '1 month - 1 day')::date
    and lr.end_date >= p_month_start
  order by lr.start_date, v.name
$$;

comment on function public.get_calendar_leaves(date, text, uuid) is
  'Approved leave overlapping a month, scoped by the caller: hr sees all, a manager sees their reports, an employee sees their team. Never returns reason or manager_comment.';

grant execute on function public.get_calendar_leaves(date, text, uuid) to authenticated, service_role;

-- The org chart re-renders when HR re-parents somebody, so `employees` has to
-- broadcast. Without this the client subscribes to a table that never fires.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'employees'
  ) then
    alter publication supabase_realtime add table public.employees;
  end if;
end
$$;
