"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { errorDetail } from "@/lib/server-error";

// Boundary das páginas autenticadas (#653). Sem ele, um erro de página subia
// até o `global-error`, que troca o layout raiz inteiro; aqui o layout raiz
// (Clerk, toasts) continua montado e a tela oferece o caminho de volta aos
// projetos. O detalhe é o mesmo do `global-error`: o código do erro de
// servidor (ver `errorCode`) ou a mensagem do erro do navegador.
export default function AppError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const detail = errorDetail(error);
  return (
    <main className="mx-auto max-w-xl p-6">
      <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6">
        <h1 className="text-base font-medium">Algo deu errado</h1>
        <p className="text-sm text-muted-foreground">
          Ocorreu um erro inesperado nesta página. Tente de novo; se o erro
          persistir, envie o código abaixo para quem mantém a plataforma.
        </p>
        {detail && (
          <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
            {detail}
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={retry}>
            Tentar de novo
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href="/dashboard">Voltar aos projetos</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
