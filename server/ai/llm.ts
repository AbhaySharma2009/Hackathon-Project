import "server-only";

/**
 * Provider-agnostic tool-calling wrapper.
 *
 * Rule 5: the model is given tools, never a database. It never receives a
 * Supabase URL, an API key, or a query it could run itself — the only way it can
 * learn anything is by calling one of the whitelisted functions in `tools.ts`,
 * each of which runs against the signed-in employee's own session so RLS
 * applies underneath. This module is the transport for that: it holds the
 * credentials and hands the model nothing but text.
 *
 * Failure is a first-class outcome. The copilot is an assistant sitting on top of
 * an app that works without it, so a missing key, a timeout or a provider error
 * must produce a readable sentence and a structured code the UI can show, never
 * a 500 and never a leaked upstream message.
 */

/** OpenAI-compatible. Any provider exposing `/chat/completions` works as-is. */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** A tool call must not hold a request open longer than this. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A rate-limited provider usually clears within a couple of seconds. */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const RATE_LIMIT_BACKOFF_MS = 2_000;

/** Bounds a single turn so a confused model cannot loop through the tool budget. */
export const MAX_TOOL_ROUNDS = 6;

export type LlmFailureCode =
  | "AI_NOT_CONFIGURED"
  | "AI_UNAVAILABLE"
  | "AI_TIMEOUT"
  | "AI_BAD_RESPONSE";

export class LlmError extends Error {
  constructor(
    readonly code: LlmFailureCode,
    /** Safe to show a user. Never contains an upstream body or a credential. */
    readonly userMessage: string,
    /** How long to wait before retrying. A 429 needs longer than a 5xx. */
    readonly retryAfterMs: number = RETRY_BACKOFF_MS,
  ) {
    super(userMessage);
    this.name = "LlmError";
  }
}

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Validated with zod before anything runs. */
  parameters: Record<string, unknown>;
  execute: (args: never) => Promise<unknown>;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on assistant turns that requested tools. */
  tool_calls?: ToolCall[];
  /** Present on tool turns, naming the call being answered. */
  tool_call_id?: string;
  name?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export function isLlmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_API_KEY.trim().length > 0);
}

function llmConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmError(
      "AI_NOT_CONFIGURED",
      "The assistant is not configured on this server, so I can't answer that right now.",
    );
  }
  return {
    apiKey,
    model: process.env.LLM_MODEL?.trim() || "gpt-4o-mini",
    baseUrl: (process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
}

/** The OpenAI-shaped request body, so the provider stays swappable. */
function toRequestBody(messages: ChatMessage[], tools: ToolDefinition[]) {
  return {
    model: llmConfig().model,
    messages,
    tools: tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    tool_choice: "auto" as const,
    // A low temperature keeps the assistant literal: it is reading a database,
    // not writing a story, and every number in the reply is copied from a tool.
    temperature: 0,
  };
}

type ProviderChoice = {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string;
};

async function callProvider(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<ProviderChoice> {
  const { apiKey, baseUrl } = llmConfig();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(toRequestBody(messages, tools)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The upstream body can contain request echoes and provider internals, so
    // the status is logged for the operator and nothing else is surfaced.
    // A rate limit is the one upstream failure that genuinely clears, but only
    // after a pause — so it gets its own, much longer backoff.
    const rateLimited = response.status === 429;
    console.error(
      `[ai] provider responded ${response.status} for model ${process.env.LLM_MODEL ?? "gpt-4o-mini"}`,
    );
    throw new LlmError(
      "AI_UNAVAILABLE",
      rateLimited
        ? "The assistant is busy right now. Please try again in a moment."
        : "The assistant is having trouble reaching its model right now. Please try again.",
      rateLimited ? RATE_LIMIT_BACKOFF_MS : RETRY_BACKOFF_MS,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { choices?: ProviderChoice[] }
    | null;

  const choice = payload?.choices?.[0];
  if (!choice?.message) {
    throw new LlmError(
      "AI_BAD_RESPONSE",
      "The assistant got an unexpected reply and could not finish the answer.",
    );
  }
  return choice;
}

/**
 * One provider call, with bounded retries.
 *
 * Only transient failures are retried — a timeout, a 5xx, or a rate limit. A 400
 * means the request itself was rejected, and repeating it unchanged would just
 * fail again while holding the user's request open.
 */
export async function complete(messages: ChatMessage[], tools: ToolDefinition[]) {
  let lastError: LlmError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callProvider(messages, tools);
    } catch (error) {
      const failure =
        error instanceof LlmError
          ? error
          : // `AbortSignal.timeout` rejects with a TimeoutError, which is not an
            // LlmError, so the network layer is translated here.
            isTimeoutError(error)
            ? new LlmError("AI_TIMEOUT", "The assistant took too long to answer. Please try again.")
            : new LlmError(
                "AI_UNAVAILABLE",
                "The assistant is having trouble reaching its model right now. Please try again.",
              );

      // A malformed reply is the provider's fault and a retry will hit the same
      // wall, so only transport-level failures earn another attempt.
      if (failure.code === "AI_BAD_RESPONSE" || failure.code === "AI_NOT_CONFIGURED") {
        throw failure;
      }

      lastError = failure;
      if (attempt < MAX_ATTEMPTS) {
        // Back off further on each attempt; a rate limit starts well out.
        await new Promise((resolve) => setTimeout(resolve, failure.retryAfterMs * attempt));
      }
    }
  }

  throw (
    lastError ??
    new LlmError("AI_UNAVAILABLE", "The assistant is unavailable right now. Please try again.")
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "TimeoutError"
    : error instanceof Error && error.name === "TimeoutError";
}

/** Normalises an assistant turn into the shape the next request expects. */
export function toAssistantMessage(choice: ProviderChoice): ChatMessage {
  return {
    role: "assistant",
    content: choice.message?.content ?? null,
    ...(choice.message?.tool_calls?.length ? { tool_calls: choice.message.tool_calls } : {}),
  };
}
