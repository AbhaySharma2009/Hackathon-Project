import type { DirectoryEmployeeWithManager } from "@/lib/employees";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function formatJoinDate(value: string) {
  return new Date(value).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

export function EmployeeCard({
  employee,
  onSelect,
}: {
  employee: DirectoryEmployeeWithManager;
  onSelect: (id: string) => void;
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => onSelect(employee.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect(employee.id);
      }}
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <CardContent className="flex items-start gap-4">
        <Avatar className="size-12">
          {employee.photo ? <AvatarImage src={employee.photo} alt="" /> : null}
          <AvatarFallback>{initials(employee.name)}</AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{employee.name}</p>
          <p className="truncate text-sm text-muted-foreground">{employee.role}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{employee.department}</Badge>
            {employee.manager_name ? (
              <span className="truncate text-xs text-muted-foreground">
                Reports to {employee.manager_name}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Top of the org</span>
            )}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            Joined {formatJoinDate(employee.join_date)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
