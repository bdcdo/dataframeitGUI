"use client";

import { ErrorPanel, type ErrorBoundaryProps } from "@/components/shell/ErrorPanel";

// Boundary das páginas de um projeto (#653): fica dentro de
// `projects/[id]/layout.tsx`, então o cabeçalho e as abas do projeto continuam
// na tela e a pessoa segue navegando. Erro do próprio layout sobe para
// `(app)/error.tsx`; a aba LLM tem boundary próprio (`llm/error.tsx`).
export default function ProjectError({ error, retry }: ErrorBoundaryProps) {
  return <ErrorPanel error={error} retry={retry} />;
}
