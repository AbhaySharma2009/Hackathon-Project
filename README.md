
# OrgFlow

**Don't just manage employee leave — understand your workforce.**

Hackathon SaaS HR portal (Problem Statement 10: Intelligent HR, Leave & Organization Portal).

- **Phase 0** — the Next.js app, the full Supabase schema, seed data, and role-based auth.
- **Phase 1** — Row Level Security on every table, the employee API, and the Employee Directory.

---

## Stack

| Layer     | Choice                                                          |
| --------- | --------------------------------------------------------------- |
| Frontend  | Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui   |
| Icons     | lucide-react                                                     |
| Backend   | Supabase (Postgres, Auth, RLS, GiST exclusion constraints)       |
| Charts    | recharts (wired, used from later phases)                         |
| Validation| zod · Dates: date-fns                                            |
| LLM       | server-only route handlers, key never leaves the server          |

---

## 1. Create the Supabase project

1. Go to <https://supabase.com> and create a project (or use an existing one).
2. Copy the project URL and the `anon` and `service_role` keys
   (**Project Settings → API**).

## 2. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable                        | Where it comes from          |
| ------------------------------- | ---------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Project URL                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`| `anon` public key           |
| `SUPABASE_SERVICE_ROLE_KEY`     | `service_role` key (server only) |
| `LLM_API_KEY`, `LLM_MODEL`      | LLM provider (used in later phases) |

> `SUPABASE_SERVICE_ROLE_KEY` is only ever read by server code
> (`lib/supabase/admin.ts`, guarded with `server-only`). It is never prefixed with
> `NEXT_PUBLIC_` and must never be imported into a Client Component.

## 3. Apply the schema and seed the data

Either paste the files into the Supabase **SQL Editor** and run them in this order:

1. `supabase/migrations/0001_schema.sql`
2. `supabase/migrations/0002_rls.sql`
3. `supabase/seed.sql`

…or use the Supabase CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
psql "$DATABASE_URL" -f supabase/seed.sql
```

Both files are idempotent — re-running them is safe.

## 4. Create the demo auth users

```bash
npm install
npm run seed:auth
```

The script creates three confirmed auth users, links each one to its
`employees.auth_user_id`, and prints the credentials.

## 5. Run the app

```bash
npm run dev
# http://localhost:3000
```

---

## Demo accounts

| Role     | Email                     | Password       | Employee        |
| -------- | ------------------------- | -------------- | --------------- |
| employee | `neha.gupta@orgflow.dev`  | `OrgFlow@2026` | Neha Gupta      |
| manager  | `vikram.sethi@orgflow.dev`| `OrgFlow@2026` | Vikram Sethi    |
| hr       | `rohan.iyer@orgflow.dev`  | `OrgFlow@2026` | Rohan Iyer      |

Sign in at `/login`. Each role sees a different sidebar:

- **Employee** — Dashboard, Directory, My Leaves, Calendar, Org Chart
- **Manager** — the above **+ Approvals, Team Availability**
- **HR** — the above **+ HR Dashboard**

> `hr` also receives Approvals and Team Availability: `can_manage()` grants HR the
> same authority as a manager, so hiding those pages from HR would hide work the
> database explicitly allows.

---

## Seeded data

15 employees across 4 departments, three levels deep:

```
Aditya Rao (CEO)
├── Vikram Sethi — VP of Engineering
│   └── Sanjay Kapoor — Engineering Manager
│       ├── Neha Gupta — Senior Backend Engineer      (employee)
│       ├── Karthik Reddy — Frontend Engineer         (employee)
│       └── Priya Nair — DevOps Engineer              (employee)
├── Ananya Iyer — Head of Product
│   └── Ishita Desai — Product Lead
│       └── Arjun Mehta — Product Designer            (employee)
├── Rahul Menon — Head of Sales
│   └── Nikhil Verman — Sales Manager
│       └── Fatima Sheikh — Account Executive         (employee)
└── Meera Krishnan — Head of People & Operations
    └── Deepak Joshi — HR Business Partner
        └── Rohan Iyer — People Operations Specialist (hr)
```

**Leave requests (6)** — 3 approved, 2 pending, 1 rejected:

| # | Employee     | Type   | Dates          | Days | Status   | Notes                                        |
| - | ------------ | ------ | -------------- | ---- | -------- | -------------------------------------------- |
| 1 | Neha Gupta   | annual | 10–15 Oct      | 4    | approved | overlap-demo anchor for the Engineering team |
| 2 | Karthik Reddy| annual | 3–7 Aug        | 5    | approved |                                               |
| 3 | Fatima Sheikh| casual | 20 Jul – 4 Aug | 12   | approved | exhausts her casual balance                  |
| 4 | Karthik Reddy| annual | 13–16 Oct      | 4    | pending  | same team and period as #1                   |
| 5 | Priya Nair   | sick   | 23–24 Nov      | 2    | pending  |                                               |
| 6 | Deepak Joshi | casual | 14–16 Sep      | 3    | rejected | has a `manager_comment`                      |

**Balances** — casual 12, sick 10, annual 20, unpaid 0 for the current year, with
deliberate demo cases:

| Employee      | Case                                                      |
| ------------- | --------------------------------------------------------- |
| Karthik Reddy | annual 27 allocated / 5 used → **22 remaining** (a 25-day request fails) |
| Fatima Sheikh | casual **exhausted** (12 used)                            |
| Arjun Mehta   | sick 9 used → **1 remaining**                              |
| Nikhil Verman | casual 10 used → **2 remaining**                           |
| Neha Gupta    | annual 4 used → 16 remaining                               |

`used` is derived from the approved requests, so the ledger can never drift from
the request history.

---

## How to verify

**Row counts**

```sql
select count(*) as employees from employees;                          -- 15
select count(distinct department) from employees;                    -- 4
select status, count(*) from leave_requests group by status;         -- 3 approved / 2 pending / 1 rejected
```

**An overlapping approved leave is rejected by the database itself**

```sql
insert into leave_requests
  (employee_id, leave_type, start_date, end_date, days, reason, status, decided_by, decided_at)
values
  ('00000000-0000-4000-8000-000000000007', 'casual', '2026-10-13', '2026-10-14', 2,
   'overlap test', 'approved', '00000000-0000-4000-8000-000000000002', now());
-- ERROR: 23P01: conflicting key value violates exclusion constraint
--         "leave_requests_no_overlap_approved"
```

**A manager cycle is rejected**

```sql
update employees set manager_id = '00000000-0000-4000-8000-000000000007'
 where id = '00000000-0000-4000-8000-000000000002';
-- ERROR: P0001: Manager cycle detected ...
```

**RLS** — with a signed-in session, `select * from leave_balances` returns 4 rows
for the employee demo account and 60 rows for the HR account.

**Employee session cannot touch the employees table** (`npm test`)

```ts
await employeeClient.from("employees").insert({ /* … */ });
// error 42501 — insufficient_privilege

await employeeClient.from("employees").update({ app_role: "hr" }).eq("id", selfId).select("id");
// [] — RLS matched zero rows, so nothing changed

await employeeClient.from("leave_requests").select("id");
// only this employee's own rows

await employeeClient.from("employees").select("email");
// error — the column is not granted to `authenticated`
```

---

## Phase 1 — Security and the Employee Directory

### Row Level Security

`supabase/migrations/0002_rls.sql` is the enforcement layer. Helper functions,
all `SECURITY DEFINER` + `STABLE` so a policy on `employees` can resolve the
caller without recursing:

| Function                     | Returns                                            |
| ---------------------------- | -------------------------------------------------- |
| `current_employee_id()`      | the caller's `employees.id`                        |
| `current_app_role()`         | `employee` / `manager` / `hr`                      |
| `is_manager_of(uuid)`        | TRUE when that person is a **direct** report of the caller |
| `can_manage(uuid)`           | `is_hr() or is_manager_of(uuid)`                   |
| `current_employee()`         | the caller's own full row                          |
| `get_employee_detail(uuid)`  | full row for self/HR/manager, directory fields otherwise |

Policies:

| Table             | Select                                       | Write                                    |
| ----------------- | -------------------------------------------- | ---------------------------------------- |
| `employees`       | any signed-in user (deactivated rows: HR only) | insert / update / delete: **hr only**    |
| `leave_requests`  | self, direct reports, or HR                    | insert: self **and** `status = 'pending'` — **no** update/delete policy at all |
| `leave_balances`  | self, direct reports, or HR                    | none — mutations go through audited RPCs |
| `alerts`          | org-wide alerts, own alerts, HR                | update own                                |

**Column-level access.** `authenticated` is granted `SELECT` on `employees` only
for `id, name, photo, role, department, manager_id, join_date, is_active`. A
browser session physically cannot read `email`, `app_role` or `auth_user_id`;
anything richer goes through the RPCs above, which make the authorisation
decision in the database. `is_active` is included in the grant so HR can see and
manage deactivated accounts.

### API

| Method   | Route                    | Who             | Notes                                                                 |
| -------- | ------------------------ | --------------- | --------------------------------------------------------------------- |
| `GET`    | `/api/employees`         | any employee    | `?search=&department=&role=&manager_id=&page=&page_size=` (default 12) |
| `POST`   | `/api/employees`         | **hr**          | validates manager exists, email uniqueness                            |
| `GET`    | `/api/employees/[id]`    | any employee    | detail scoped to the caller; also returns manager, reports, permissions |
| `PATCH`  | `/api/employees/[id]`    | **hr**          | includes `manager_id` (reassignment) with cycle validation            |
| `DELETE` | `/api/employees/[id]`    | **hr**          | soft delete; requires `?reassign_to=<id>` when active reports remain  |
| `GET`    | `/api/meta/filters`      | any employee    | distinct departments, designations, managers                          |

Every failure uses the standard body:

```json
{ "error": { "code": "OVERLAP", "message": "…", "details": { "issues": [] } } }
```

`manager_id` cycles are caught twice: `assertNoManagerCycle()` walks the
reporting chain for a friendly message, and the `prevent_manager_cycle` trigger
is the authority.

### Directory UI

`/directory` — card grid ⇄ table toggle, debounced search across name / role /
department, department + designation + manager filters that combine, pagination,
skeleton loading state and an empty state. Clicking a person opens a drawer with
their record, manager and direct reports; contact details are shown only to the
person, their manager and HR, with an explicit note when they are hidden. HR also
gets **Add employee**, **Edit** (including changing the manager) and
**Deactivate** with a confirmation that collects a replacement manager.

---

## Project structure

```
app/
  (app)/                  authenticated shell
    layout.tsx            resolves the session, renders sidebar + topbar
    dashboard/            own leave balance (RLS-scoped)
    directory/            Phase 1 — searchable employee directory
    my-leaves/  calendar/  org-chart/                        placeholders
    approvals/  team-availability/  hr-dashboard/            placeholders + role gates
  actions/auth.ts         server actions: signIn / signOut
  api/
    employees/route.ts    list + create
    employees/[id]/route.ts  detail + update + deactivate
    meta/filters/route.ts   filter dropdown options
  login/page.tsx
  layout.tsx  page.tsx  globals.css
components/
  auth/login-form.tsx
  directory/              directory-client, cards, detail drawer, HR dialogs
  layout/sidebar.tsx  topbar.tsx  page-placeholder.tsx
  ui/                     shadcn/ui components
lib/
  api-client.ts           fetch wrapper that unwraps the error body
  api/errors.ts           ApiError + toErrorResponse
  api/session.ts          requireSession / requireRole / requireHr
  auth.ts                 getCurrentEmployee() + role guards (server-only)
  employees.ts            directory queries, zod schemas, cycle validation
  errors.ts               the standard `{ error: { code, message, details? } }` shape
  nav.ts                  role → sidebar definition
  types.ts                hand-written Database types
  supabase/
    client.ts             browser client (anon key)
    server.ts             cookie-session server client
    admin.ts              service-role client, `server-only` guarded
    admin-core.ts         implementation shared with the CLI script
proxy.ts                  auth gate for every app route
scripts/seed-auth.ts      creates and links the demo auth users
supabase/
  migrations/0001_schema.sql
  migrations/0002_rls.sql
  seed.sql
tests/rls.test.ts         RLS integration tests against the live project
```

## Rules the code follows

1. Leave rules (dates, overlap, balance) live in Postgres and the server, never in
   the UI.
2. `employees.app_role` is read from the database on every request; `/approvals`,
   `/team-availability` and `/hr-dashboard` redirect on the server, and RLS blocks
   the data underneath them.
3. `employee_id` always comes from `auth.uid()`, never from a request body.
4. Working-day duration is `public.working_days()` (Mon–Fri inclusive) — the seed
   uses it too, so `days` is never hand-entered.
5. Non-negotiables and the phase breakdown live in [`AGENT_CONTEXT.md`](./AGENT_CONTEXT.md).

## Scripts

```bash
npm run dev         # dev server
npm run build       # production build
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # RLS integration tests (needs a live Supabase project)
npm run seed:auth   # create + link the demo auth users

