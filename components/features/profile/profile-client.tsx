"use client";

import { useEffect, useState } from "react";
import { ProfileClientInner } from "@/components/features/profile/profile-client-inner";
import { KpiSkeleton } from "@/components/design/loaders";
import { ErrorState } from "@/components/design/states";
import { apiFetch } from "@/shared/api-client";
import type { AppRole } from "@/shared/types";

interface BalanceRow {
  leave_type: string;
  allocated: number;
  used: number;
}

interface ProfileResponse {
  personal: {
    name: string;
    photo: string | null;
    phone: string | null;
    personal_email: string | null;
    address: string | null;
    emergency_contact_name: string | null;
    emergency_contact_phone: string | null;
  };
  organisation: {
    employee_id: string;
    work_email: string;
    app_role: AppRole;
    designation: string;
    department: string;
    manager_name: string | null;
    joining_date: string;
    account_status: string;
  };
  balances: {
    leave_type: string;
    allocated: number;
    used: number;
    remaining: number;
  }[];
}

export function ProfileClient({ employeeId }: { employeeId: string }) {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [profileRes, balancesRes] = await Promise.all([
          apiFetch<{ data: ProfileResponse }>("/api/profile"),
          apiFetch<{ data: BalanceRow[] }>(
            `/api/leave-balances/${employeeId}?year=${new Date().getFullYear()}`,
          ),
        ]);
        if (!cancelled) {
          setData({
            personal: profileRes.data.personal,
            organisation: profileRes.data.organisation,
            balances: balancesRes.data.map((b) => ({
              leave_type: b.leave_type,
              allocated: b.allocated,
              used: b.used,
              remaining: b.allocated - b.used,
            })),
          });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load profile");
      }
    }
    load();
    return () => { cancelled = true; };
  }, [employeeId]);

  if (error) {
    return (
      <ErrorState
        title="We couldn't load your profile"
        message={error}
        onRetry={() => window.location.reload()}
      />
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
      </div>
    );
  }

  // Transform data to match ProfileClientInner props
  const personal = {
    name: data.personal.name,
    photo: data.personal.photo,
    phone: data.personal.phone ?? null,
    personal_email: data.personal.personal_email ?? null,
    address: data.personal.address ?? null,
    emergency_contact_name: data.personal.emergency_contact_name ?? null,
    emergency_contact_phone: data.personal.emergency_contact_phone ?? null,
  };

  const organisation = {
    employee_id: data.organisation.employee_id,
    work_email: data.organisation.work_email,
    app_role: data.organisation.app_role,
    designation: data.organisation.designation,
    department: data.organisation.department,
    manager_name: data.organisation.manager_name,
    joining_date: data.organisation.joining_date,
    account_status: data.organisation.account_status,
  };

  return <ProfileClientInner personal={personal} organisation={organisation} balances={data.balances} />;
}