"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function LlmError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Erro na aba LLM:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 space-y-3">
        <h2 className="text-base font-medium">
          Não foi possível carregar esta aba
        </h2>
        <p className="text-sm text-muted-foreground">
          Ocorreu um erro ao buscar os dados de LLM. Pode ser uma falha
          temporária de rede ou de permissão de acesso ao projeto.
        </p>
        {error.message && (
          <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
            {error.message}
          </p>
        )}
        <Button size="sm" onClick={reset}>
          Tentar de novo
        </Button>
      </div>
    </div>
  );
}
