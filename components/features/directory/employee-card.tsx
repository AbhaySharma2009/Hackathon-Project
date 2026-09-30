import { ArrowRight, CalendarDays, CheckCircle2, UserX, Users } from "lucide-react";
import type { DirectoryEmployeeWithManager } from "@/server/employees";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/shared/utils";

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

/**
 * One person in the directory.
 *
 * The whole card is the target: it is a single record, and the drawer is the only
 * thing it opens. `group/employee` drives the hover affordances from the card
 * itself so the avatar, the labels and the chevron all react together.
 */
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
        if (event.key === "Enter" || event.key === " ") {
          // Space would otherwise scroll the page behind the card.
          event.preventDefault();
          onSelect(employee.id);
        }
      }}
      className={cn(
        "group/employee cursor-pointer transition-[box-shadow,border-color] duration-200",
        "hover:shadow-md hover:ring-2 hover:ring-primary/20",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      <CardContent className="flex items-start gap-4">
        <Avatar size="lg">
          {employee.photo ? <AvatarImage src={employee.photo} alt="" /> : null}
          <AvatarFallback>{initials(employee.name)}</AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-card-title font-semibold">{employee.name}</p>
              <p className="truncate text-sm text-muted-foreground">{employee.role}</p>
            </div>
            <ArrowRight
              className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-[transform,opacity] duration-200 group-hover/employee:translate-x-0.5 group-hover/employee:opacity-100 group-focus-visible/employee:translate-x-0.5 group-focus-visible/employee:opacity-100"
              aria-hidden
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{employee.department}</Badge>
            {employee.is_active ? (
              <Badge variant="success">
                <CheckCircle2 aria-hidden />
                Active
              </Badge>
            ) : (
              <Badge variant="neutral">
                <UserX aria-hidden />
                Inactive
              </Badge>
            )}
          </div>

          {/* Context the directory row cannot hold: who they report to and since
              when. Icons are decorative and every row keeps its words, so the
              meaning never depends on the icon alone. */}
          <dl className="mt-3 space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="size-3.5 shrink-0" aria-hidden />
              <dd className="truncate">
                {employee.manager_name ? `Reports to ${employee.manager_name}` : "Top of the org"}
              </dd>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CalendarDays className="size-3.5 shrink-0" aria-hidden />
              <dd className="tabular truncate">Joined {formatJoinDate(employee.join_date)}</dd>
            </div>
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}
