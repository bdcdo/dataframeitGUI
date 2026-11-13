import { use } from "react";
import { usesAutoReviewSource } from "@/lib/llm-error-metrics";
import { AutoReviewVerdictsExportCard } from "./AutoReviewVerdictsExportCard";

// O card dos vereditos da auto-revisão só existe em projetos
// 'auto_review_llm'. A página dispara a leitura do modo junto das suas
// (`automationMode` é a promessa já em voo) e embrulha isto em Suspense: o
// resto da página não espera por ela.
export function AutoReviewVerdictsExport({
  projectId,
  automationMode,
}: {
  projectId: string;
  automationMode: Promise<string | null>;
}) {
  if (!usesAutoReviewSource(use(automationMode))) return null;
  return <AutoReviewVerdictsExportCard projectId={projectId} />;
}
