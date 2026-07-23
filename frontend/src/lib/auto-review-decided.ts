import type { SelfVerdict } from "@/lib/types";

// Vereditos que exigem justificativa do pesquisador: contesta_llm (o arbitro
// precisa do contraponto humano na revelacao) e ambiguo (o porque vai para o
// project_comments de discussao). Predicado compartilhado entre a UI e a
// validacao server-side de submitAutoReview para evitar drift.
export function verdictRequiresJustification(
  verdict: SelfVerdict | null | undefined,
): boolean {
  return verdict === "contesta_llm" || verdict === "ambiguo";
}

// Um campo da auto-revisao esta "decidido" quando ja foi respondido em sessao
// anterior, ou quando o pesquisador escolheu um verdict local. Excecao:
// contesta_llm e ambiguo so contam como decididos se a justificativa
// obrigatoria estiver preenchida (espelha a validacao server-side de
// submitAutoReview).
//
// Este módulo é puro e client-safe; a reconciliação server-only vive em
// lib/auto-review-reconciler.ts.
export function isAutoReviewFieldDecided(
  alreadyAnswered: boolean,
  choice: SelfVerdict | null | undefined,
  justification: string | undefined,
): boolean {
  if (alreadyAnswered) return true;
  if (choice == null) return false;
  if (verdictRequiresJustification(choice)) return !!justification?.trim();
  return true;
}

// O id identifica o ciclo, não apenas o campo. Quando uma edição rotaciona o
// ciclo, a escolha incompleta da versão anterior não pode migrar para o novo
// snapshot durante um refresh do RSC.
export function choiceKey(fieldReviewId: string): string {
  return fieldReviewId;
}
