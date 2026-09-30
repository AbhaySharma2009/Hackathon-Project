"use client";

/**
 * Smart HR Query.
 *
 * The user asks a workforce question in English and gets a table back. What they
 * do not get is a model-written answer: the server picks one function from a fixed
 * catalog, runs it, and writes the summary sentence from the returned rows. This
 * component renders both as given.
 *
 * The "Show query details" toggle is deliberately not hidden. Naming the function
 * and the exact date range behind a number is what lets a reader trust it, and it
 * makes the constraint visible — there is a fixed set of questions this can
 * answer, and this is the one that was run.
 */
import { useState } from "react";
import { ChevronDown, Loader2, Search, Sparkles } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { HrQueryResult, HrQueryUnsupported } from "@/shared/types";

/** The four questions the server offers when it cannot answer. Kept in step with
 *  `HR_QUERY_EXAMPLES`, which is the source of truth. */
const EXAMPLES = [
  "Who is on leave next week?",
  "How many employees are on leave in Engineering?",
  "Which department has the most leave usage this quarter?",
  "How many pending leave approvals are there?",
];

type Response = {
  data: HrQueryResult | HrQueryUnsupported;
  meta: { available: boolean; reason?: string };
};

type State =
  | { kind: "idle" }
  | { kind: "loading"; question: string }
  | { kind: "answered"; question: string; data: Response["data"]; available: boolean }
  | { kind: "failed"; question: string; message: string };

/**
 * `variant="page"` promotes the question box to a full-width search field and
 * lets the result breathe, for the dedicated /smart-hr-query route. The card
 * variant is the compact panel that sits at the bottom of the HR dashboard.
 * Behaviour, API and security are identical either way.
 */
export function SmartHrQueryCard({ variant = "card" }: { variant?: "card" | "page" }) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [showDetails, setShowDetails] = useState(false);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    setQuestion(trimmed);
    setShowDetails(false);
    setState({ kind: "loading", question: trimmed });

    try {
      const response = await apiFetch<Response>("/api/ai/hr-query", {
        method: "POST",
        body: JSON.stringify({ question: trimmed }),
      });
      setState({
        kind: "answered",
        question: trimmed,
        data: response.data,
        available: response.meta.available,
      });
    } catch (error) {
      setState({
        kind: "failed",
        question: trimmed,
        message: error instanceof Error ? error.message : "The query could not be run.",
      });
    }
  }

  const page = variant === "page";

  return (
    <Card className={page ? "border-primary/20 shadow-md" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-4" aria-hidden />
          </span>
          {page ? "Ask your workforce" : "Smart HR Query"}
        </CardTitle>
        <CardDescription>
          Ask about leave, balances, approvals or availability in plain English. Answers come from
          the same role-scoped reports as the rest of the dashboard.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <form
          className={page ? "flex flex-col gap-2.5 sm:flex-row" : "flex gap-2"}
          onSubmit={(event) => {
            event.preventDefault();
            void ask(question);
          }}
        >
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Which department has the lowest availability next week?"
              aria-label="Ask a workforce question"
              maxLength={500}
              className={page ? "h-12 pl-9 text-body" : undefined}
            />
          </div>
          <Button
            type="submit"
            size={page ? "lg" : "default"}
            disabled={state.kind === "loading" || question.trim().length < 3}
          >
            {state.kind === "loading" ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {page ? "Running…" : <span className="sr-only">Running query</span>}
              </>
            ) : (
              "Ask"
            )}
          </Button>
        </form>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Try one of these
          </p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={state.kind === "loading"}
                onClick={() => void ask(example)}
                className="rounded-full border bg-card px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:border-primary/30 hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        {state.kind === "loading" ? <LoadingState question={state.question} /> : null}

        {state.kind === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        ) : null}

        {state.kind === "answered" && state.data.type === "hr_query_unsupported" ? (
          <Unsupported data={state.data} available={state.available} />
        ) : null}

        {state.kind === "answered" && state.data.type === "hr_query_result" ? (
          <Result data={state.data} showDetails={showDetails} onToggleDetails={() => setShowDetails((v) => !v)} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function LoadingState({ question }: { question: string }) {
  return (
    <div className="space-y-3" aria-live="polite" aria-busy="true">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Looking up “{question}”
      </div>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function Unsupported({ data, available }: { data: HrQueryUnsupported; available: boolean }) {
  return (
    <div className="space-y-3 rounded-lg border border-dashed bg-muted/40 p-4">
      <p className="text-body">{data.message}</p>
      {/* When the assistant is merely unavailable the examples are noise: they
          imply the question was out of scope, when nothing was actually asked of
          the model. Only offer a way forward when answering is possible at all. */}
      {available ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Try one of these:</p>
          <ul className="list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
            {data.examples.map((example) => (
              <li key={example}>{example}</li>
            ))}
          </ul>
        </div>
      ) : (
        <Badge variant="secondary" className="text-xs">
          Assistant unavailable
        </Badge>
      )}
    </div>
  );
}

function Result({
  data,
  showDetails,
  onToggleDetails,
}: {
  data: HrQueryResult;
  showDetails: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border-l-[3px] border-primary bg-primary/5 px-4 py-3">
        <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Result summary
        </p>
        <p className="mt-1 text-body font-medium">{data.summary}</p>
      </div>

      {data.rows.length > 0 ? (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {data.columns.map((column) => (
                  <TableHead
                    key={column.key}
                    className={column.align === "right" ? "text-right" : undefined}
                  >
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row, index) => (
                <TableRow key={index}>
                  {data.columns.map((column) => (
                    <TableCell
                      key={column.key}
                      className={
                        column.align === "right" ? "text-right tabular-nums" : undefined
                      }
                    >
                      {formatCell(row[column.key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <div>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto px-0 py-1 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
          onClick={onToggleDetails}
          aria-expanded={showDetails}
        >
          <ChevronDown
            className={`size-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`}
            aria-hidden
          />
          {showDetails ? "Hide query details" : "Show query details"}
        </Button>

        {showDetails ? (
          <dl className="mt-2 space-y-1 rounded-lg border bg-muted/40 p-3 font-mono text-xs">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">function</dt>
              <dd>{data.tool_used}</dd>
            </div>
            {Object.entries(data.params).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="text-muted-foreground">{key}</dt>
                <dd>{value === null || value === undefined ? "—" : String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

function formatCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}
