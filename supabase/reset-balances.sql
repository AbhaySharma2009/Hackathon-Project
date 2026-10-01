-- Restores leave_balances to the state scripts/seed-demo-data.ts produces.
-- Needed because approving a request permanently spends a balance, so an
-- interrupted test run can leave the ledger drifted and later runs then assert
-- against the wrong numbers.
--
-- The per-person allocations must match the ALLOCATION map in the seeder; the
-- seeded employee ids are written out here so the reset cannot silently drift
-- away from the seed it claims to restore.
begin;

-- 1. Allocation per person and leave type, for this year. Every active employee
--    is covered, so a person created after the seed still lands on a sane
--    baseline rather than keeping whatever a test left behind.
update public.leave_balances b
set allocated = a.allocated
from public.employees e
left join (
  values
    ('meera.krishnan@orgflow.dev'::text,   'casual'::public.leave_type, 12::numeric),
    ('meera.krishnan@orgflow.dev',         'sick',                       10),
    ('meera.krishnan@orgflow.dev',         'annual',                     22),
    ('meera.krishnan@orgflow.dev',         'unpaid',                      0),
    ('aditya.rao@orgflow.dev',             'casual',                     10),
    ('aditya.rao@orgflow.dev',             'sick',                       10),
    ('aditya.rao@orgflow.dev',             'annual',                     25),
    ('aditya.rao@orgflow.dev',             'unpaid',                      0),
    ('sanjay.kapoor@orgflow.dev',          'casual',                     12),
    ('sanjay.kapoor@orgflow.dev',          'sick',                       10),
    ('sanjay.kapoor@orgflow.dev',          'annual',                     22),
    ('sanjay.kapoor@orgflow.dev',          'unpaid',                      0),
    ('vikram.sethi@orgflow.dev',           'casual',                     12),
    ('vikram.sethi@orgflow.dev',           'sick',                       10),
    ('vikram.sethi@orgflow.dev',           'annual',                     20),
    ('vikram.sethi@orgflow.dev',           'unpaid',                      0),
    ('rohan.iyer@orgflow.dev',             'casual',                     12),
    ('rohan.iyer@orgflow.dev',             'sick',                       10),
    ('rohan.iyer@orgflow.dev',             'annual',                     20),
    ('rohan.iyer@orgflow.dev',             'unpaid',                      0),
    ('neha.gupta@orgflow.dev',             'casual',                     12),
    ('neha.gupta@orgflow.dev',             'sick',                       10),
    ('neha.gupta@orgflow.dev',             'annual',                     20),
    ('neha.gupta@orgflow.dev',             'unpaid',                      0),
    ('priya.nair@orgflow.dev',             'casual',                     12),
    ('priya.nair@orgflow.dev',             'sick',                        8),
    ('priya.nair@orgflow.dev',             'annual',                     18),
    ('priya.nair@orgflow.dev',             'unpaid',                      0)
  ) as a(email, leave_type, allocated) on a.email = e.email
where b.employee_id = e.id
  and e.is_active
  and b.year = extract(year from current_date)::int
  and b.leave_type = a.leave_type;

-- Anyone outside the seeded set falls back to the baseline entitlement, so a
-- newly created employee is not left with a drifted figure.
update public.leave_balances b
set allocated = t.allocated
from public.employees e
cross join (values
  ('casual'::public.leave_type, 12::numeric),
  ('sick'::public.leave_type,   10::numeric),
  ('annual'::public.leave_type, 20::numeric),
  ('unpaid'::public.leave_type,  0::numeric)
) as t(leave_type, allocated)
where b.employee_id = e.id
  and e.is_active
  and b.year = extract(year from current_date)::int
  and b.leave_type = t.leave_type
  and not exists (
    select 1
    from public.employees seeded
    where seeded.id = e.id
      and seeded.email in (
        'meera.krishnan@orgflow.dev', 'aditya.rao@orgflow.dev',
        'sanjay.kapoor@orgflow.dev',  'vikram.sethi@orgflow.dev',
        'rohan.iyer@orgflow.dev',     'neha.gupta@orgflow.dev',
        'priya.nair@orgflow.dev'
      )
  );

-- 2. `used` derived from APPROVED requests, so the ledger matches request
--    history. SUM rather than the seed's scalar `set used = r.days`, which only
--    equals the total when an employee has one approved request per type per year.
update public.leave_balances b
set used = coalesce((
  select sum(r.days)
  from public.leave_requests r
  where r.employee_id = b.employee_id
    and r.leave_type = b.leave_type
    and r.status = 'approved'
    and b.year = extract(year from r.start_date)::int
), 0)
where b.year = extract(year from current_date)::int;

commit;