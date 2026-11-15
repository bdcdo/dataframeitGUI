"use client";

import "./globals.css";
import { Button } from "@/components/ui/button";
import { errorDetail } from "@/lib/server-error";

// Último boundary do app (#653). Substitui o layout raiz quando ativo, por isso
// declara `<html>`, `<body>` e o CSS global. O detalhe é o código do erro de
// servidor (ver `errorCode`) ou a mensagem do erro do navegador.
export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const detail = errorDetail(error);
  return (
    <html lang="pt-BR">
      <body className="antialiased">
        <title>Erro — dataframeit</title>
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
            <Button size="sm" onClick={retry}>
              Tentar de novo
            </Button>
          </div>
        </main>
      </body>
    </html>
  );
}
