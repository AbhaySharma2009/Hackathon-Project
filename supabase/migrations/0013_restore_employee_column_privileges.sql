-- =============================================================================
-- 0013_restore_employee_column_privileges.sql
--
-- Undoes a privilege regression introduced in 0010.
--
-- ## What went wrong
--
-- 0002 deliberately granted `employees` to `authenticated` by *column list*,
-- excluding `email`, `app_role` and `auth_user_id`, on the stated principle that
-- "a browser session physically cannot read email, app_role or auth_user_id".
--
-- 0010 needed an Admin to read `app_role` in order to administer roles, and
-- solved it with `grant select on public.employees to authenticated`. Postgres
-- column grants are not conditional per role, so that one statement handed the
-- excluded columns to *every* signed-in employee. It works for admins and
-- silently defeats the least-privilege rule for everybody else.
--
-- ## The fix
--
-- Put the column grant back, and give the administrator tier its extra columns
-- through a `security definer` function that checks `is_admin()` itself. The
-- function is granted to `service_role` only, so the excluded columns are
-- unreachable from a browser session except through the admin API.
-- =============================================================================

revoke select on public.employees from authenticated;

grant select (
  id, name, photo, role, department, manager_id, join_date, is_active
) on public.employees to authenticated;

-- =============================================================================
-- Admin: the full employee list, including the restricted columns.
--
-- Returned as jsonb rather than a table type so the column list cannot drift out
-- of step with the caller's select list unnoticed.
-- =============================================================================
create or replace function public.admin_list_employees()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: only an administrator can list employee accounts'
      using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'email', e.email,
          'name', e.name,
          'photo', e.photo,
          'app_role', e.app_role,
          'department', e.department,
          'manager_id', e.manager_id,
          'role', e.role,
          'join_date', e.join_date,
          'is_active', e.is_active
        ) order by e.name
      )
      from public.employees e
    ),
    '[]'::jsonb
  );
end;
$$;

grant execute on function public.admin_list_employees() to service_role;