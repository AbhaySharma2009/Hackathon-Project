-- =============================================================================
-- 0019_demo_accounts.sql — seed five canonical demo accounts
--
-- This migration creates the five standard demo users that ship with OrgFlow:
--
--   superadmin@orgflow.dev   (Super Admin)  → Chief Executive Officer
--   admin@orgflow.dev        (Admin)        → VP of Operations
--   hr@orgflow.dev           (HR)           → Head of People & Culture
--   manager@orgflow.dev      (Manager)      → Engineering Manager
--   employee@orgflow.dev     (Employee)     → Senior Software Engineer
--
-- All use the shared password "OrgFlow@2026" (hashed by Supabase Auth).
-- The employee records are linked via auth_user_id and form the hierarchy:
--
--   Super Admin
--       ↓
--   Admin
--       ↓
--   HR
--       ↓
--   Manager
--       ↓
--   Employee
--
-- Leave balances for 2026 are also seeded with realistic values.
-- Leave requests demonstrating the approval chain are included.
--
-- This is the ONLY source of demo data. Frontend code must not hardcode
-- these accounts or their data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Employee records (hierarchy: Super Admin → Admin → HR → Manager → Employee)
--    Auth users are created separately via Supabase Auth admin API.
--    The auth_user_id values below match the Supabase Auth users created
--    by the seed scripts (scripts/seed-auth.ts).
-- -----------------------------------------------------------------------------
INSERT INTO public.employees (
  id, auth_user_id, name, email, app_role, role, department,
  manager_id, join_date, is_active, phone, photo
) VALUES
  -- Super Admin (root of hierarchy)
  (
    'e4af8ed3-28ea-45f2-89c7-85060fa1f1c3',
    'ba3af097-2ff6-442f-b720-5c7ff7533e16',
    'Alexandra Chen', 'superadmin@orgflow.dev', 'super_admin',
    'Chief Executive Officer', 'Executive',
    NULL, '2018-01-15', true, '+1-555-0100',
    'https://i.pravatar.cc/300?img=1'
  ),
  -- Admin → reports to Super Admin
  (
    '1aea70b4-e4cb-43ae-8dd5-726912a5a5bf',
    '6345bbd5-97ed-4ef8-a749-0fc85415e6a7',
    'Marcus Johnson', 'admin@orgflow.dev', 'admin',
    'VP of Operations', 'Operations',
    'e4af8ed3-28ea-45f2-89c7-85060fa1f1c3', '2019-03-22', true, '+1-555-0101',
    'https://i.pravatar.cc/300?img=2'
  ),
  -- HR → reports to Admin
  (
    'd288abd2-d41a-4b71-aec6-b3e80f16dfef',
    '8e656012-5b72-46ef-8ae5-9b5e4fc26b75',
    'Sarah Williams', 'hr@orgflow.dev', 'hr',
    'Head of People & Culture', 'People & Culture',
    '1aea70b4-e4cb-43ae-8dd5-726912a5a5bf', '2020-06-10', true, '+1-555-0102',
    'https://i.pravatar.cc/300?img=3'
  ),
  -- Manager → reports to HR
  (
    '630755d2-009b-4a47-9197-d42ad8e489ed',
    'cd30c829-6c7e-4a1e-9832-b92bb71455c5',
    'David Park', 'manager@orgflow.dev', 'manager',
    'Engineering Manager', 'Engineering',
    'd288abd2-d41a-4b71-aec6-b3e80f16dfef', '2021-09-01', true, '+1-555-0103',
    'https://i.pravatar.cc/300?img=4'
  ),
  -- Employee → reports to Manager
  (
    'c6147368-9ff4-497f-ade5-90c410f7f126',
    '6f0f5790-840b-4bcf-b016-15b39ea456d1',
    'Emily Rodriguez', 'employee@orgflow.dev', 'employee',
    'Senior Software Engineer', 'Engineering',
    '630755d2-009b-4a47-9197-d42ad8e489ed', '2022-02-15', true, '+1-555-0104',
    'https://i.pravatar.cc/300?img=5'
  )
ON CONFLICT (id) DO UPDATE SET
  auth_user_id = EXCLUDED.auth_user_id,
  name = EXCLUDED.name,
  email = EXCLUDED.email,
  app_role = EXCLUDED.app_role,
  role = EXCLUDED.role,
  department = EXCLUDED.department,
  manager_id = EXCLUDED.manager_id,
  join_date = EXCLUDED.join_date,
  is_active = EXCLUDED.is_active,
  phone = EXCLUDED.phone,
  photo = EXCLUDED.photo;

-- -----------------------------------------------------------------------------
-- 2. Leave balances for 2026 (realistic allocations)
-- -----------------------------------------------------------------------------
INSERT INTO public.leave_balances (employee_id, leave_type, allocated, used, year) VALUES
  -- Super Admin
  ('e4af8ed3-28ea-45f2-89c7-85060fa1f1c3', 'annual', 25, 5, 2026),
  ('e4af8ed3-28ea-45f2-89c7-85060fa1f1c3', 'casual', 12, 2, 2026),
  ('e4af8ed3-28ea-45f2-89c7-85060fa1f1c3', 'sick', 10, 1, 2026),
  ('e4af8ed3-28ea-45f2-89c7-85060fa1f1c3', 'unpaid', 0, 0, 2026),
  -- Admin
  ('1aea70b4-e4cb-43ae-8dd5-726912a5a5bf', 'annual', 22, 8, 2026),
  ('1aea70b4-e4cb-43ae-8dd5-726912a5a5bf', 'casual', 12, 3, 2026),
  ('1aea70b4-e4cb-43ae-8dd5-726912a5a5bf', 'sick', 10, 2, 2026),
  ('1aea70b4-e4cb-43ae-8dd5-726912a5a5bf', 'unpaid', 0, 0, 2026),
  -- HR
  ('d288abd2-d41a-4b71-aec6-b3e80f16dfef', 'annual', 22, 6, 2026),
  ('d288abd2-d41a-4b71-aec6-b3e80f16dfef', 'casual', 12, 4, 2026),
  ('d288abd2-d41a-4b71-aec6-b3e80f16dfef', 'sick', 10, 1, 2026),
  ('d288abd2-d41a-4b71-aec6-b3e80f16dfef', 'unpaid', 0, 0, 2026),
  -- Manager
  ('630755d2-009b-4a47-9197-d42ad8e489ed', 'annual', 20, 7, 2026),
  ('630755d2-009b-4a47-9197-d42ad8e489ed', 'casual', 12, 5, 2026),
  ('630755d2-009b-4a47-9197-d42ad8e489ed', 'sick', 10, 2, 2026),
  ('630755d2-009b-4a47-9197-d42ad8e489ed', 'unpaid', 0, 0, 2026),
  -- Employee
  ('c6147368-9ff4-497f-ade5-90c410f7f126', 'annual', 18, 4, 2026),
  ('c6147368-9ff4-497f-ade5-90c410f7f126', 'casual', 12, 3, 2026),
  ('c6147368-9ff4-497f-ade5-90c410f7f126', 'sick', 10, 1, 2026),
  ('c6147368-9ff4-497f-ade5-90c410f7f126', 'unpaid', 0, 0, 2026)
ON CONFLICT (employee_id, leave_type, year) DO UPDATE SET
  allocated = EXCLUDED.allocated,
  used = EXCLUDED.used;

-- -----------------------------------------------------------------------------
-- 3. Demo leave requests demonstrating the approval chain
--    Using dates that don't conflict with existing data
--    Note: approval_step_role enum only has 'manager', 'department_head', 'hr'
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_super_admin_id uuid := 'e4af8ed3-28ea-45f2-89c7-85060fa1f1c3';
  v_admin_id uuid := '1aea70b4-e4cb-43ae-8dd5-726912a5a5bf';
  v_hr_id uuid := 'd288abd2-d41a-4b71-aec6-b3e80f16dfef';
  v_manager_id uuid := '630755d2-009b-4a47-9197-d42ad8e489ed';
  v_employee_id uuid := 'c6147368-9ff4-497f-ade5-90c410f7f126';
  v_req1 uuid;
  v_req2 uuid;
  v_req3 uuid;
  v_req4 uuid;
  v_req5 uuid;
  v_req6 uuid;
  v_req7 uuid;
BEGIN
  -- 1. Employee → Manager (PENDING) - 3 day annual (future)
  INSERT INTO public.leave_requests (
    employee_id, leave_type, start_date, end_date, days, reason,
    status, current_approval_level
  ) VALUES (
    v_employee_id, 'annual',
    (CURRENT_DATE + interval '10 days')::date,
    (CURRENT_DATE + interval '12 days')::date,
    3, 'Family vacation planned',
    'pending', 1
  ) RETURNING id INTO v_req1;

  INSERT INTO public.leave_approval_steps (
    leave_request_id, level, approver_employee_id, approver_role, status
  ) VALUES (v_req1, 1, v_manager_id, 'manager', 'pending');

  -- 2. Employee → Manager (APPROVED) - 2 day casual (past, different dates from existing)
  INSERT INTO public.leave_requests (
    employee_id, leave_type, start_date, end_date, days, reason,
    status, current_approval_level, decided_at, decided_by
  ) VALUES (
    v_employee_id, 'casual',
    (CURRENT_DATE - interval '60 days')::date,
    (CURRENT_DATE - interval '59 days')::date,
    2, 'Personal appointment',
    'approved', NULL, (CURRENT_DATE - interval '60 days')::date, v_manager_id
  ) RETURNING id INTO v_req2;

  INSERT INTO public.leave_approval_steps (
    leave_request_id, level, approver_employee_id, approver_role, status, decided_at
  ) VALUES (v_req2, 1, v_manager_id, 'manager', 'approved', now());

  -- 3. Manager → HR (PENDING) - 3 day annual (future)
  -- Manager's leave goes to HR (level 1), then department_head (level 2)
  INSERT INTO public.leave_requests (
    employee_id, leave_type, start_date, end_date, days, reason,
    status, current_approval_level
  ) VALUES (
    v_manager_id, 'annual',
    (CURRENT_DATE + interval '15 days')::date,
    (CURRENT_DATE + interval '17 days')::date,
    3, 'Conference attendance',
    'pending', 1
  ) RETURNING id INTO v_req3;

  INSERT INTO public.leave_approval_steps (
    leave_request_id, level, approver_employee_id, approver_role, status
  ) VALUES (v_req3, 1, v_hr_id, 'hr', 'pending');

  INSERT INTO public.leave_approval_steps (
    leave_request_id, level, approver_employee_id, approver_role, status
  ) VALUES (v_req3, 2, v_admin_id, 'department_head', 'pending');

  -- 4. Manager → HR (REJECTED) - 2 day casual (past)
  INSERT INTO public.leave_requests (
    employee_id, leave_type, start_date, end_date, days, reason,
    status, current_approval_level, decided_at, decided_by
  ) VALUES (
    v_manager_id, 'casual',
    (CURRENT_DATE - interval '60 days')::date,
    (CURRENT_DATE - interval '59 days')::date,
    2, 'Personal matter',
    'rejected', NULL, (CURRENT_DATE - interval '60 days')::date, v_hr_id
  ) RETURNING id INTO v_req4;

  INSERT INTO public.leave_approval_steps (
    leave_request_id, level, approver_employee_id, approver_role, status, decided_at
  ) VALUES (v_req4, 1, v_hr_id, 'hr', 'rejected', now());

  -- 5. HR → Admin (PENDING) - 2 day sick (future)
  -- HR's leave goes to Admin (level 1), then department_head (level 2)
  INSERT INTO public.leave_requests (
    employee_id, leave_type, start_date, end_date, days, reason,
    status, current_approval_level
  ) VALUES (
    v_hr_id, 'sick',
    (CURRENT_DATE + interval '20 days')::date,
    (CURRENT_DATE + interval '21 days')::date,
    2, 'Medical appointment',
    'pending', 1
  ) RETURNING id INTO v_req5;

  INSERT INTO public.leave_approval_steps (
    leave_request_id, level, approver_employee_id, approver_role, status
  ) VALUES (v_req5, 1, v_admin_id, 'hr', 'pending');

  INSERT INTO public.leave_approval_steps (
    leave_request_id, level, approver_employee_id, approver_role, status
  ) VALUES (v_req5, 2, v_super_admin_id, 'department_head', 'pending');

  -- 6. Admin → Super Admin (PENDING) - 5 day annual (future)
  -- Admin's leave goes to Super Admin
  INSERT INTO public.leave_requests (
    employee_id, leave_type, start_date, end_date, days, reason,
    status, current_approval_level
  ) VALUES (
    v_admin_id, 'annual',
    (CURRENT_DATE + interval '30 days')::date,
    (CURRENT_DATE + interval '34 days')::date,
    5, 'Annual leave',
    'pending', 1
  ) RETURNING id INTO v_req6;

  INSERT INTO public.leave_approval_steps (
    leave_request_id, level, approver_employee_id, approver_role, status
  ) VALUES (v_req6, 1, v_super_admin_id, 'hr', 'pending');

  -- 7. Super Admin (APPROVED) - 3 day annual (past, self-decided)
  INSERT INTO public.leave_requests (
    employee_id, leave_type, start_date, end_date, days, reason,
    status, current_approval_level, decided_at, decided_by
  ) VALUES (
    v_super_admin_id, 'annual',
    (CURRENT_DATE - interval '60 days')::date,
    (CURRENT_DATE - interval '58 days')::date,
    3, 'Board meeting',
    'approved', NULL, (CURRENT_DATE - interval '60 days')::date, v_super_admin_id
  ) RETURNING id INTO v_req7;
END $$;