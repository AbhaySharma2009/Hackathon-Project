-- =============================================================================
-- OrgFlow — seed.sql
-- Idempotent demo data: 15 employees / 4 departments / 3-level hierarchy,
-- leave balances for the current year, and 6 leave requests with mixed statuses.
--
-- Re-running this file is safe: every row has a deterministic primary key and
-- is written with ON CONFLICT DO UPDATE.
-- =============================================================================

set search_path = public, extensions;

begin;

-- Current calendar year, resolved at run time so the seed stays valid over time.
create temporary table seed_cfg on commit drop as
  select extract(year from current_date)::int as y;

-- =============================================================================
-- EMPLOYEES (15)
-- Hierarchy: CEO (01) -> 4 department heads -> 4 team leads -> 6 ICs.
-- app_role: 1 x 'hr', department heads + leads + CEO = 'manager', rest 'employee'.
-- =============================================================================
insert into public.employees (id, name, email, photo, role, app_role, department, manager_id, join_date)
values
  -- ---- Level 1: CEO ----
  ('00000000-0000-4000-8000-000000000001', 'Aditya Rao',        'aditya.rao@orgflow.dev',        'https://i.pravatar.cc/300?img=12', 'Chief Executive Officer',            'manager',  'Engineering',      null,                                                                                  date '2019-03-11'),

  -- ---- Level 2: department heads ----
  ('00000000-0000-4000-8000-000000000002', 'Vikram Sethi',      'vikram.sethi@orgflow.dev',      'https://i.pravatar.cc/300?img=33', 'VP of Engineering',                 'manager',  'Engineering',      '00000000-0000-4000-8000-000000000001',                                        date '2019-06-03'),
  ('00000000-0000-4000-8000-000000000003', 'Ananya Iyer',       'ananya.iyer@orgflow.dev',       'https://i.pravatar.cc/300?img=45', 'Head of Product',                   'manager',  'Product & Design', '00000000-0000-4000-8000-000000000001',                                        date '2020-01-13'),
  ('00000000-0000-4000-8000-000000000004', 'Rahul Menon',       'rahul.menon@orgflow.dev',       'https://i.pravatar.cc/300?img=51', 'Head of Sales',                     'manager',  'Sales',            '00000000-0000-4000-8000-000000000001',                                        date '2020-04-06'),
  ('00000000-0000-4000-8000-000000000005', 'Meera Krishnan',    'meera.krishnan@orgflow.dev',    'https://i.pravatar.cc/300?img=47', 'Head of People & Operations',       'manager',  'HR & Operations',  '00000000-0000-4000-8000-000000000001',                                        date '2020-08-17'),

  -- ---- Level 3: Engineering team ----
  ('00000000-0000-4000-8000-000000000006', 'Sanjay Kapoor',     'sanjay.kapoor@orgflow.dev',     'https://i.pravatar.cc/300?img=53', 'Engineering Manager',               'manager',  'Engineering',      '00000000-0000-4000-8000-000000000002',                                        date '2020-09-14'),
  ('00000000-0000-4000-8000-000000000007', 'Neha Gupta',        'neha.gupta@orgflow.dev',        'https://i.pravatar.cc/300?img=25', 'Senior Backend Engineer',           'employee', 'Engineering',      '00000000-0000-4000-8000-000000000006',                                        date '2021-02-01'),
  ('00000000-0000-4000-8000-000000000008', 'Karthik Reddy',     'karthik.reddy@orgflow.dev',     'https://i.pravatar.cc/300?img=68', 'Frontend Engineer',                 'employee', 'Engineering',      '00000000-0000-4000-8000-000000000006',                                        date '2021-07-19'),
  ('00000000-0000-4000-8000-000000000009', 'Priya Nair',        'priya.nair@orgflow.dev',        'https://i.pravatar.cc/300?img=44', 'DevOps Engineer',                   'employee', 'Engineering',      '00000000-0000-4000-8000-000000000006',                                        date '2022-05-09'),

  -- ---- Level 3: Product & Design team ----
  ('00000000-0000-4000-8000-000000000010', 'Ishita Desai',      'ishita.desai@orgflow.dev',      'https://i.pravatar.cc/300?img=32', 'Product Lead',                      'manager',  'Product & Design', '00000000-0000-4000-8000-000000000003',                                        date '2021-04-12'),
  ('00000000-0000-4000-8000-000000000011', 'Arjun Mehta',       'arjun.mehta@orgflow.dev',       'https://i.pravatar.cc/300?img=60', 'Product Designer',                   'employee', 'Product & Design', '00000000-0000-4000-8000-000000000010',                                        date '2022-11-07'),

  -- ---- Level 3: Sales team ----
  ('00000000-0000-4000-8000-000000000012', 'Nikhil Verman',     'nikhil.verman@orgflow.dev',     'https://i.pravatar.cc/300?img=15', 'Sales Manager',                     'manager',  'Sales',            '00000000-0000-4000-8000-000000000004',                                        date '2021-06-21'),
  ('00000000-0000-4000-8000-000000000013', 'Fatima Sheikh',     'fatima.sheikh@orgflow.dev',     'https://i.pravatar.cc/300?img=26', 'Account Executive',                 'employee', 'Sales',            '00000000-0000-4000-8000-000000000012',                                        date '2023-01-16'),

  -- ---- Level 3: HR & Operations team ----
  ('00000000-0000-4000-8000-000000000014', 'Deepak Joshi',      'deepak.joshi@orgflow.dev',      'https://i.pravatar.cc/300?img=58', 'HR Business Partner',               'manager',  'HR & Operations',  '00000000-0000-4000-8000-000000000005',                                        date '2021-10-04'),
  -- The single 'hr' account: org-wide visibility for the HR dashboard.
  ('00000000-0000-4000-8000-000000000015', 'Rohan Iyer',        'rohan.iyer@orgflow.dev',        'https://i.pravatar.cc/300?img=64', 'People Operations Specialist',      'hr',       'HR & Operations',  '00000000-0000-4000-8000-000000000005',                                        date '2023-03-06')
on conflict (id) do update
set name       = excluded.name,
    email      = excluded.email,
    photo      = excluded.photo,
    role       = excluded.role,
    app_role   = excluded.app_role,
    department = excluded.department,
    manager_id = excluded.manager_id,
    join_date  = excluded.join_date,
    is_active  = true;
-- NOTE: auth_user_id is intentionally NOT touched here — scripts/seed-auth.ts owns it.

-- =============================================================================
-- LEAVE REQUESTS (6): 3 approved, 2 pending, 1 rejected
-- `days` is always computed by public.working_days() — never hand-entered.
-- =============================================================================
-- Months/days are stored as numbers and expanded with the current year, so the
-- demo dates stay inside the current calendar year whenever the seed is re-run.
insert into public.leave_requests
  (id, employee_id, leave_type, start_date, end_date, days, reason, status, manager_comment, decided_by, decided_at)
select
  v.id, v.employee_id, v.leave_type,
  make_date(c.y, v.start_month, v.start_day),
  make_date(c.y, v.end_month, v.end_day),
  public.working_days(make_date(c.y, v.start_month, v.start_day), make_date(c.y, v.end_month, v.end_day)),
  v.reason, v.status, v.manager_comment, v.decided_by,
  case when v.status = 'pending' then null else now() - interval '1 day' end
from (values
  -- R1 · approved · 10-15 Oct · the overlap-demo anchor for the Engineering team.
  (cast('00000000-0000-4000-8000-000000000101' as uuid),
   cast('00000000-0000-4000-8000-000000000007' as uuid), 'annual'::public.leave_type,
   10, 10, 10, 15,
   'Family trip to Coorg. Handover notes shared with the platform team.'::text,
   'approved'::public.leave_status,
   'Approved. Please ensure the release run is scheduled before you leave.'::text,
   cast('00000000-0000-4000-8000-000000000002' as uuid)),

  -- R2 · approved · early August annual (consumes Karthik's annual balance).
  (cast('00000000-0000-4000-8000-000000000102' as uuid),
   cast('00000000-0000-4000-8000-000000000008' as uuid), 'annual'::public.leave_type,
   8, 3, 8, 7,
   'Annual leave before the Q3 planning cycle starts.'::text,
   'approved'::public.leave_status,
   'Approved. Enjoy the break.'::text,
   cast('00000000-0000-4000-8000-000000000002' as uuid)),

  -- R3 · approved · long casual block (exhausts Fatima's casual balance).
  (cast('00000000-0000-4000-8000-000000000103' as uuid),
   cast('00000000-0000-4000-8000-000000000013' as uuid), 'casual'::public.leave_type,
   7, 20, 8, 4,
   'Extended personal leave - house shifting.'::text,
   'approved'::public.leave_status,
   'Approved. Account coverage has been arranged with Nikhil.'::text,
   cast('00000000-0000-4000-8000-000000000012' as uuid)),

  -- R4 · pending · overlaps R1 in the same Engineering team (team clash demo).
  (cast('00000000-0000-4000-8000-000000000104' as uuid),
   cast('00000000-0000-4000-8000-000000000008' as uuid), 'annual'::public.leave_type,
   10, 13, 10, 16,
   'Wedding in Mysuru - would like the last week of October.'::text,
   'pending'::public.leave_status,
   null::text, null::uuid),

  -- R5 · pending · a second unrelated request waiting on approval.
  (cast('00000000-0000-4000-8000-000000000105' as uuid),
   cast('00000000-0000-4000-8000-000000000009' as uuid), 'sick'::public.leave_type,
   11, 23, 11, 24,
   'Scheduled minor surgery and recovery.'::text,
   'pending'::public.leave_status,
   null::text, null::uuid),

  -- R6 · rejected · a lead asking for leave during quarter close.
  (cast('00000000-0000-4000-8000-000000000106' as uuid),
   cast('00000000-0000-4000-8000-000000000014' as uuid), 'casual'::public.leave_type,
   9, 14, 9, 16,
   'Family function out of town.'::text,
   'rejected'::public.leave_status,
   'Quarter close week - we are short-staffed for the payroll audit. Please re-apply for the first week of October and it will be approved.'::text,
   cast('00000000-0000-4000-8000-000000000001' as uuid))
) as v (
  id, employee_id, leave_type,
  start_month, start_day, end_month, end_day,
  reason, status, manager_comment, decided_by
), seed_cfg c
on conflict (id) do update
set employee_id     = excluded.employee_id,
    leave_type      = excluded.leave_type,
    start_date      = excluded.start_date,
    end_date        = excluded.end_date,
    days            = excluded.days,
    reason          = excluded.reason,
    status          = excluded.status,
    manager_comment = excluded.manager_comment,
    decided_by      = excluded.decided_by,
    decided_at      = excluded.decided_at;

-- =============================================================================
-- LEAVE BALANCES (current year, every employee, every leave type)
--
-- Baseline: casual 12, sick 10, annual 20, unpaid 0 (unpaid is not capped, so
-- its ledger row exists only for display and the balance cap is skipped in code).
--
-- Demo-specific overrides:
--   · Karthik Reddy  — annual 27 allocated, 5 used  -> 22 remaining, so a 25-day request fails.
--   · Fatima Sheikh  — casual 12 used (R3)          -> casual exhausted, remaining 0.
--   · Neha Gupta     — annual 4 used (R1)           -> 16 remaining.
--   · Arjun Mehta    — sick 9 used                   -> 1 remaining  (low-balance demo).
--   · Nikhil Verman  — casual 10 used                -> 2 remaining  (low-balance demo).
-- Balances are a year-to-date snapshot; the six seeded requests are a recent
-- sample of that history, which is why the two low-balance figures above are
-- literal rather than derived.
-- =============================================================================
insert into public.leave_balances (employee_id, year, leave_type, allocated, used)
select e.id, c.y, t.leave_type, t.allocated, 0
from public.employees e
cross join seed_cfg c
cross join (values
  ('casual'::public.leave_type, 12::numeric),
  ('sick'::public.leave_type,   10::numeric),
  ('annual'::public.leave_type, 20::numeric),
  ('unpaid'::public.leave_type,  0::numeric)
) as t(leave_type, allocated)
where e.is_active
on conflict (employee_id, year, leave_type) do update
set allocated = excluded.allocated,
    used      = excluded.used;

-- Annual for Karthik: larger allocation so `remaining` lands on exactly 22.
update public.leave_balances b
set allocated = 27
from seed_cfg c
where b.employee_id = '00000000-0000-4000-8000-000000000008'
  and b.year = c.y and b.leave_type = 'annual';

-- `used` derived from the APPROVED seeded requests so the ledger can never drift
-- from the request history.
update public.leave_balances b
set used = r.days
from leave_requests r
where r.employee_id = b.employee_id
  and r.leave_type = b.leave_type
  and r.status = 'approved'
  and b.year = extract(year from r.start_date)::int
  and b.leave_type in ('casual', 'annual', 'sick', 'unpaid');

-- Low-balance demo: historical usage that predates the seeded requests.
update public.leave_balances b
set used = 9
from seed_cfg c
where b.employee_id = '00000000-0000-4000-8000-000000000011'
  and b.year = c.y and b.leave_type = 'sick';

update public.leave_balances b
set used = 10
from seed_cfg c
where b.employee_id = '00000000-0000-4000-8000-000000000012'
  and b.year = c.y and b.leave_type = 'casual';

commit;
