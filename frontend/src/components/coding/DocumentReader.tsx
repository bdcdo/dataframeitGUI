"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { normalizeExtractedText } from "@/lib/document-text";

const ReactMarkdown = dynamic(() => import("react-markdown"), {
  ssr: false,
  loading: () => <div className="h-32 animate-pulse rounded bg-muted" />,
});

interface DocumentReaderProps {
  text: string;
}

export function DocumentReader({ text }: DocumentReaderProps) {
  const normalized = useMemo(() => normalizeExtractedText(text), [text]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="prose prose-sm dark:prose-invert max-w-3xl break-words">
        <ReactMarkdown>{normalized}</ReactMarkdown>
      </div>
    </div>
  );
}
