import { AlertTriangle } from "lucide-react";
import {
  REVIEW_BASE_DATA_LIMIT,
  type ReviewDataTruncation,
} from "@/lib/reviews/queries";

const TABLE_LABELS: Record<keyof ReviewDataTruncation, string> = {
  responses: "respostas",
  reviews: "revisões",
  documents: "documentos",
};

/**
 * Banner exibido quando alguma das queries de fetchReviewBaseData atingiu o
 * teto de REVIEW_BASE_DATA_LIMIT linhas. Sem ele, as estatisticas agregadas
 * das paginas de reviews ficariam silenciosamente erradas. Ver issue #105.
 */
export function TruncationBanner({
  truncated,
}: {
  truncated: ReviewDataTruncation;
}) {
  const affected = (
    Object.keys(truncated) as (keyof ReviewDataTruncation)[]
  ).filter((k) => truncated[k]);

  if (affected.length === 0) return null;

  const labels = affected.map((k) => TABLE_LABELS[k]).join(", ");

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">Estatísticas possivelmente incompletas</p>
        <p className="text-amber-700 dark:text-amber-400">
          As tabelas de {labels} atingiram o limite de{" "}
          {REVIEW_BASE_DATA_LIMIT.toLocaleString("pt-BR")} linhas carregadas.
          Os números abaixo podem estar truncados e não refletir o projeto
          inteiro.
        </p>
      </div>
    </div>
  );
}
