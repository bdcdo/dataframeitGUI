import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { errorDetail } from "@/lib/server-error";

// Props que o Next passa a `error.tsx` e `global-error.tsx`.
export interface ErrorBoundaryProps {
  error: unknown;
  retry: () => void;
}

// Painel das telas de erro (`global-error.tsx` e os `error.tsx` de segmento,
// #653). O detalhe é o código do erro de servidor (ver `errorCode`), que casa
// com a linha `[erro <código>]` do log, ou a mensagem do erro do navegador.
// `children` entra ao lado do "Tentar de novo" (o caminho de volta, quando o
// boundary troca a navegação junto com a página). Sem `<main>`: dentro de um
// projeto o painel já cai no `<main>` do layout, e quem não tem um o põe.
export function ErrorPanel({
  error,
  retry,
  title = "Algo deu errado",
  description = "Ocorreu um erro inesperado nesta página. Tente de novo; se o erro persistir, envie o código abaixo para quem mantém a plataforma.",
  children,
}: ErrorBoundaryProps & {
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  const detail = errorDetail(error);
  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6">
        <h1 className="text-base font-medium">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
        {detail && (
          <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
            {detail}
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={retry}>
            Tentar de novo
          </Button>
          {children}
        </div>
      </div>
    </div>
  );
}
