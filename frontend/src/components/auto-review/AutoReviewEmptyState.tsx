"use client";

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
  viewAsUserId: string;
  currentUserId: string;
  onViewAsChange: (userId: string) => void;
}

export function AutoReviewEmptyState({
  readOnly,
  isCoordinator,
  reviewers,
  viewAsUserId,
  currentUserId,
  onViewAsChange,
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
          {reviewers.length > 1 ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                Ver fila de outro pesquisador
              </p>
              <Select value={viewAsUserId} onValueChange={onViewAsChange}>
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {reviewers.map((r) => (
                    <SelectItem key={r.userId} value={r.userId}>
                      {r.name || r.email || r.userId.slice(0, 8)}
                      {r.userId === currentUserId ? " (você)" : ""}
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
