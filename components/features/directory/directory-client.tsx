"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  LayoutGrid,
  List,
  Plus,
  Search,
  UserSearch,
  Users,
} from "lucide-react";
import { apiFetch, ClientApiError } from "@/shared/api-client";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { DirectoryEmployeeWithManager } from "@/server/employees";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/design/page-header";
import { EmptyState, ErrorState } from "@/components/design/states";
import { CardSkeleton, LoadingRegion, TableSkeleton } from "@/components/design/loaders";
import { EmployeeCard } from "@/components/features/directory/employee-card";
import {
  EmployeeDetailDrawer,
  type EmployeeDetail,
} from "@/components/features/directory/employee-detail-drawer";
import {
  EmployeeFormDialog,
  type EditableEmployee,
} from "@/components/features/directory/employee-form-dialog";
import { DeactivateDialog } from "@/components/features/directory/deactivate-dialog";

type Filters = {
  departments: string[];
  roles: string[];
  managers: { id: string; name: string }[];
};

type ListResponse = {
  data: DirectoryEmployeeWithManager[];
  meta: { page: number; page_size: number; total: number; total_pages: number };
};

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

export function DirectoryClient({
  isHr,
  selfId,
}: {
  isHr: boolean;
  selfId: string;
}) {
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [role, setRole] = useState("");
  const [managerId, setManagerId] = useState("");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"grid" | "table">("grid");
  const [nonce, setNonce] = useState(0);

  const [filters, setFilters] = useState<Filters>({ departments: [], roles: [], managers: [] });
  const [employees, setEmployees] = useState<DirectoryEmployeeWithManager[]>([]);
  const [meta, setMeta] = useState<ListResponse["meta"] | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EmployeeDetail | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deactivating, setDeactivating] = useState<EmployeeDetail | null>(null);

  const debouncedSearch = useDebouncedValue(search, 300);

  /** Every filter change also resets the page offset. */
  function updateFilter(setter: (value: string) => void, value: string) {
    setter(value);
    setPage(1);
  }

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (department) params.set("department", department);
    if (role) params.set("role", role);
    if (managerId) params.set("manager_id", managerId);
    params.set("page", String(page));
    return `${params.toString()}&n=${nonce}`;
  }, [debouncedSearch, department, role, managerId, page, nonce]);

  // `nonce` is only here to force a refetch after a mutation.
  const listUrl = `/api/employees?${queryString}`;

  useEffect(() => {
    const controller = new AbortController();

    apiFetch<{ data: Filters }>("/api/meta/filters", { signal: controller.signal })
      .then((res) => setFilters(res.data))
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestKey = queryString;

    apiFetch<ListResponse>(listUrl, { signal: controller.signal })
      .then((res) => {
        setEmployees(res.data);
        setMeta(res.meta);
        setError(null);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(err instanceof ClientApiError ? err.message : "Could not load the directory.");
        setEmployees([]);
      })
      .finally(() => setLoadedKey(requestKey));

    return () => controller.abort();
  }, [listUrl, queryString]);

  // Derived rather than assigned in an effect: the list is stale until the
  // response for the current query has landed.
  const loading = loadedKey !== queryString;
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const hasFilters = Boolean(debouncedSearch || department || role || managerId);
  const totalPages = meta?.total_pages ?? 1;

  const managerNames = useMemo(
    () => new Map(filters.managers.map((m) => [m.id, m.name])),
    [filters.managers],
  );

  function clearFilters() {
    setSearch("");
    setDepartment("");
    setRole("");
    setManagerId("");
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Directory"
        description={
          meta
            ? `${meta.total} ${meta.total === 1 ? "person" : "people"} across the organisation.`
            : "Everyone in the organisation, searchable by name, designation, team or manager."
        }
        actions={
          <>
            <div
              role="group"
              aria-label="Directory view"
              className="flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5"
            >
              <Button
                size="icon-sm"
                variant={view === "grid" ? "secondary" : "ghost"}
                onClick={() => setView("grid")}
                aria-pressed={view === "grid"}
                aria-label="Card view"
              >
                <LayoutGrid aria-hidden />
              </Button>
              <Button
                size="icon-sm"
                variant={view === "table" ? "secondary" : "ghost"}
                onClick={() => setView("table")}
                aria-pressed={view === "table"}
                aria-label="Table view"
              >
                <List aria-hidden />
              </Button>
            </div>

            {isHr ? (
              <Button
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="size-4" aria-hidden />
                Add employee
              </Button>
            ) : null}
          </>
        }
      />

      {/* Filters */}
      <Card>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2 md:col-span-1">
            <Label htmlFor="directory-search">Search</Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="directory-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, role, team…"
                className="pl-9"
              />
            </div>
          </div>

          <FilterSelect
            id="filter-department"
            label="Department"
            value={department}
            onChange={(v) => updateFilter(setDepartment, v)}
            options={filters.departments}
          />
          <FilterSelect
            id="filter-role"
            label="Designation"
            value={role}
            onChange={(v) => updateFilter(setRole, v)}
            options={filters.roles}
          />

          <div className="space-y-2">
            <Label htmlFor="filter-manager">Manager</Label>
            <div className="relative">
              <select
                id="filter-manager"
                className="h-9 w-full appearance-none rounded-lg border border-input bg-background pr-9 pl-3 text-sm shadow-xs transition-colors duration-150 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
                value={managerId}
                onChange={(e) => updateFilter(setManagerId, e.target.value)}
              >
                <option value="">Everyone</option>
                {filters.managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Both views read the same `employees` array — the toggle is presentation
          only, so switching never refetches. */}
      {error ? (
        <ErrorState
          title="We couldn't load the directory"
          message={error}
          onRetry={refresh}
          retrying={loading}
        />
      ) : loading ? (
        view === "grid" ? (
          <>
            <LoadingRegion label="Loading employees" />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <CardSkeleton key={index} />
              ))}
            </div>
          </>
        ) : (
          <>
            <LoadingRegion label="Loading employees" />
            <TableSkeleton rows={6} columns={6} />
          </>
        )
      ) : employees.length === 0 ? (
        <EmptyState
          icon={hasFilters ? UserSearch : Users}
          title={hasFilters ? "No employees match these filters" : "The directory is empty"}
          description={
            hasFilters
              ? "Try a different search term, or clear the filters to see everyone."
              : "Employees added in OrgFlow will appear here."
          }
          action={
            hasFilters ? (
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Showing <span className="tabular text-foreground">{employees.length}</span> of{" "}
            <span className="tabular text-foreground">{meta?.total ?? employees.length}</span>{" "}
            {hasFilters ? "matching" : ""}{" "}
            {meta?.total === 1 ? "person" : "people"}.
          </p>

          {view === "grid" ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {employees.map((employee) => (
                <EmployeeCard
                  key={employee.id}
                  employee={employee}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="px-0">
                <Table className="min-w-[52rem]">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="h-11 pl-5 text-sm font-medium text-muted-foreground">
                        Name
                      </TableHead>
                      <TableHead className="text-sm font-medium text-muted-foreground">
                        Designation
                      </TableHead>
                      <TableHead className="text-sm font-medium text-muted-foreground">
                        Department
                      </TableHead>
                      <TableHead className="text-sm font-medium text-muted-foreground">
                        Manager
                      </TableHead>
                      <TableHead className="text-sm font-medium text-muted-foreground">
                        Status
                      </TableHead>
                      <TableHead className="pr-5 text-sm font-medium text-muted-foreground">
                        Joined
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {employees.map((employee) => (
                      <TableRow
                        key={employee.id}
                        className="cursor-pointer"
                        onClick={() => setSelectedId(employee.id)}
                      >
                        <TableCell className="pl-5 text-sm">
                          {/* A real button, so the row is reachable by keyboard as
                              well as by pointer. The row handler stays for the
                              mouse affordance across the whole line. */}
                          <button
                            type="button"
                            onClick={() => setSelectedId(employee.id)}
                            className="flex items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Avatar size="sm">
                              {employee.photo ? (
                                <AvatarImage src={employee.photo} alt="" />
                              ) : null}
                              <AvatarFallback>{initials(employee.name)}</AvatarFallback>
                            </Avatar>
                            <span className="font-medium">{employee.name}</span>
                          </button>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {employee.role}
                        </TableCell>
                        <TableCell className="text-sm">
                          <Badge variant="secondary">{employee.department}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {employee.manager_id
                            ? (managerNames.get(employee.manager_id) ??
                              employee.manager_name ??
                              "—")
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {employee.is_active ? (
                            <Badge variant="success">Active</Badge>
                          ) : (
                            <Badge variant="neutral">Inactive</Badge>
                          )}
                        </TableCell>
                        <TableCell className="pr-5 text-sm text-muted-foreground">
                          <span className="tabular">
                            {new Date(employee.join_date).toLocaleDateString("en-IN", {
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Pagination */}
      {meta && meta.total > 0 && totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted-foreground" aria-live="polite">
            Page <span className="tabular text-foreground">{meta.page}</span> of{" "}
            <span className="tabular text-foreground">{totalPages}</span> ·{" "}
            <span className="tabular text-foreground">{meta.total}</span> people
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <EmployeeDetailDrawer
        key={`drawer-${selectedId ?? "closed"}`}
        employeeId={selectedId}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onEdit={(d) => {
          setEditing(d);
          setSelectedId(null);
          setFormOpen(true);
        }}
        onDeactivate={(d) => {
          setDeactivating(d);
          setSelectedId(null);
        }}
      />

      <EmployeeFormDialog
        // Remount on target change so the form resets without an effect.
        key={`form-${formOpen ? "open" : "closed"}-${editing?.employee.id ?? "new"}`}
        open={formOpen}
        onOpenChange={setFormOpen}
        employee={editing ? toEditable(editing) : null}
        departments={filters.departments}
        managers={filters.managers}
        selfId={selfId}
        onSaved={refresh}
      />

      <DeactivateDialog
        key={deactivating?.employee.id ?? "none"}
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
        employee={deactivating?.employee ?? null}
        reports={deactivating?.reports ?? []}
        managers={filters.managers}
        onDone={refresh}
      />
    </div>
  );
}

function toEditable(detail: EmployeeDetail): EditableEmployee {
  return {
    id: detail.employee.id,
    name: detail.employee.name,
    email: detail.employee.email,
    role: detail.employee.role,
    department: detail.employee.department,
    manager_id: detail.employee.manager_id,
    join_date: detail.employee.join_date,
    photo: detail.employee.photo,
  };
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <select
          id={id}
          className="h-9 w-full appearance-none rounded-lg border border-input bg-background pr-9 pl-3 text-sm shadow-xs transition-colors duration-150 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">All</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
      </div>
    </div>
  );
}
