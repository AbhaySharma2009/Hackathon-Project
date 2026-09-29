import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { createClient } from "@/server/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const LEAVE_LABELS = {
  casual: "Casual",
  sick: "Sick",
  annual: "Annual",
  unpaid: "Unpaid",
} as const;

export default async function DashboardPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  const supabase = await createClient();

  // RLS scopes this to the signed-in employee: they can only ever read their own
  // balances, never another person's.
  const { data: balances } = await supabase
    .from("leave_balances")
    .select("leave_type, allocated, used, remaining")
    .eq("employee_id", employee.id)
    .eq("year", new Date().getFullYear())
    .order("leave_type");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back, {employee.name.split(" ")[0]}
        </h1>
        <p className="text-sm text-muted-foreground">
          {employee.role} · {employee.department} · joined{" "}
          {new Date(employee.join_date).toLocaleDateString("en-IN", {
            month: "long",
            year: "numeric",
          })}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Leave balance ({new Date().getFullYear()})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(balances ?? []).map((balance) => (
                <TableRow key={balance.leave_type}>
                  <TableCell className="font-medium">
                    {LEAVE_LABELS[balance.leave_type]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {balance.allocated}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {balance.used}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant={balance.remaining <= 2 ? "destructive" : "secondary"}
                    >
                      {balance.remaining}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
