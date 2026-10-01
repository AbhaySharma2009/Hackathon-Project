-- =============================================================================
-- 0011_cancel_leave.sql — a requester withdrawing their own pending request
--
-- Phase 14 asks employees to be able to cancel eligible requests from their
-- dashboard. There was no way to do that: `approve_leave_request` and
-- `reject_leave_request` are the only decisions the API exposed, and
-- `cancelled` existed in the enum without any way to reach it.
--
-- ## The rules
--
--   * Only the requester may cancel, and only their own request. A manager, HR
--     or an admin has no cancel power — for someone else's request they can
--     reject it, which is a different and recorded decision.
--   * Only while the request is still `pending`. Once any approver has signed
--     it, the chain has been acted on and only the approval RPCs may settle it.
--   * Only before the leave starts. Cancelling leave that has already begun
--     would silently refund time somebody has already taken.
--
-- Nothing is refunded because nothing was ever spent: a balance is only debited
-- when the final approver signs, and a pending request has not been debited.
-- =============================================================================

alter table public.alerts drop constraint if exists alerts_type_valid;
alter table public.alerts add constraint alerts_type_valid check (
  type in (
    'leave_approved', 'leave_rejected', 'leave_pending', 'balance_low',
    'upcoming_leave', 'team_absent',
    'approval_pending', 'approval_escalated',
    'approval_overdue',
    -- Phase 14: the requester withdrew it.
    'leave_cancelled'
  )
);

create or replace function public.cancel_leave_request(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req    public.leave_requests%rowtype;
  v_actor  uuid := public.current_employee_id();
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED: no active employee for the current session'
      using errcode = '42501';
  end if;

  select * into v_req from public.leave_requests r where r.id = p_request_id for update;

  if not found then
    raise exception 'NOT_FOUND: that leave request no longer exists' using errcode = 'P0002';
  end if;

  -- Self-service, and only self-service: this is deliberately not an
  -- administrator power, so nobody can withdraw a colleague's request.
  if v_req.employee_id <> v_actor then
    raise exception 'FORBIDDEN: you can only cancel your own leave request'
      using errcode = '42501';
  end if;

  if v_req.status <> 'pending' then
    raise exception 'VALIDATION: only a request that is still pending can be cancelled'
      using errcode = '22023';
  end if;

  if v_req.start_date <= current_date then
    raise exception 'VALIDATION: this leave has already started, so it can no longer be cancelled'
      using errcode = '22023';
  end if;

  -- Retire the chain. The steps are an immutable snapshot of who *could* have
  -- signed, so they are kept and marked skipped rather than deleted.
  update public.leave_approval_steps s
  set status = 'skipped'
  where s.leave_request_id = p_request_id
    and s.status = 'pending';

  -- `decided_by` is the requester: they are the one who withdrew it, and the
  -- status constraint requires a decider for anything that is not pending.
  update public.leave_requests r
  set status        = 'cancelled',
      decided_by    = v_actor,
      decided_at    = now(),
      manager_comment = 'Cancelled by the requester.'
  where r.id = p_request_id;

  -- Tell whoever was about to act on it, so their queue is not stale.
  insert into public.alerts
    (scope_employee_id, type, severity, message, related_request_id, dedupe_key)
  select s.approver_employee_id, 'leave_cancelled', 'info',
    format('%s cancelled their leave request from %s to %s.',
      (select e.name from public.employees e where e.id = v_req.employee_id),
      to_char(v_req.start_date, 'DD FMMonth'),
      to_char(v_req.end_date, 'DD FMMonth')),
    p_request_id,
    'leave_cancelled:' || p_request_id::text || ':' || s.approver_employee_id::text
  from public.leave_approval_steps s
  where s.leave_request_id = p_request_id
    and s.approver_employee_id is not null
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object(
    'ok', true,
    'id', p_request_id,
    'status', 'cancelled'
  );
end;
$$;

grant execute on function public.cancel_leave_request(uuid) to authenticated, service_role;

-- =============================================================================
-- Can this person cancel this request right now?
--
-- The UI asks this so it can hide the action, but the answer is never trusted:
-- `cancel_leave_request` re-checks ownership, status and start date itself.
-- =============================================================================
create or replace function public.can_cancel_leave_request(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.leave_requests r
    where r.id = p_request_id
      and r.employee_id = public.current_employee_id()
      and r.status = 'pending'
      and r.start_date > current_date
  );
$$;

grant execute on function public.can_cancel_leave_request(uuid) to authenticated, service_role;
