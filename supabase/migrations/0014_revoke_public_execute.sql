-- =============================================================================
-- 0014_revoke_public_execute.sql
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. The explicit
-- `grant execute ... to service_role` in 0010 therefore added a grant without
-- removing the implicit one, so every `admin_*` function was reachable over
-- PostgREST by any session — including `anon`.
--
-- That was not exploitable: each function re-checks `is_admin()` against the
-- caller's own session and refuses, which is verified directly. This closes the
-- surface anyway so the functions are unreachable rather than merely refusing,
-- and so the grants in 0010 mean what they read as meaning.
-- =============================================================================

revoke execute on function public.admin_activity_log(int) from public;
revoke execute on function public.admin_create_employee(
  uuid, text, text, public.app_role, text, uuid, text, text) from public;
revoke execute on function public.admin_update_employee(
  uuid, public.app_role, text, uuid, text) from public;
revoke execute on function public.admin_set_employee_active(uuid, boolean) from public;
revoke execute on function public.admin_list_employees() from public;

-- The cancel RPC is deliberately self-service, but only for a signed-in
-- employee; `anon` has no session, so it should not be reachable at all.
revoke execute on function public.cancel_leave_request(uuid) from public;
revoke execute on function public.can_cancel_leave_request(uuid) from public;

grant execute on function public.admin_activity_log(int) to service_role;
grant execute on function public.admin_create_employee(
  uuid, text, text, public.app_role, text, uuid, text, text) to service_role;
grant execute on function public.admin_update_employee(
  uuid, public.app_role, text, uuid, text) to service_role;
grant execute on function public.admin_set_employee_active(uuid, boolean) to service_role;
grant execute on function public.admin_list_employees() to service_role;
grant execute on function public.cancel_leave_request(uuid) to authenticated, service_role;
grant execute on function public.can_cancel_leave_request(uuid) to authenticated, service_role;
