"use client";

import { Suspense, use } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AutoReviewQueueOwner } from "./AutoReviewPage";

interface AutoReviewEmptyStateProps {
  readOnly: boolean;
  isCoordinator: boolean;
  reviewers: AutoReviewQueueOwner[];
  queueUserId: string;
  ownQueueUserId: string;
  onViewAsChange: (userId: string) => void;
  /**
   * Documentos com codificação humana fora da auto-revisão por não terem
   * geração LLM corrente (#690) — o reinício do round arquiva todas. Chega
   * por streaming. `null`: a contagem falhou; `undefined`: não calculada
   * (só o coordenador a vê, e só com a fila vazia).
   */
  docsWithoutLlm?: Promise<number | null>;
}

export function AutoReviewEmptyState({
  readOnly,
  isCoordinator,
  reviewers,
  queueUserId,
  ownQueueUserId,
  onViewAsChange,
  docsWithoutLlm,
}: AutoReviewEmptyStateProps) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-6 py-10 text-center">
      <h1 className="mb-4 text-2xl font-semibold">Auto-revisão</h1>
      {readOnly ? (
        <p className="text-muted-foreground">
          Este pesquisador não tem auto-revisão pendente no momento.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Nenhuma auto-revisão pendente. Quando você submeter uma codificação que
          diverge do LLM, ela aparecerá aqui.
        </p>
      )}
      {isCoordinator ? (
        <div className="mt-6 space-y-3 border-t pt-4 text-left">
          {docsWithoutLlm ? (
            <Suspense fallback={null}>
              <DocsWithoutLlmNote count={docsWithoutLlm} />
            </Suspense>
          ) : null}
          {reviewers.length > 1 ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                Ver fila de outro pesquisador
              </p>
              <Select value={queueUserId} onValueChange={onViewAsChange}>
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {reviewers.map((r) => (
                    <SelectItem key={r.userId} value={r.userId}>
                      {r.name || r.email || r.userId.slice(0, 8)}
                      {r.userId === ownQueueUserId ? " (você)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Coordenador: o backlog pode ser reexecutado em{" "}
            <span className="font-medium">Reviews → Erros LLM</span>.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function DocsWithoutLlmNote({ count }: { count: Promise<number | null> }) {
  const docsWithoutLlm = use(count);
  if (docsWithoutLlm === 0) return null;
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <p>
        {docsWithoutLlm === null
          ? "Não foi possível verificar se há documentos fora da auto-revisão por não ter geração LLM corrente."
          : `No projeto, ${docsWithoutLlm} documento(s) com codificação humana estão fora da auto-revisão por não ter geração LLM corrente (por exemplo, depois de reiniciar o round, que arquiva as gerações LLM). Rode o LLM neles para que as divergências entrem na auto-revisão.`}
      </p>
    </div>
  );
}
