import type { SelfVerdict } from "@/lib/types";

// Um campo da auto-revisao esta "decidido" quando ja foi respondido em sessao
// anterior, ou quando o pesquisador escolheu um verdict local. Excecao:
// contesta_llm so conta como decidido se a justificativa obrigatoria estiver
// preenchida (espelha a validacao server-side de submitAutoReview).
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
  if (choice === "contesta_llm") return !!justification?.trim();
  return true;
}
