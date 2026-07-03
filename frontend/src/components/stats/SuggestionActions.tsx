"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveSchemaSuggestion } from "@/actions/suggestions";
import { toast } from "sonner";

interface SuggestionActionsProps {
  suggestionId: string;
  suggestionStatus?: "pending" | "approved" | "rejected";
  projectId: string;
  isPending: boolean;
  isCoordinator?: boolean;
  onResolve: () => void;
}

/* Suggestion actions (coordinator: review/reject)
   "Revisar" abre EditFieldDialog pré-preenchido (via onResolve);
   salvar lá aprova com os valores finais editados. */
export function SuggestionActions({
  suggestionId,
  suggestionStatus,
  projectId,
  isPending,
  isCoordinator,
  onResolve,
}: SuggestionActionsProps) {
  const { refresh } = useRouter();
  const [suggestionPending, startSuggestionAction] = useTransition();

  return (
    <div className="flex items-center gap-2">
      {suggestionStatus === "pending" && isCoordinator && (
        <>
          <Button
            variant="default"
            size="sm"
            className="h-6 text-xs"
            disabled={suggestionPending || isPending}
            onClick={onResolve}
            title="Abre editor para revisar antes de aprovar"
          >
            Revisar
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            disabled={suggestionPending}
            onClick={() => {
              startSuggestionAction(async () => {
                const result = await resolveSchemaSuggestion(suggestionId, projectId, "rejected");
                if (result.error) toast.error(result.error);
                else { toast.success("Sugestão rejeitada"); refresh(); }
              });
            }}
          >
            Rejeitar
          </Button>
        </>
      )}
      {suggestionStatus === "approved" && (
        <Badge className="text-xs bg-green-500/10 text-green-700">Aprovada</Badge>
      )}
      {suggestionStatus === "rejected" && (
        <Badge className="text-xs bg-red-500/10 text-red-700">Rejeitada</Badge>
      )}
    </div>
  );
}
