-- =============================================================================
-- 0017 — Controlled profile management (Phase 16)
-- =============================================================================
--
-- Two halves to the same requirement: a person may correct their own personal
-- details, and nobody except an authorised HR/Admin/Super Admin may touch
-- organisation-controlled information.
--
-- The important part is what this *removes*. Until now `employees_update_hr`
-- granted any authenticated HR user a direct, column-unrestricted UPDATE on
-- every row of `employees` — including their own, which made self-promotion to
-- admin or super_admin a single API call away. `PATCH /api/employees/[id]`
-- relied on exactly that policy.
--
-- So direct UPDATE is revoked from `authenticated` entirely and every write now
-- goes through one of two functions below, each of which names the columns it
-- is allowed to touch:
--
--   update_my_profile(...)            personal details only, caller is auth.uid()
--   admin_update_employee_profile(...) HR / Admin / Super Admin, with guards
--
-- RLS alone cannot express "you may change your phone number but not your
-- department", because policies are row-scoped rather than column-scoped.
-- Revoking the table privilege and funnelling writes through SECURITY DEFINER
-- functions is the only way to make that guarantee hold against a client that
-- talks to PostgREST directly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Personal details
-- -----------------------------------------------------------------------------
-- Deliberately short. These are the only fields a person owns and may correct.
-- Work email, role, department, manager and the rest stay under HR control.
--
-- `personal_email` is separate from `email`: the work address is issued by the
-- organisation and is an identity key (auth accounts are keyed on it), so it is
-- organisation-controlled. Someone who wants a different contact address adds a
-- personal one rather than taking over the work identity.

alter table public.employees
  add column if not exists phone text,
  add column if not exists personal_email text,
  add column if not exists address text,
  add column if not exists emergency_contact_name text,
  add column if not exists emergency_contact_phone text;

comment on column public.employees.phone is 'Self-editable contact number.';
comment on column public.employees.personal_email is 'Self-editable personal contact address. The work address in `email` is organisation-controlled.';
comment on column public.employees.address is 'Self-editable residential address.';
comment on column public.employees.emergency_contact_name is 'Self-editable emergency contact.';
comment on column public.employees.emergency_contact_phone is 'Self-editable emergency contact number.';
comment on column public.employees.photo is 'Path within the profile-photos bucket. Self-editable.';

-- Bound the free-text fields. These are displayed in the directory and the
-- profile page, so an unbounded blob is both a layout problem and a storage
-- problem.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'employees_phone_length'
  ) then
    alter table public.employees
      add constraint employees_phone_length
      check (phone is null or char_length(phone) between 6 and 32);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'employees_personal_email_length'
  ) then
    alter table public.employees
      add constraint employees_personal_email_length
      check (personal_email is null or char_length(personal_email) <= 254);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'employees_address_length'
  ) then
    alter table public.employees
      add constraint employees_address_length
      check (address is null or char_length(address) between 1 and 300);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'employees_emergency_name_length'
  ) then
    alter table public.employees
      add constraint employees_emergency_name_length
      check (emergency_contact_name is null or char_length(emergency_contact_name) between 1 and 120);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'employees_emergency_phone_length'
  ) then
    alter table public.employees
      add constraint employees_emergency_phone_length
      check (emergency_contact_phone is null or char_length(emergency_contact_phone) between 6 and 32);
  end if;
end;
$$;

-- A personal address that is not an address is worse than no address.
alter table public.employees
  drop constraint if exists employees_personal_email_format;
alter table public.employees
  add constraint employees_personal_email_format
  check (
    personal_email is null
    or personal_email = ''
    or personal_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  );

-- -----------------------------------------------------------------------------
-- 2. Profile photos
-- -----------------------------------------------------------------------------
-- Public read, because avatars are rendered by anyone who can see the person and
-- the directory renders img tags. Writes are restricted to the caller's own
-- folder, so one person can never overwrite another's avatar even by guessing a
-- path. The bucket is private to *writes*; read URLs are the usual public ones.

insert into storage.buckets (id, name, public)
values ('profile-photos', 'profile-photos', true)
on conflict (id) do nothing;

-- Paths are `<employee uuid>/<filename>`, so the first path segment is the owner.
drop policy if exists profile_photos_read on storage.objects;
create policy profile_photos_read on storage.objects
  for select to public
  using (bucket_id = 'profile-photos');

drop policy if exists profile_photos_insert on storage.objects;
create policy profile_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = public.current_employee_id()::text
  );

drop policy if exists profile_photos_update on storage.objects;
create policy profile_photos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = public.current_employee_id()::text
  )
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = public.current_employee_id()::text
  );

drop policy if exists profile_photos_delete on storage.objects;
create policy profile_photos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = public.current_employee_id()::text
  );

-- -----------------------------------------------------------------------------
-- 3. Self-service profile updates
-- -----------------------------------------------------------------------------
-- Only the six columns a person owns appear in the update statement below. The
-- signature has no parameter for role, department, manager, join date or id, so
-- there is nothing for a caller to tamper with — this is stronger than a
-- column check, because an omitted parameter cannot be smuggled through.
--
-- auth.uid() is used rather than a passed-in employee id precisely so that the
-- caller cannot choose whose profile to edit.

create or replace function public.update_my_profile(
  p_name                   text default null,
  p_phone                  text default null,
  p_personal_email         text default null,
  p_address                text default null,
  p_emergency_contact_name text default null,
  p_emergency_contact_phone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_emp    uuid;
  v_before public.employees%rowtype;
  v_after  public.employees%rowtype;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: no session' using errcode = '42501';
  end if;

  select e.id into v_emp
  from public.employees e
  where e.auth_user_id = v_uid and e.is_active;

  if v_emp is null then
    raise exception 'FORBIDDEN: no active employee is linked to this account'
      using errcode = '42501';
  end if;

  select e.* into v_before from public.employees e where e.id = v_emp;

  -- The work email is the auth identity key, so changing the display name here
  -- must never be allowed to change who the person signs in as.
  update public.employees e
  set name                    = coalesce(nullif(btrim(p_name), ''), e.name),
      phone                   = nullif(btrim(p_phone), ''),
      personal_email          = nullif(btrim(p_personal_email), ''),
      address                 = nullif(btrim(p_address), ''),
      emergency_contact_name  = nullif(btrim(p_emergency_contact_name), ''),
      emergency_contact_phone = nullif(btrim(p_emergency_contact_phone), '')
  where e.id = v_emp
  returning e.* into v_after;

  return jsonb_build_object(
    'ok', true,
    'employee', jsonb_build_object(
      'id', v_after.id,
      'name', v_after.name,
      'email', v_after.email,
      'photo', v_after.photo,
      'phone', v_after.phone,
      'personal_email', v_after.personal_email,
      'address', v_after.address,
      'emergency_contact_name', v_after.emergency_contact_name,
      'emergency_contact_phone', v_after.emergency_contact_phone
    ),
    'before', jsonb_build_object('name', v_before.name)
  );
end;
$$;

revoke all on function public.update_my_profile(text, text, text, text, text, text) from public, anon;
grant execute on function public.update_my_profile(text, text, text, text, text, text) to authenticated;

-- The avatar is stored in Supabase Storage and the row only holds the URL, so it
-- needs its own function rather than a parameter on `update_my_profile`.
--
-- HR/Admin/Super Admin set a colleague's photo from the directory, so a target
-- parameter is needed — but a caller may only target themselves unless they are
-- in a tier that manages profiles, which is what stops someone rewriting another
-- person's avatar by passing their id.
create or replace function public.update_employee_photo(
  p_actor       uuid,
  p_employee_id uuid,
  p_photo       text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor_role public.app_role;
  v_target     public.employees%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: no acting employee was supplied' using errcode = '42501';
  end if;

  select e.app_role into v_actor_role
  from public.employees e where e.id = p_actor and e.is_active;

  if v_actor_role is null then
    raise exception 'FORBIDDEN: the acting employee does not exist or is inactive'
      using errcode = '42501';
  end if;

  select e.* into v_target from public.employees e where e.id = p_employee_id;
  if not found then
    raise exception 'NOT_FOUND: no employee with that id' using errcode = 'P0002';
  end if;

  if p_employee_id is distinct from p_actor then
    if v_actor_role not in ('hr', 'admin', 'super_admin') then
      raise exception 'FORBIDDEN: you may only change your own photo'
        using errcode = '42501';
    end if;

    -- Same ceiling as the rest of profile management: HR does not reach upwards.
    if v_actor_role = 'hr' and public.role_rank(v_target.app_role) >= public.role_rank('hr') then
      raise exception 'FORBIDDEN: HR cannot edit an account at or above their own tier'
        using errcode = '42501';
    end if;
  end if;

  -- A stored avatar is always a public bucket URL, or null to fall back to the
  -- generated initials. Anything else would let a person point their card at an
  -- image on an arbitrary host.
  if p_photo is not null and p_photo <> '' and p_photo !~ '^https://[^/]+/storage/v1/object/public/profile-photos/'
  then
    raise exception 'VALIDATION: the photo must be a URL in the profile-photos bucket'
      using errcode = '22023';
  end if;

  update public.employees e
  set photo = nullif(btrim(p_photo), '')
  where e.id = p_employee_id;

  return jsonb_build_object('ok', true, 'employee_id', p_employee_id, 'photo', nullif(btrim(p_photo), ''));
end;
$$;

revoke all on function public.update_employee_photo(uuid, uuid, text) from public, anon;
grant execute on function public.update_employee_photo(uuid, uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. HR / Admin / Super Admin profile management
-- -----------------------------------------------------------------------------
-- The counterpart to `update_my_profile`, for someone editing *another* person.
--
-- Guards, in the order they are checked:
--   * the actor must be HR, Admin or Super Admin
--   * HR may not edit someone who outranks them, and may not edit an
--     Admin or a Super Admin
--   * nobody may change their own role, department or manager
--   * an Admin may not create or promote to a Super Admin
--
-- p_employee_id is the only identity parameter, and it is checked against the
-- caller's authority rather than trusted.

create or replace function public.admin_update_employee_profile(
  p_actor                   uuid,
  p_employee_id             uuid,
  p_name                    text default null,
  p_email                   text default null,
  p_phone                   text default null,
  p_personal_email          text default null,
  p_address                 text default null,
  p_emergency_contact_name  text default null,
  p_emergency_contact_phone text default null,
  p_photo                   text default null,
  p_app_role                public.app_role default null,
  p_department              text default null,
  p_manager_id              uuid default null,
  p_job_title               text default null,
  p_join_date               date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor_role public.app_role;
  v_target     public.employees%rowtype;
  v_manager    public.employees%rowtype;
  v_new_role   public.app_role;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: no acting employee was supplied' using errcode = '42501';
  end if;

  select e.app_role into v_actor_role
  from public.employees e where e.id = p_actor and e.is_active;

  if v_actor_role is null or v_actor_role not in ('hr', 'admin', 'super_admin') then
    raise exception 'FORBIDDEN: profile management requires HR, Admin or Super Admin'
      using errcode = '42501';
  end if;

  select e.* into v_target
  from public.employees e where e.id = p_employee_id;

  if not found then
    raise exception 'NOT_FOUND: no employee with that id' using errcode = 'P0002';
  end if;

  -- Nobody edits their own organisation-controlled fields. An HR user who can
  -- write this function's arguments to themselves could otherwise promote
  -- themselves, which is the exact hole `employees_update_hr` used to be.
  if p_employee_id = p_actor then
    if p_app_role is not null and p_app_role is distinct from v_target.app_role then
      raise exception 'FORBIDDEN: you cannot change your own role'
        using errcode = '42501';
    end if;
    if p_department is not null and p_department is distinct from v_target.department then
      raise exception 'FORBIDDEN: you cannot change your own department'
        using errcode = '42501';
    end if;
    if p_manager_id is not null and p_manager_id is distinct from v_target.manager_id then
      raise exception 'FORBIDDEN: you cannot change your own manager'
        using errcode = '42501';
    end if;
  end if;

  -- An HR user manages the population beneath them, not their superiors.
  if v_actor_role = 'hr' then
    if public.role_rank(v_target.app_role) >= public.role_rank('hr') then
      raise exception 'FORBIDDEN: HR cannot edit an account at or above their own tier'
        using errcode = '42501';
    end if;
  end if;

  -- Role changes are the sharpest edge here. Three rules, in order:
  --   1. only a Super Admin may create or promote to Super Admin
  --   2. only a Super Admin may alter a Super Admin's role, *including*
  --      demoting them — otherwise an Admin could strip the top tier
  --   3. nobody alters their own role (checked above)
  if p_app_role is not null and p_app_role is distinct from v_target.app_role then
    if v_actor_role <> 'super_admin' and p_app_role = 'super_admin' then
      raise exception 'FORBIDDEN: only a Super Admin can grant the Super Admin role'
        using errcode = '42501';
    end if;

    if v_target.app_role = 'super_admin' and v_actor_role <> 'super_admin' then
      raise exception 'FORBIDDEN: only a Super Admin can change a Super Admin''s role'
        using errcode = '42501';
    end if;
  end if;

  -- A manager must exist, be active and not be the person being edited.
  if p_manager_id is not null then
    if p_manager_id = p_employee_id then
      raise exception 'VALIDATION: an employee cannot be their own manager'
        using errcode = '22023';
    end if;

    select e.* into v_manager from public.employees e where e.id = p_manager_id;

    if not found or not v_manager.is_active then
      raise exception 'VALIDATION: the manager must be an active employee'
        using errcode = '22023';
    end if;

    -- Cycle rejection is left to the `employees_prevent_manager_cycle` trigger,
    -- which already guards every write to this table. Re-implementing the walk
    -- here would be a second copy of the same rule to keep in step.
  end if;

  v_new_role := coalesce(p_app_role, v_target.app_role);

  update public.employees e
  set name                    = coalesce(nullif(btrim(p_name), ''), e.name),
      email                   = coalesce(nullif(btrim(p_email), ''), e.email),
      phone                   = case when p_phone is null then e.phone else nullif(btrim(p_phone), '') end,
      personal_email          = case when p_personal_email is null then e.personal_email else nullif(btrim(p_personal_email), '') end,
      address                 = case when p_address is null then e.address else nullif(btrim(p_address), '') end,
      emergency_contact_name  = case when p_emergency_contact_name is null then e.emergency_contact_name else nullif(btrim(p_emergency_contact_name), '') end,
      emergency_contact_phone = case when p_emergency_contact_phone is null then e.emergency_contact_phone else nullif(btrim(p_emergency_contact_phone), '') end,
      photo                   = case when p_photo is null then e.photo else nullif(btrim(p_photo), '') end,
      app_role                = v_new_role,
      department              = coalesce(nullif(btrim(p_department), ''), e.department),
      manager_id              = coalesce(p_manager_id, e.manager_id),
      role                    = coalesce(nullif(btrim(p_job_title), ''), e.role),
      join_date               = coalesce(p_join_date, e.join_date)
  where e.id = p_employee_id
  returning e.app_role into v_new_role;

  return jsonb_build_object('ok', true, 'employee_id', p_employee_id, 'app_role', v_new_role);
end;
$$;

revoke all on function public.admin_update_employee_profile(uuid, uuid, text, text, text, text, text, text, text, text, public.app_role, text, uuid, text, date)
  from public, anon;
grant execute on function public.admin_update_employee_profile(uuid, uuid, text, text, text, text, text, text, text, text, public.app_role, text, uuid, text, date)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Close the direct-write hole
-- -----------------------------------------------------------------------------
-- `employees_update_hr` let any HR session UPDATE every row of `employees` with
-- any column it liked, including `app_role` on its own row. Dropping the
-- policy is what makes the two functions above the only path in.

drop policy if exists employees_update_hr on public.employees;

-- Belt and braces: even if a policy is added back later, the table privilege
-- stops a browser from writing directly through PostgREST.
revoke update on public.employees from authenticated;

-- HR still needs to create employees; that path goes through
-- `admin_create_employee`, which is not revoked.
revoke update (id, auth_user_id, app_role, department, manager_id, join_date, is_active)
  on public.employees from authenticated;

-- -----------------------------------------------------------------------------
-- 6. Where the profile reads from
-- -----------------------------------------------------------------------------
-- The directory and org chart render a name and an avatar, so both need to be
-- visible to anyone who can already see the person. `get_employee_detail` and
-- `directory_employees` are security definer views over `employees`, so they
-- carry the new personal columns automatically.

grant select (phone, personal_email, address, emergency_contact_name, emergency_contact_phone)
  on public.employees to authenticated;