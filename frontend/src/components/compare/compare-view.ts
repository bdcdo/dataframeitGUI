// Helpers de apresentação puros da Comparação, extraídos de `ComparePage` para
// tirar do corpo do container as duas maiores concentrações de complexidade
// (`no-giant-component`): o `.map` que monta a sidebar de documentos e o
// ternário de 4 níveis da mensagem de estado vazio. São puros (sem React), por
// isso testáveis por tabela; ficam co-locados em `components/compare/` porque
// dependem de `DocListEntry` (camada de componente) — pôr em `lib/` forçaria um
// import descendente lib→components que o grafo do projeto proíbe.

import type { ComponentProps } from "react";
import type { DocCoverage } from "@/lib/compare-queue";
import type { ReviewsByDoc, VerdictInfo } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { DocListEntry } from "./CompareDocList";
import type { ComparisonPanel } from "./ComparisonPanel";
import type { CompareDocument } from "./compare-types";
import type { CompareFieldData } from "./useCompareFieldData";
import type { CompareVerdicts } from "./useCompareVerdicts";
import type { CompareVerdictSubmission } from "./useCompareVerdictSubmission";

// Cobertura zerada para docs ainda sem linha em `coverageByDoc`. Defaultar o
// objeto inteiro uma vez — em vez de `?? 0` campo a campo — mantém o `.map`
// abaixo com um único branch de fallback, não um por coluna.
const EMPTY_COVERAGE = {
  humanCount: 0,
  totalCount: 0,
  assignedCodingCount: 0,
  humansFromAssigned: 0,
  divergentCount: 0,
  reviewedCount: 0,
  assignmentStatus: null,
} satisfies Omit<DocCoverage, "docId">;

/**
 * Monta as entradas da sidebar a partir da fila estável e da cobertura por
 * documento. `reviewedCount`: quando há reviews locais (escrita otimista da
 * sessão) para o doc, vem da contagem de campos divergentes já com veredito
 * local — refletindo os vereditos desta sessão antes do reload; senão cai no
 * `reviewedCount` do servidor.
 */
export function buildDocListEntries(
  documents: CompareDocument[],
  coverageByDoc: Record<string, DocCoverage>,
  divergentFields: Record<string, string[]>,
  localReviews: ReviewsByDoc,
): DocListEntry[] {
  return documents.map((d) => {
    const c = coverageByDoc[d.id] ?? EMPTY_COVERAGE;
    const reviewedCount = localReviews[d.id]
      ? (divergentFields[d.id] ?? []).filter((fn) => !!localReviews[d.id][fn])
          .length
      : c.reviewedCount;
    return {
      id: d.id,
      title: d.title,
      external_id: d.external_id,
      humanCount: c.humanCount,
      totalCount: c.totalCount,
      assignedCodingCount: c.assignedCodingCount,
      humansFromAssigned: c.humansFromAssigned,
      divergentCount: c.divergentCount,
      reviewedCount,
      assignmentStatus: c.assignmentStatus,
    };
  });
}

interface CompareMetaInput {
  currentDoc: CompareDocument;
  projectId: string;
  currentFieldName: string;
  commentCountsByKey: Record<string, number>;
  suggestionCountsByField: Record<string, number>;
}

export interface CompareMeta {
  docTitle: string;
  parecerUrl: string;
  fieldCommentCount: number;
  fieldSuggestionCount: number;
}

/**
 * Valores derivados do documento/campo atual para a barra de navegação e o
 * painel de comparação. Extraído de `ComparePage` para tirar do corpo do
 * componente os fallbacks (`||`/`??`) e o ternário de origem da URL. O
 * `parecerUrl` resolve a origem só no cliente — no SSR `window` é ausente e a
 * URL nasce relativa; o comportamento é idêntico ao anterior, apenas relocado.
 * `fieldCommentCount` soma os comentários do campo com os do documento inteiro
 * (chave com sufixo vazio).
 */
export function buildCompareMeta({
  currentDoc,
  projectId,
  currentFieldName,
  commentCountsByKey,
  suggestionCountsByField,
}: CompareMetaInput): CompareMeta {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  return {
    docTitle: currentDoc.title || currentDoc.external_id || "Documento",
    parecerUrl: `${baseUrl}/projects/${projectId}/analyze/code?doc=${currentDoc.id}`,
    fieldCommentCount:
      (commentCountsByKey[`${currentDoc.id}|${currentFieldName}`] ?? 0) +
      (commentCountsByKey[`${currentDoc.id}|`] ?? 0),
    fieldSuggestionCount: suggestionCountsByField[currentFieldName] ?? 0,
  };
}

interface EmptyMessageContext {
  documentsLength: number;
  isCoordinator: boolean;
  showingAllQueue: boolean;
  hasAssignedDocs: boolean;
  isImpersonating: boolean;
}

/**
 * Copy do estado vazio da fila. `documents.length===0` na aba "Meus" tem duas
 * causas distintas: (a) o coordenador não tem NENHUM documento atribuído —
 * trocar pra "Todos" resolve; (b) ele TEM documentos atribuídos, mas nenhum
 * passou nos filtros de cobertura/divergência — trocar de aba não muda nada, o
 * filtro de cobertura é ortogonal ao de assignment. `hasAssignedDocs`
 * diferencia os dois. Na impersonação a fila exibida é a do membro, então o
 * sujeito da copy muda pra 3ª pessoa — "você" seria lido como sendo sobre o
 * membro quando descreve a fila (vazia) do próprio master.
 */
export function resolveEmptyMessage({
  documentsLength,
  isCoordinator,
  showingAllQueue,
  hasAssignedDocs,
  isImpersonating,
}: EmptyMessageContext): string {
  if (documentsLength > 0) {
    return "Nenhuma divergência neste documento.";
  }
  if (!(isCoordinator && !showingAllQueue)) {
    return "Nenhum documento na fila com os filtros atuais.";
  }
  if (hasAssignedDocs) {
    return isImpersonating
      ? 'Os documentos atribuídos a este membro não atendem aos filtros atuais (respostas mínimas, versão, etc.). Ajuste os filtros ou use a aba "Todos" para ver a fila completa.'
      : 'Seus documentos atribuídos não atendem aos filtros atuais (respostas mínimas, versão, etc.). Ajuste os filtros ou use a aba "Todos" para ver a fila completa.';
  }
  return isImpersonating
    ? 'Este membro não tem documentos atribuídos para comparação. Use a aba "Todos" acima para ver a fila completa do projeto.'
    : 'Você não tem documentos atribuídos para comparação. Use a aba "Todos" acima para ver a fila completa do projeto.';
}

type ComparisonPanelProps = ComponentProps<typeof ComparisonPanel>;

/** União discriminada do estado de conclusão do documento (prop do painel). */
export type CompareDocStatus = ComparisonPanelProps["docStatus"];

interface ComparisonPanelInput {
  // Resultados dos hooks de orquestração, passados AGRUPADOS de propósito: o
  // objeto de retorno referencia `submission.x`/`verdicts.y`/`fieldData.z`, e
  // não campos soltos homônimos — assim ele não vira um bloco gêmeo de nenhum
  // destructure, o que dispararia o detector de duplicação do fallow (o achado
  // de 59 linhas que a extração num único controller-hook produziu).
  submission: CompareVerdictSubmission;
  verdicts: CompareVerdicts;
  fieldData: CompareFieldData;
  meta: CompareMeta;
  currentDoc: CompareDocument;
  currentField: PydanticField | undefined;
  readOnly: boolean;
  projectId: string;
  currentFieldName: string;
  fields: PydanticField[];
  fieldIndex: number;
  totalFields: number;
  currentVerdict: VerdictInfo | null;
  reviewed: boolean[];
  isDivergent: boolean;
  // Estado de conclusão do documento (união discriminada), já montado no
  // container — evita transportar `isComplete`/`hasNextDoc`/`onNextDoc` soltos.
  docStatus: ComparisonPanelProps["docStatus"];
  comment: string;
  canManageAnyPair: boolean;
  currentUserId: string;
  onFieldNavigate: (index: number) => void;
  onConfirmPendingVerdict: () => void;
  onCommentChange: (value: string) => void;
}

/**
 * Monta o objeto de props do `ComparisonPanel` a partir dos resultados dos
 * hooks de orquestração. É a "cola" de ~30 campos que ligava o painel ao
 * container; extraída de `ComparePage` para tirar do componente essa massa e o
 * ternário de `docStatus`/os fallbacks de `fieldDescription`. Puro (sem JSX):
 * as funções embrulhadas (`onVerdict`, `onMarkReviewed`, `docStatus.onNextDoc`)
 * são as mesmas que o container criava inline no render.
 */
export function buildComparisonPanel({
  submission,
  verdicts,
  fieldData,
  meta,
  currentDoc,
  currentField,
  readOnly,
  projectId,
  currentFieldName,
  fields,
  fieldIndex,
  totalFields,
  currentVerdict,
  reviewed,
  isDivergent,
  docStatus,
  comment,
  canManageAnyPair,
  currentUserId,
  onFieldNavigate,
  onConfirmPendingVerdict,
  onCommentChange,
}: ComparisonPanelInput): ComparisonPanelProps {
  return {
    readOnly,
    projectId,
    documentId: currentDoc.id,
    documentTitle: meta.docTitle,
    fieldName: currentFieldName,
    fieldDescription: currentField?.description || currentFieldName,
    fieldHelpText: currentField?.help_text,
    fieldType: currentField?.type,
    fieldOptions: currentField?.options,
    fields,
    fieldIndex,
    totalFields,
    responses: fieldData.fieldResponses,
    existingVerdict: currentVerdict,
    reviewed,
    isDivergent,
    docStatus,
    onFieldNavigate,
    onVerdict: (verdict, chosenResponseId) =>
      void submission.submitVerdictSingleFlight(verdict, chosenResponseId),
    pendingVerdict: submission.pendingVerdict,
    onPrepareVerdict: submission.preparePendingVerdict,
    onConfirmPendingVerdict,
    onDiscardPendingVerdict: submission.discardPendingVerdict,
    isSavingVerdict: submission.isSavingVerdict,
    onMarkReviewed: () => void verdicts.handleMarkReviewed(),
    comment,
    onCommentChange,
    commentCount: meta.fieldCommentCount,
    suggestionCount: meta.fieldSuggestionCount,
    equivalence: { allow: fieldData.allowEquivalence, canManageAnyPair },
    equivalences: fieldData.currentFieldEquivalences,
    onConfirmEquivalent: verdicts.handleConfirmEquivalent,
    onUnmarkEquivalencePair: verdicts.handleUnmarkPair,
    currentUserId,
  };
}
