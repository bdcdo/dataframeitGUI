"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorPanel, type ErrorBoundaryProps } from "@/components/shell/ErrorPanel";

// Boundary das páginas autenticadas fora de um projeto (dashboard) e do próprio
// layout do projeto (#653). Sem ele, o erro subia até o `global-error`, que
// troca o layout raiz inteiro; aqui o layout raiz (Clerk, toasts) continua
// montado. A navegação do projeto mora em `projects/[id]/layout.tsx`, que este
// boundary substitui, então o painel oferece o caminho de volta aos projetos.
export default function AppError({ error, retry }: ErrorBoundaryProps) {
  return (
    <main>
      <ErrorPanel error={error} retry={retry}>
        <Button size="sm" variant="outline" asChild>
          <Link href="/dashboard">Voltar aos projetos</Link>
        </Button>
      </ErrorPanel>
    </main>
  );
}
