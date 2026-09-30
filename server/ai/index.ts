import "server-only";

/**
 * One copilot turn: model, tools, model.
 *
 * The loop is deliberately small and bounded. The model may call tools for a few
 * rounds, each call is dispatched through the whitelist and audited, and the turn
 * ends when the model answers in prose or the round budget runs out. The budget
 * is the reason a confused or injected model cannot spin: it gets six tool rounds
 * and then the turn is closed and the user is told to rephrase.
 *
 * Nothing here can widen access. `toolsFor()` binds the tools to one session
 * client, and every handler is pinned to `context.employee.id` or to an RPC that
 * applies its own RLS. The model's output is treated as a request to read, never
 * as authority.
 */
import {
  complete,
  toAssistantMessage,
  MAX_TOOL_ROUNDS,
  type ChatMessage,
  type ToolCall,
} from "@/server/ai/llm";
import { LlmError } from "@/server/ai/llm";
import { systemPrompt } from "@/server/ai/prompt";
import { auditToolCall, withAudit } from "@/server/ai/audit";
import {
  findTool,
  toolNames,
  toolsFor,
  ToolError,
  type ToolContext,
} from "@/server/ai/tools.employee";

export type { ToolContext };
import {
  buildLeavePreview,
  parseLeaveRequestSchema,
  type LeavePreviewCard,
} from "@/server/ai/leave-draft";

export type CopilotReply = {
  message: string;
  /** Present when the turn produced a leave preview for the UI to render. */
  card?: LeavePreviewCard;
  /** The tools that actually ran, so the UI can show what it did. */
  tools_used: string[];
};

export type CopilotEvent =
  | { type: "reply"; data: CopilotReply }
  | { type: "error"; code: string; message: string };

/**
 * The parse tool, offered to the model alongside the read-only ones. Its
 * `execute` is never called: `dispatchTool` intercepts this name, because it
 * produces a card as well as content.
 */
const PARSE_TOOL = {
  name: "parse_leave_request",
  description:
    "Draft a leave request from what the employee said. " +
    'Example — employee says "I want casual leave from 12th to 15th October", so call this with ' +
    '{ "leave_type": "casual", "text": "I want casual leave from 12th to 15th October" }. ' +
    "Copy their sentence into `text` verbatim and set `leave_type`; the dates are resolved from the " +
    "sentence on the server, so you do not need to compute a year. " +
    "If the leave type or the dates are genuinely unstated, return " +
    '{ "clarification_question": "..." } instead of guessing. ' +
    "This only drafts a preview; it never submits anything.",
  parameters: parseLeaveRequestSchema.toJSONSchema({
    io: "input",
    unrepresentable: "any",
  }) as unknown as Record<string, unknown>,
  execute: (() => Promise.resolve(null)) as never,
};

/**
 * Runs `parse_leave_request` and folds its result into a preview card.
 *
 * The model's draft is re-parsed with zod and then handed to the dry-run
 * validation RPC, so a wrong draft can only produce a wrong-looking card.
 */
async function runParseTool(
  context: ToolContext,
  rawArgs: unknown,
): Promise<{ card?: LeavePreviewCard; note: string }> {
  const parsed = parseLeaveRequestSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      note: `Invalid arguments for parse_leave_request: ${parsed.error.issues[0]?.message ?? "malformed draft"}.`,
    };
  }

  const result = await buildLeavePreview(context, parsed.data);
  if (result.kind === "clarification") {
    return { note: result.question };
  }
  return { card: result.card, note: result.reply };
}

export async function runCopilotTurn(
  context: ToolContext,
  history: { role: "user" | "assistant"; content: string }[],
  userMessage: string,
): Promise<CopilotEvent> {
  const toolsUsed = new Set<string>();
  let card: LeavePreviewCard | undefined;

  const allTools = [...toolsFor(context), PARSE_TOOL];

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(context.employee) },
    // Prior turns, so the model can follow a reference like "and the second one?".
    ...history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content }) as ChatMessage),
    { role: "user", content: userMessage },
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const choice = await complete(messages, allTools);
      const assistant = toAssistantMessage(choice);
      messages.push(assistant);

      const calls = choice.message?.tool_calls ?? [];
      if (calls.length === 0) {
        return {
          type: "reply",
          data: {
            message: assistant.content?.trim() || "I don't have anything to add.",
            ...(card ? { card } : {}),
            tools_used: [...toolsUsed],
          },
        };
      }

      for (const call of calls) {
        const result = await dispatchTool(context, call, (name) => toolsUsed.add(name));
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result.content),
        });

        if (result.card) card = result.card;
      }
    }

    return {
      type: "reply",
      data: {
        message:
          "That took more steps than I can take in one go. Try asking about one thing at a time.",
        ...(card ? { card } : {}),
        tools_used: [...toolsUsed],
      },
    };
  } catch (error) {
    if (error instanceof LlmError) {
      return { type: "error", code: error.code, message: error.userMessage };
    }
    console.error("[ai] turn failed", error);
    return {
      type: "error",
      code: "AI_UNAVAILABLE",
      message: "The assistant is unavailable right now. The rest of the app is unaffected.",
    };
  }
}

/**
 * Dispatches a single tool call, and audits it whatever happens.
 *
 * A failure is returned to the model as tool *content* rather than thrown, so it
 * can recover — but the model can never turn a failure into a success, because
 * the content it receives is the error text, not data.
 */
async function dispatchTool(
  context: ToolContext,
  call: ToolCall,
  onUsed: (name: string) => void,
): Promise<{ content: unknown; card?: LeavePreviewCard }> {
  const name = call.function.name;

  let rawArgs: unknown = {};
  try {
    rawArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return {
      content: { error: `The arguments for ${name} were not valid JSON. Try again.` },
    };
  }

  const argsForAudit =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  try {
    if (name === "parse_leave_request") {
      const { card: preview, note } = await withAudit(
        { employeeId: context.employee.id, toolName: name, arguments: argsForAudit },
        () => runParseTool(context, rawArgs),
      );
      onUsed(name);
      // The note doubles as the answer: it describes the card without claiming
      // anything was submitted.
      return { content: { result: note }, card: preview };
    }

    if (!toolNames().includes(name)) {
      throw new ToolError(
        `Unknown tool "${name}". Available tools: ${toolNames().join(", ")}, parse_leave_request.`,
      );
    }

    const { tool, args } = findTool(context, name, rawArgs);
    const result = await withAudit(
      { employeeId: context.employee.id, toolName: name, arguments: args as Record<string, unknown> },
      () => tool.handler(context, args as never),
    );
    onUsed(name);
    return { content: result };
  } catch (error) {
    await auditToolCall({
      employeeId: context.employee.id,
      toolName: name,
      arguments: argsForAudit,
      success: false,
      error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
    });
    onUsed(name);
    return { content: { error: error instanceof Error ? error.message : "The tool failed." } };
  }
}

/** Exposed for the route's suggested prompts, which must match the real tools. */
export const SUGGESTED_PROMPTS = [
  "How many leaves do I have left?",
  "Who is my manager?",
  "Show my leave history",
  "Why was my leave rejected?",
  "I want casual leave from 12th to 15th October",
];
