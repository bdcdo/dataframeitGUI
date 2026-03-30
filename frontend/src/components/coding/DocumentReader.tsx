"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";

const ReactMarkdown = dynamic(() => import("react-markdown"), {
  ssr: false,
  loading: () => <div className="h-32 animate-pulse rounded bg-muted" />,
});

function normalizeExtractedText(text: string): string {
  // Preserve markdown table blocks (consecutive lines with |)
  const TABLE_PLACEHOLDER = "\u0000TABLE\u0000";
  const tableBlocks: string[] = [];
  const withTablesPreserved = text.replace(
    /(?:^|\n)((?:\|.*\|[ \t]*\n?)+)/gm,
    (match) => {
      tableBlocks.push(match);
      return TABLE_PLACEHOLDER;
    }
  );

  const normalized = withTablesPreserved
    .replace(/\n{2,}/g, "\u0000PARA\u0000")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/\n(?![-*>]|\d+\.)/g, " ")
    .replace(/\u0000PARA\u0000/g, "\n\n")
    .replace(/ {2,}/g, " ");

  // Restore table blocks
  let result = normalized;
  for (const block of tableBlocks) {
    result = result.replace(TABLE_PLACEHOLDER, () => block);
  }
  return result;
}

interface DocumentReaderProps {
  text: string;
}

export function DocumentReader({ text }: DocumentReaderProps) {
  const normalized = useMemo(() => normalizeExtractedText(text), [text]);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="prose prose-sm dark:prose-invert max-w-3xl break-words">
        <ReactMarkdown>{normalized}</ReactMarkdown>
      </div>
    </div>
  );
}
