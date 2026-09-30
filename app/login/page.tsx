import { redirect } from "next/navigation";
import { BarChart3, GitPullRequestArrow, Sparkles, Users } from "lucide-react";
import { getCurrentEmployee } from "@/server/auth";
import { LoginForm } from "@/components/auth/login-form";
import { OrgFlowMark } from "@/components/layout/brand";

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
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel. A quiet gradient and a static grid — no looping animation,
          so the page costs nothing to look at and nothing to render. */}
      <section className="relative hidden overflow-hidden bg-sidebar p-10 lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(120%_100%_at_0%_0%,oklch(0.62_0.16_264/0.16),transparent_60%),radial-gradient(90%_80%_at_100%_100%,oklch(0.65_0.13_195/0.14),transparent_55%)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.35] [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(70%_60%_at_50%_40%,black,transparent)]"
        />

        <div className="relative flex items-center gap-3">
          <OrgFlowMark className="size-10" />
          <span className="text-nav font-semibold tracking-tight">OrgFlow</span>
        </div>

        <div className="relative max-w-lg space-y-7">
          <h1 className="text-4xl leading-[1.15] font-semibold tracking-tight text-balance">
            Don&apos;t just manage employee leave —{" "}
            <span className="text-primary">understand your workforce.</span>
          </h1>
          <p className="text-body text-muted-foreground">
            One place for balances, requests and multi-level approvals, with the analytics and
            the AI assistant built on the same rules your database already enforces.
          </p>

          <ul className="grid gap-3.5">
            {[
              {
                icon: GitPullRequestArrow,
                title: "Approval chains that follow the rules",
                body: "Manager, department head, then HR — decided in one transaction, never twice.",
              },
              {
                icon: BarChart3,
                title: "Workforce analytics you can trust",
                body: "Every figure comes from a role-scoped database function, not a cached guess.",
              },
              {
                icon: Sparkles,
                title: "AI that can only read what you can",
                body: "The assistant picks from a fixed tool catalog. It never writes its own SQL.",
              },
              {
                icon: Users,
                title: "Leave impact before you approve",
                body: "See who is already away and what a request does to team coverage.",
              },
            ].map((item) => (
              <li key={item.title} className="flex gap-3">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border bg-background/70 text-primary">
                  <item.icon className="size-4" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{item.title}</span>
                  <span className="block text-sm text-muted-foreground">{item.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-muted-foreground">
          Role-scoped by RLS · audited AI · transactional approvals
        </p>
      </section>

      {/* Sign-in panel */}
      <section className="flex flex-col justify-center gap-8 px-5 py-10 sm:px-8 lg:px-12">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-8">
          <div className="flex items-center gap-3 lg:hidden">
            <OrgFlowMark className="size-10" />
            <span className="text-section-title font-semibold tracking-tight">OrgFlow</span>
          </div>

          <div className="space-y-2">
            <h2 className="text-page-title font-semibold tracking-tight">Welcome back</h2>
            <p className="text-body text-muted-foreground">
              Sign in with your company email address to continue.
            </p>
          </div>

          <LoginForm next={next} />
        </div>
      </section>
    </main>
  );
}
