"use client";

/**
 * Minimal, safe rendering of the assistant's replies.
 *
 * No markdown library is installed and none is needed: the copilot is told to
 * answer in a few plain sentences, and the only formatting worth supporting is
 * inline emphasis, inline code and line breaks. Everything is produced as React
 * elements, so a reply can never inject markup — there is no
 * `dangerouslySetInnerHTML` anywhere in this path, and a model that emits raw
 * HTML has it displayed as literal text, which is exactly the right outcome.
 */
import { Fragment, type ReactNode } from "react";

/** `**bold**`, `*italic*`, `` `code` `` — applied in one pass, left to right. */
const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];

  text.split(INLINE).forEach((part, index) => {
    const key = `${keyPrefix}-${index}`;

    if (!part) return;

    if (part.startsWith("**") && part.endsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>,
      );
      return;
    }

    if (part.startsWith("*") && part.endsWith("*")) {
      out.push(<em key={key}>{part.slice(1, -1)}</em>);
      return;
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }

    out.push(<Fragment key={key}>{part}</Fragment>);
  });

  return out;
}

export function SafeMarkdown({ text }: { text: string }) {
  // A blank line separates paragraphs; a single newline is just a line break.
  const paragraphs = text.split(/\n{2,}/);

  return (
    <div className="space-y-2 text-sm">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-wrap break-words">
          {renderInline(paragraph, `p-${index}`)}
        </p>
      ))}
    </div>
  );
}
