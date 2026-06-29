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
// Modulo separado de lib/auto-review.ts de proposito: aquele importa o
// supabase admin client (server-only) e nao pode ser puxado para um client
// component. Esta funcao e pura e client-safe.
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

// Chave de escolha/justificativa por (documento, campo). O fieldName se repete
// entre documentos; sem o prefixo do docId, escolher "q1" no doc A
// pre-selecionaria "q1" do doc B na navegacao. O composto garante isolamento.
// Funcao de modulo (nao recriada a cada render) compartilhada entre
// AutoReviewPage e AutoReviewPageContent.
export function choiceKey(docId: string, fieldName: string): string {
  return `${docId}::${fieldName}`;
}
