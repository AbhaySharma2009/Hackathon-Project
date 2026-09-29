-- Restores leave_balances to the seeded state, replaying the rules from
-- supabase/seed.sql. Needed because approving a request permanently spends a
-- balance, so an interrupted test run can leave the ledger drifted.
begin;

-- 1. Base allocation per leave type, for every active employee this year.
update public.leave_balances b
set allocated = t.allocated,
    used      = 0
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
  and b.leave_type = t.leave_type;

-- 2. Karthik's larger annual allocation, so `remaining` lands on exactly 22.
update public.leave_balances
set allocated = 27
where employee_id = '00000000-0000-4000-8000-000000000008'
  and year = extract(year from current_date)::int
  and leave_type = 'annual';

-- 3. `used` derived from APPROVED requests, so the ledger matches request history.
-- SUM rather than the seed's scalar `set used = r.days`, which only equals the
-- total when an employee has one approved request per type per year.
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

-- 4. Low-balance demo: historical usage that predates the seeded requests.
update public.leave_balances
set used = 9
where employee_id = '00000000-0000-4000-8000-000000000011'
  and year = extract(year from current_date)::int
  and leave_type = 'sick';

update public.leave_balances
set used = 10
where employee_id = '00000000-0000-4000-8000-000000000012'
  and year = extract(year from current_date)::int
  and leave_type = 'casual';

commit;
