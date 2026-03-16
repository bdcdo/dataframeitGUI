"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";

const ReactMarkdown = dynamic(() => import("react-markdown"), {
  ssr: false,
  loading: () => <div className="h-32 animate-pulse rounded bg-muted" />,
});

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\n{2,}/g, "\u0000PARA\u0000")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/\n(?![-*>]|\d+\.)/g, " ")
    .replace(/\u0000PARA\u0000/g, "\n\n")
    .replace(/ {2,}/g, " ");
}

interface DocumentReaderProps {
  text: string;
}

export function DocumentReader({ text }: DocumentReaderProps) {
  const normalized = useMemo(() => normalizeExtractedText(text), [text]);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="prose prose-sm dark:prose-invert max-w-none break-words">
        <ReactMarkdown>{normalized}</ReactMarkdown>
      </div>
    </div>
  );
}
