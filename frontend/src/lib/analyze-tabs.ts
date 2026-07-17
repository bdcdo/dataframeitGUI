import type { AutomationMode } from "@/lib/types";

// Decide quais abas de revisão aparecem em /analyze, a partir do modo de
// automação do projeto e do trabalho ativo do usuário. Pura — testável sem DB.
//
// Regra: o coordenador vê as abas do mecanismo ATIVO no projeto (modo); o
// pesquisador vê Auto-revisão enquanto tiver um ciclo pendente em field_reviews;
// as demais filas continuam materializadas em assignments. Atribuições e
// Codificar são sempre visíveis (não passam por aqui).
export function computeAnalyzeTabVisibility(opts: {
  mode: AutomationMode | null | undefined;
  isCoordinator: boolean;
  hasPendingAutoReview: boolean;
  hasArbitragemAssignment: boolean;
  hasComparacaoAssignment: boolean;
}): { showAutoReview: boolean; showArbitragem: boolean; showCompare: boolean } {
  const {
    mode,
    isCoordinator,
    hasPendingAutoReview,
    hasArbitragemAssignment,
    hasComparacaoAssignment,
  } = opts;

  const coordSeesAutoReview = isCoordinator && mode === "auto_review_llm";
  const coordSeesCompare =
    isCoordinator && (mode === "compare_humans" || mode === "compare_llm");

  return {
    showAutoReview: coordSeesAutoReview || hasPendingAutoReview,
    showArbitragem: coordSeesAutoReview || hasArbitragemAssignment,
    showCompare: coordSeesCompare || hasComparacaoAssignment,
  };
}
