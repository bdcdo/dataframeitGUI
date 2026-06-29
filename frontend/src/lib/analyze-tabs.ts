import type { AutomationMode } from "@/lib/types";

// Decide quais abas de revisão aparecem em /analyze, a partir do modo de
// automação do projeto e dos assignments do usuário. Pura — testável sem DB.
//
// Regra: o coordenador vê as abas do mecanismo ATIVO no projeto (modo); o
// pesquisador vê uma aba enquanto tiver assignment do tipo (preserva acesso a
// trabalho já atribuído mesmo se o modo mudou depois — não orfana). Atribuições
// e Codificar são sempre visíveis (não passam por aqui).
export function computeAnalyzeTabVisibility(opts: {
  mode: AutomationMode | null | undefined;
  isCoordinator: boolean;
  hasAutoRevisaoAssignment: boolean;
  hasArbitragemAssignment: boolean;
  hasComparacaoAssignment: boolean;
}): { showAutoReview: boolean; showArbitragem: boolean; showCompare: boolean } {
  const {
    mode,
    isCoordinator,
    hasAutoRevisaoAssignment,
    hasArbitragemAssignment,
    hasComparacaoAssignment,
  } = opts;

  const coordSeesAutoReview = isCoordinator && mode === "auto_review_llm";
  const coordSeesCompare =
    isCoordinator && (mode === "compare_humans" || mode === "compare_llm");

  return {
    showAutoReview: coordSeesAutoReview || hasAutoRevisaoAssignment,
    showArbitragem: coordSeesAutoReview || hasArbitragemAssignment,
    showCompare: coordSeesCompare || hasComparacaoAssignment,
  };
}
