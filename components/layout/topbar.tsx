import Image from "next/image";
import { LogOut } from "lucide-react";
import { signOut } from "@/app/actions/auth";
import type { CurrentEmployee } from "@/server/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const ROLE_LABEL: Record<CurrentEmployee["app_role"], string> = {
  employee: "Employee",
  manager: "Manager",
  hr: "HR",
};

export function Topbar({ employee }: { employee: CurrentEmployee }) {
  return (
    <header className="flex h-16 items-center justify-between gap-4 border-b bg-card px-4 md:px-6">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{employee.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {employee.role} · {employee.department}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Badge variant="secondary">{ROLE_LABEL[employee.app_role]}</Badge>

        {employee.photo ? (
          <Image
            src={employee.photo}
            alt=""
            width={36}
            height={36}
            className="size-9 rounded-full object-cover"
          />
        ) : (
          <span className="grid size-9 place-items-center rounded-full bg-muted text-xs font-semibold">
            {employee.name.slice(0, 2).toUpperCase()}
          </span>
        )}

        <form
          action={async () => {
            "use server";
            await signOut();
          }}
        >
          <Button type="submit" variant="ghost" size="sm">
            <LogOut className="size-4" aria-hidden />
            Sign out
          </Button>
        </form>
      </div>
    </header>
  );
}
