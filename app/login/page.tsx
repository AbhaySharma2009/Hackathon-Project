import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { LoginForm } from "@/components/auth/login-form";

export default async function LoginPage({
  searchParams,
}: {
  // Next.js 16: request-time props are async.
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // The proxy already redirects signed-in users, this keeps the page correct
  // when it is rendered directly (e.g. after a hard refresh).
  const employee = await getCurrentEmployee();
  if (employee) redirect("/dashboard");

  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-muted/40 px-4">
      <div className="text-center">
        <p className="text-sm font-medium tracking-tight text-muted-foreground">
          OrgFlow
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Don&apos;t just manage employee leave — understand your workforce.
        </h1>
      </div>
      <LoginForm next={next} />
    </main>
  );
}
