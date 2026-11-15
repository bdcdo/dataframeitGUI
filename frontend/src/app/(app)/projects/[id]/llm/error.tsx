"use client";

import { useEffect } from "react";
import { ErrorPanel } from "@/components/shell/ErrorPanel";

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
    <ErrorPanel
      error={error}
      retry={reset}
      title="Não foi possível carregar esta aba"
      description="Ocorreu um erro ao buscar os dados de LLM. Pode ser uma falha temporária de rede ou de permissão de acesso ao projeto."
    />
  );
}
