-- =============================================================================
-- OrgFlow — 0008_ai_audit.sql
-- Audit trail for the HR Copilot.
--
-- Rule 5 says the model may only reach data through whitelisted, role-scoped
-- server functions and must never hold database credentials. This table is how
-- that is made checkable after the fact: every tool invocation is recorded with
-- who asked, what they asked for, and whether it worked.
--
-- A row is written by the server using the service-role client, never by a
-- browser session. There is deliberately no INSERT policy for `authenticated`,
-- so a session cannot forge an entry to cover for a call it made — or to plant
-- one that looks like someone else's.
-- =============================================================================

create table if not exists public.ai_audit_log (
  id           uuid primary key default gen_random_uuid(),
  -- The employee the copilot was acting for, never an argument the model chose.
  employee_id  uuid        not null references public.employees (id) on delete cascade,
  -- Name of the whitelisted tool that ran.
  tool_name    text        not null,
  -- Arguments as sent by the model, after zod validation. Only shapes the tool
  -- actually declares reach this column, so it cannot carry anything sensitive.
  arguments    jsonb       not null default '{}'::jsonb,
  -- Set false when the tool ran but could not produce a result.
  success      boolean     not null default true,
  error        text,
  -- Latency is kept because a slow tool is usually a badly scoped one.
  duration_ms  integer,
  created_at   timestamptz not null default now(),

  constraint ai_audit_tool_name_check check (tool_name <> '')
);

comment on table public.ai_audit_log is
  'One row per HR Copilot tool invocation. Written by the server only; readable by the employee it belongs to and by HR.';

-- The copilot reads a person's own history far more than HR does, so this is the
-- hot path: "who asked, and what for".
create index if not exists ai_audit_employee_created_idx
  on public.ai_audit_log (employee_id, created_at desc);

create index if not exists ai_audit_tool_idx
  on public.ai_audit_log (tool_name, created_at desc);

-- =============================================================================
-- RLS
-- =============================================================================
drop policy if exists ai_audit_log_select on public.ai_audit_log;

-- Your own trail, or all of it for HR. No write policy for `authenticated`:
-- the only writer is the server, using the service-role client.
create policy ai_audit_log_select on public.ai_audit_log
  for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or public.is_hr()
  );

-- Columns a browser session may read. `arguments` is included deliberately: the
-- point of an audit trail is that the employee can see what was asked on their
-- behalf, and the tool schemas never carry anyone else's identifier.
revoke all on public.ai_audit_log from anon, authenticated;
grant select (
  id, employee_id, tool_name, arguments, success, error, duration_ms, created_at
) on public.ai_audit_log to authenticated;

grant all on public.ai_audit_log to service_role;
