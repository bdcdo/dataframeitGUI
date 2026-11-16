"use client";

import { useCallback } from "react";
import { FullscreenNav } from "../coding/FullscreenNav";
import { CompareNav } from "./CompareNav";
import type { CompareQueueScope } from "./CompareQueueTabs";
import { CompareDocList } from "./CompareDocList";
import { CompareFrame } from "./CompareFrame";
import { CompareWorkspace } from "./CompareWorkspace";
import { useCompareReviews } from "./useCompareReviews";
import { useCompareNavigation } from "./useCompareNavigation";
import { useStableDocOrder } from "./useStableDocOrder";
import { useCompareFieldData } from "./useCompareFieldData";
import { useCompareVerdicts } from "./useCompareVerdicts";
import { useCompareKeyboard } from "./useCompareKeyboard";
import { useCompareDecisionContext } from "./useCompareDecisionContext";
import { useCompareCommentDraft } from "./useCompareCommentDraft";
import { useCompareVerdictFlow } from "./useCompareVerdictFlow";
import { useCompareLayoutToggles } from "./useCompareLayoutToggles";
import { useCompareNavGuard } from "./useCompareNavGuard";
import {
  buildDocListEntries,
  docTitleOf,
  fieldCommentCountOf,
  fieldPanelPropsOf,
  parecerUrlOf,
  resolveEmptyMessage,
} from "./compare-page-view";
import { useUrlState } from "@/hooks/useUrlState";
import { staleVerdictOf, type ReviewsByDoc, type StaleReviewsByDoc } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { ValueEquivalence } from "@/lib/equivalence";
import type { SplitLayout } from "@/lib/compare-split-layout";
import type { DocCoverage } from "@/app/(app)/projects/[id]/analyze/compare/page";
import type { CompareDocument, CompareResponse } from "./compare-types";

interface ComparePageProps {
  projectId: string;
  documents: CompareDocument[];
  responses: Record<string, CompareResponse[]>;
  divergentFields: Record<string, string[]>;
  fields: PydanticField[];
  existingReviews: ReviewsByDoc;
  /** Vereditos do revisor que perderam a validade, só como referência (#758). */
  staleReviews?: StaleReviewsByDoc;
  projectPydanticHash: string | null;
  respondentNames: string[];
  // Defaults VIVOS derivados do automation_mode/projeto (compareDefaultsForMode):
  // mantêm o filtro da UI coerente com o que o servidor aplica. `defaultMinHumans`
  // é o piso de humanos; `defaultVersion` é o default de versão da fila
  // ("latest_major") — sem ele o seletor exibiria "all" enquanto a fila já está
  // filtrada, e "Todas as versões" ficaria inalcançável (ver #247).
  defaultMinHumans: number;
  defaultVersion: string;
  coverageByDoc: Record<string, DocCoverage>;
  commentCountsByKey: Record<string, number>;
  suggestionCountsByField: Record<string, number>;
  availableVersions: string[];
  latestMajorLabel: string | null;
  currentProjectVersion: string;
  /** Equivalências de valor do projeto, por campo. */
  equivalencesByField: Record<string, ValueEquivalence[]>;
  currentUserId: string;
  canManageAnyPair: boolean;
  // Distinto de canManageAnyPair (permissão de ação sobre pares de
  // equivalência): isCoordinator só gateia a exibição do toggle de fila
  // "Meus atribuídos" / "Todos" — coordenador também compara documentos, por
  // isso o padrão é a fila pessoal dele, igual pesquisador.
  isCoordinator: boolean;
  // Estado da fila e da sessão, todo resolvido no servidor. Agrupado num objeto
  // porque as três flags descrevem a mesma coisa — o contexto da fila exibida —
  // e são consumidas juntas na copy do estado vazio; soltas, contavam como
  // quatro props booleanas e disparavam `no-many-boolean-props`.
  queueContext: QueueContext;
  /** Divisão leitor/revisão salva, lida do cookie no servidor (#610). */
  savedSplit: SplitLayout | null;
}

interface QueueContext {
  // Valor efetivo da aba de fila atual — fonte única pro valor exibido em
  // CompareQueueTabs (evita reler a URL no cliente) e pra mensagem do vazio.
  showingAll: boolean;
  // Se o coordenador TEM documentos atribuídos a ele para comparação (mesmo
  // que nenhum tenha passado nos filtros de cobertura/divergência) — usado só
  // pra diferenciar a mensagem de estado vazio: "sem nada atribuído" (trocar
  // de aba resolve) vs. "atribuído mas filtrado" (trocar de aba não resolve).
  hasAssignedDocs: boolean;
  // Master visualizando como outro membro (?viewAsUser=): a fila exibida é a
  // do membro impersonado, então a copy do estado vazio muda pra 3ª pessoa —
  // o "você não tem documentos atribuídos" desta tela já foi lido como sendo
  // sobre o membro quando era sobre o master.
  isImpersonating: boolean;
}

export function ComparePage({
  projectId,
  documents: serverDocuments,
  responses,
  divergentFields,
  fields,
  existingReviews,
  staleReviews,
  projectPydanticHash,
  respondentNames,
  defaultMinHumans,
  defaultVersion,
  coverageByDoc,
  commentCountsByKey,
  suggestionCountsByField,
  availableVersions,
  latestMajorLabel,
  currentProjectVersion,
  equivalencesByField,
  currentUserId,
  canManageAnyPair,
  isCoordinator,
  queueContext,
  savedSplit,
}: ComparePageProps) {
  const { showingAll: showingAllQueue, hasAssignedDocs, isImpersonating } =
    queueContext;
  // Impersonação master torna a Comparação somente-leitura (issue #428). Mesma
  // convenção `readOnly: boolean` do Codificar (`code/page.tsx`).
  const readOnly = isImpersonating;

  // Ordem estável de montagem: o re-sort por pendências do servidor (a cada
  // veredito) não remexe a fila nem a sidebar — só mudança de composição
  // (filtro/exclusão) altera a ordem. `showingAllQueue` como resetKey: ao
  // trocar de ESCOPO de fila (Meus↔Todos), a ordem nasce do zero em vez de
  // manter os docs da fila pessoal presos no topo. Ver useStableDocOrder.
  const documents = useStableDocOrder(serverDocuments, showingAllQueue);

  const { localReviews, recordReview } = useCompareReviews(existingReviews);

  // Única leitura/escrita da URL pro toggle de fila — CompareQueueTabs é só
  // JSX controlado (mesmo padrão de CodingHeader). O valor exibido vem
  // direto de `showingAllQueue` (já resolvido no servidor, fail-closed) em
  // vez de re-derivar `queue === "all"` no cliente.
  const { set: setUrlState } = useUrlState();
  const queueValue: CompareQueueScope = showingAllQueue ? "all" : "mine";
  const handleQueueChange = useCallback(
    (value: CompareQueueScope) =>
      setUrlState({ queue: value === "all" ? "all" : null }),
    [setUrlState],
  );

  const {
    docIndex,
    currentDoc,
    allDocDivergent,
    docFields,
    fieldIndex,
    setFieldIndex,
    filter,
    changeFilter,
    currentFieldName,
    currentField,
    isCurrentDocComplete,
    reviewedDocsCount,
    hasNextDoc,
    handleDocNavigate,
    handleNextDoc,
    goNextField,
    goPrevField,
  } = useCompareNavigation({
    documents,
    divergentFields,
    fields,
    localReviews,
    resetKey: showingAllQueue,
  });

  const {
    fieldResponses,
    answerGroups,
    currentFieldEquivalences,
    allowEquivalence,
  } = useCompareFieldData({
    currentDoc,
    currentFieldName,
    currentField,
    responses,
    fields,
    projectPydanticHash,
    equivalencesByField,
  });

  // Contexto da decisão: o par (doc, campo) exibido, o veredito dele e a
  // origem carimbada nos caminhos de escrita. `ctxKey` inclui `readOnly` para
  // que entrar ou sair de impersonação descarte comentário e rascunho da
  // identidade anterior.
  const { currentVerdict, ctxKey, currentOrigin } = useCompareDecisionContext(
    currentDoc,
    currentFieldName,
    readOnly,
    localReviews,
  );

  const [comment, setComment] = useCompareCommentDraft(
    ctxKey,
    currentVerdict?.comment ?? "",
  );

  const {
    handleVerdict,
    handleConfirmEquivalent,
    handleUnmarkPair,
  } = useCompareVerdicts({
    readOnly,
    projectId,
    currentDoc,
    currentFieldName,
    allDocDivergent,
    localReviews,
    fieldResponses,
    comment,
    recordReview,
    goNextField,
  });

  const {
    pendingVerdict,
    isSavingVerdict,
    isSaveInFlight,
    preparePendingVerdict,
    submitCurrentVerdict,
    handleConfirmPending,
    discardPendingVerdict,
  } = useCompareVerdictFlow({ ctxKey, currentOrigin, handleVerdict });

  const {
    isFullscreen,
    toggleFullscreen,
    exitFullscreen,
    listCollapsed,
    toggleList,
  } = useCompareLayoutToggles();

  const nav = useCompareNavGuard({
    hasPendingVerdict: pendingVerdict !== null,
    isSaveInFlight,
    handleDocNavigate,
    setFieldIndex,
    handleNextDoc,
    goNextField,
    goPrevField,
    changeFilter,
    changeQueue: handleQueueChange,
  });

  useCompareKeyboard({
    readOnly,
    isFullscreen,
    currentField,
    answerGroups,
    origin: currentOrigin,
    onToggleFullscreen: toggleFullscreen,
    onExitFullscreen: exitFullscreen,
    onNextField: nav.nextField,
    onPrevField: nav.prevField,
    onPrepareVerdict: preparePendingVerdict,
    onSubmitSpecialVerdict: submitCurrentVerdict,
    onConfirmPendingVerdict: handleConfirmPending,
    hasPendingVerdict: pendingVerdict !== null,
  });

  const docListEntries = buildDocListEntries(
    documents,
    coverageByDoc,
    divergentFields,
    localReviews,
  );
  const docList = {
    docs: docListEntries,
    onSelect: nav.navigateDoc,
    collapsed: listCollapsed,
    onToggle: toggleList,
  };
  const frame = {
    showQueueTabs: isCoordinator,
    queueValue,
    onQueueChange: nav.changeQueue,
    readOnly,
  };

  if (!currentDoc || docFields.length === 0) {
    return (
      <CompareFrame fullscreen={false} {...frame}>
        <div className="flex flex-1 w-full">
          <CompareDocList {...docList} currentIndex={docIndex} />
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            {resolveEmptyMessage({
              hasDocuments: documents.length > 0,
              isCoordinator,
              showingAll: showingAllQueue,
              hasAssignedDocs,
              isImpersonating,
            })}
          </div>
        </div>
      </CompareFrame>
    );
  }

  const docTitle = docTitleOf(currentDoc);
  const reviewedFields = localReviews[currentDoc.id] ?? {};

  return (
    <CompareFrame fullscreen={isFullscreen} {...frame}>
      {isFullscreen ? (
        <FullscreenNav
          title={docTitle}
          currentIndex={docIndex}
          total={documents.length}
          onNavigate={nav.navigateDoc}
          onExit={toggleFullscreen}
        />
      ) : (
        <CompareNav
          readOnly={readOnly}
          title={docTitle}
          docIndex={docIndex}
          totalDocs={documents.length}
          onDocNavigate={nav.navigateDoc}
          filter={filter}
          onFilterChange={nav.changeFieldFilter}
          fields={fields}
          reviewedDocsCount={reviewedDocsCount}
          onToggleFullscreen={toggleFullscreen}
          parecerUrl={parecerUrlOf(projectId, currentDoc.id)}
          respondentNames={respondentNames}
          defaultMinHumans={defaultMinHumans}
          defaultVersion={defaultVersion}
          availableVersions={availableVersions}
          latestMajorLabel={latestMajorLabel}
          currentProjectVersion={currentProjectVersion}
          projectId={projectId}
          documentId={currentDoc.id}
          canRunLlm={canManageAnyPair}
          guardNavigation={nav.guardNavigation}
        />
      )}

      <CompareWorkspace
        docs={docListEntries}
        docIndex={docIndex}
        onDocNavigate={nav.navigateDoc}
        listCollapsed={listCollapsed}
        onToggleList={toggleList}
        documentText={currentDoc.text}
        savedSplit={savedSplit}
        comparisonPanel={{
          readOnly,
          projectId,
          documentId: currentDoc.id,
          documentTitle: docTitle,
          ...fieldPanelPropsOf(currentField, currentFieldName),
          fields,
          fieldIndex,
          totalFields: docFields.length,
          responses: fieldResponses,
          existingVerdict: currentVerdict,
          staleVerdict: staleVerdictOf(staleReviews, currentDoc.id, currentFieldName),
          reviewed: docFields.map((fn) => !!reviewedFields[fn]),
          docStatus: isCurrentDocComplete
            ? { complete: true, hasNextDoc, onNextDoc: nav.nextDoc }
            : { complete: false },
          onFieldNavigate: nav.navigateField,
          onVerdict: submitCurrentVerdict,
          pendingVerdict,
          onPrepareVerdict: preparePendingVerdict,
          onConfirmPendingVerdict: handleConfirmPending,
          onDiscardPendingVerdict: discardPendingVerdict,
          isSavingVerdict,
          comment,
          onCommentChange: setComment,
          commentCount: fieldCommentCountOf(
            commentCountsByKey,
            currentDoc.id,
            currentFieldName,
          ),
          suggestionCount: suggestionCountsByField[currentFieldName] ?? 0,
          equivalence: { allow: allowEquivalence, canManageAnyPair },
          equivalences: currentFieldEquivalences,
          onConfirmEquivalent: handleConfirmEquivalent,
          onUnmarkEquivalencePair: handleUnmarkPair,
          currentUserId,
        }}
      />
    </CompareFrame>
  );
}
