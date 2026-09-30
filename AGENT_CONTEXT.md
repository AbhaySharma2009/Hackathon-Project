# OrgFlow — Project Context & Rules

Paste this block at the start of every fresh session/workspace. Keep it as a project rule/context file so every phase can refer to it.

---

You are building "OrgFlow", a hackathon SaaS HR portal (Problem Statement PS 10: Intelligent HR, Leave & Organization Portal). Tagline: "Don't just manage employee leave — understand your workforce."

## TECH STACK (do not deviate)
- Frontend: Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui + lucide-react
- Backend/DB: Supabase (Postgres, Auth, Row Level Security, RPC functions, Realtime, Storage)
- Server-side AI + API logic: Next.js Route Handlers (server only). LLM API key only in server env vars, never exposed to the client.
- Charts: recharts. Org chart: react-d3-tree or @xyflow/react. Validation: zod. Dates: date-fns.
- Package manager: npm. Keep code typed, modular, and commented where logic is non-obvious.

## ROLES
- employee, manager, hr (column employees.app_role). Managers are also employees. Role checks are enforced SERVER-SIDE and by RLS, never only in the UI.

## HIERARCHICAL APPROVAL (Phase 3.5)
- Leave is approved in levels, not in one step. Chain length is derived from working days: 1-3 -> direct manager, 4-7 -> manager + department head, 8+ -> manager + department head + HR.
- Approvers are resolved from `employees.manager_id` at SUBMISSION time and frozen into `leave_approval_steps.approver_employee_id`. Changing `manager_id` later affects only future requests; there is deliberately no trigger that rewrites historical steps.
- "Department head" means the topmost ancestor in the reporting chain who is in the same `department` as the requester. It is derived, never configured. If a required level resolves to somebody already on the chain (or to the requester), that step is written as `skipped` so one person never signs twice and a requested level is never silently dropped.
- A request whose required chain cannot be resolved is parked as `leave_status = 'approval_blocked'` with `blocked_reason` set. It is never auto-approved. Only HR may clear it, and doing so is recorded as a real approval step.
- The balance is spent ONLY when the final actionable step is approved, inside that same transaction under the same `leave_balances` row lock. A mid-chain signature must not touch the ledger.
- Rejection at any level ends the request immediately and skips the remaining steps.
- Self-approval is refused in the database (`can_decide_leave_step`), independent of any UI.

## NON-NEGOTIABLE RULES
1. All leave business rules (date validation, overlap, balance) are enforced on the server / in Postgres. The UI and the AI may never bypass them.
2. Leave balance is decremented ONLY when a request is approved, inside a single DB transaction with row locks (SELECT ... FOR UPDATE).
3. Overlap = any date intersection with the same employee's approved or pending requests. Return clear error codes/messages.
4. Working-day duration = Mon–Fri inclusive between start and end (weekends excluded).
5. The AI never writes raw SQL and never receives DB credentials. It only calls whitelisted, role-scoped server functions. employee_id always comes from the authenticated session, never from the LLM.
6. The service-role key is used only in server code, never in client bundles.
7. Standard error shape: { "error": { "code": "OVERLAP" | "INSUFFICIENT_BALANCE" | "INVALID_DATES" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION", "message": string, "details"?: object } }
8. Build only what the current phase asks. Do not pre-build later phases. Do not refactor unrelated code.

## DATA MODEL (Postgres)
- enums: leave_type ('casual','sick','annual','unpaid'), leave_status ('pending','approved','rejected','cancelled'), app_role ('employee','manager','hr')
- employees: id uuid pk, auth_user_id uuid unique -> auth.users, name, email unique, photo, role (designation), app_role, department, manager_id uuid self-FK, join_date date, is_active bool. CHECK manager_id <> id. Trigger to prevent manager cycles.
- leave_requests: id, employee_id FK, leave_type, start_date, end_date, days numeric (computed server-side), reason, status default 'pending', manager_comment, decided_by FK, decided_at, created_at, current_approval_level int, blocked_reason text. CHECK end_date >= start_date.
- leave_approval_steps: id, leave_request_id FK, level int (1-based, unique per request), approver_employee_id FK (frozen snapshot), approver_role enum ('manager','department_head','hr'), status enum ('pending','approved','rejected','skipped'), comment, decided_at, created_at.
- leave_balances: id, employee_id FK, year int, leave_type, allocated numeric, used numeric default 0, remaining generated (allocated - used). UNIQUE(employee_id, year, leave_type).
- alerts: id, scope_employee_id, type, severity, message, related_date, created_at, is_read, dedupe_key text (unique when present), related_request_id FK. The dedupe_key is what makes alert generation idempotent: every approval-transition insert is `on conflict do nothing`, so a refresh never duplicates an alert.

## ASSUMPTIONS
- single organization, leaves don't cross calendar years, public holidays not modeled, unpaid leave has no balance cap.

## END-OF-PHASE CHECKLIST
- run the app (npm run dev) and a type-check/build, fix all errors
- output a short summary: files created/changed, how to test, and anything skipped
