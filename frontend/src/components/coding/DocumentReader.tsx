"use client";

import dynamic from "next/dynamic";

const ReactMarkdown = dynamic(() => import("react-markdown"), {
  ssr: false,
  loading: () => <div className="h-32 animate-pulse rounded bg-muted" />,
});

interface DocumentReaderProps {
  text: string;
}

export function DocumentReader({ text }: DocumentReaderProps) {
  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    </div>
  );
}
