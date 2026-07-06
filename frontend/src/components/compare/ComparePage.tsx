"use client";

import { useCallback, useRef, useState } from "react";
import { FullscreenNav } from "../coding/FullscreenNav";
import { CompareNav } from "./CompareNav";
import { CompareQueueTabs, type CompareQueueScope } from "./CompareQueueTabs";
import { CompareDocList, type DocListEntry } from "./CompareDocList";
import { CompareWorkspace } from "./CompareWorkspace";
import { useCompareReviews } from "./useCompareReviews";
import { useCompareNavigation } from "./useCompareNavigation";
import { useStableDocOrder } from "./useStableDocOrder";
import { useCompareFieldData } from "./useCompareFieldData";
import { useCompareVerdicts } from "./useCompareVerdicts";
import { useCompareKeyboard } from "./useCompareKeyboard";
import { useUrlState } from "@/hooks/useUrlState";
import type { ReviewsByDoc } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { DocCoverage } from "@/app/(app)/projects/[id]/analyze/compare/page";
import type {
  CompareDocument,
  CompareResponse,
  EquivalencePairWire,
  PendingVerdict,
} from "./compare-types";

interface ComparePageProps {
  projectId: string;
  documents: CompareDocument[];
  responses: Record<string, CompareResponse[]>;
  divergentFields: Record<string, string[]>;
  fields: PydanticField[];
  existingReviews: ReviewsByDoc;
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
  equivalencesByDocField: Record<
    string,
    Record<string, EquivalencePairWire[]>
  >;
  currentUserId: string;
  canManageAnyPair: boolean;
  // Distinto de canManageAnyPair (permissão de ação sobre pares de
  // equivalência): isCoordinator só gateia a exibição do toggle de fila
  // "Meus atribuídos" / "Todos" — coordenador também compara documentos, por
  // isso o padrão é a fila pessoal dele, igual pesquisador.
  isCoordinator: boolean;
  // Valor efetivo (resolvido no servidor) da aba de fila atual — fonte única
  // pro valor exibido em CompareQueueTabs (evita reler a URL no cliente) e
  // pra mensagem do estado vazio.
  showingAllQueue: boolean;
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
  equivalencesByDocField,
  currentUserId,
  canManageAnyPair,
  isCoordinator,
  showingAllQueue,
  hasAssignedDocs,
  isImpersonating,
}: ComparePageProps) {
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
    isCurrentFieldDivergent,
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
    equivalencesByDocField,
  });

  const currentVerdict =
    currentDoc && currentFieldName
      ? localReviews[currentDoc.id]?.[currentFieldName] ?? null
      : null;

  // Comentário editável, semeado do veredito do contexto atual. Resetado por
  // GUARD DE RENDER (não por effect) quando muda o par (doc, campo): elimina o
  // `no-derived-state` que o effect disparava. O prev-tracker é um `useRef`
  // (não `useState`) para não recair em `rerender-state-only-in-handlers`, e o
  // estado inicia em "" (literal, não prop) para não disparar `no-derived-useState`.
  // A chave é só (doc, campo): trocar de campo re-semeia do veredito do novo
  // campo; permanecer no mesmo campo (após emitir um veredito sem avanço)
  // preserva o comentário recém-digitado/salvo — por isso `useCompareVerdicts`
  // não limpa a caixa no sucesso.
  const [comment, setComment] = useState("");
  const verdictCtxKey =
    currentDoc && currentFieldName
      ? `${currentDoc.id}|${currentFieldName}`
      : null;
  const commentCtxKey = verdictCtxKey;
  // Sentinela `undefined` (≠ qualquer chave e ≠ null) força o guard a disparar
  // no PRIMEIRO render, semeando o comentário do veredito existente já na
  // montagem — o effect original fazia isso (depois do paint); aqui é antes.
  const commentCtxRef = useRef<string | null | undefined>(undefined);
  if (commentCtxKey !== commentCtxRef.current) {
    commentCtxRef.current = commentCtxKey;
    setComment(currentVerdict?.comment ?? "");
  }

  const [pendingVerdict, setPendingVerdict] = useState<PendingVerdict | null>(
    null,
  );
  const [isConfirmingVerdict, setIsConfirmingVerdict] = useState(false);
  const pendingVerdictCtxRef = useRef<string | null | undefined>(undefined);
  if (verdictCtxKey !== pendingVerdictCtxRef.current) {
    pendingVerdictCtxRef.current = verdictCtxKey;
    setPendingVerdict(null);
    setIsConfirmingVerdict(false);
  }

  const {
    handleVerdict,
    handleConfirmEquivalent,
    handleMarkReviewed,
    handleUnmarkPair,
  } = useCompareVerdicts({
    projectId,
    currentDoc,
    currentFieldName,
    isCurrentFieldDivergent,
    allDocDivergent,
    localReviews,
    fieldResponses,
    comment,
    recordReview,
    goNextField,
  });

  const preparePendingVerdict = useCallback((next: PendingVerdict) => {
    setPendingVerdict(next);
  }, []);

  const confirmPendingVerdict = useCallback(async () => {
    if (!pendingVerdict || isConfirmingVerdict) return;
    setIsConfirmingVerdict(true);
    try {
      const saved = await handleVerdict(
        pendingVerdict.verdict,
        pendingVerdict.chosenResponseId,
      );
      if (saved) setPendingVerdict(null);
    } finally {
      setIsConfirmingVerdict(false);
    }
  }, [handleVerdict, isConfirmingVerdict, pendingVerdict]);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(
    () => setIsFullscreen((prev) => !prev),
    [],
  );
  const exitFullscreen = useCallback(() => setIsFullscreen(false), []);
  const [listCollapsed, setListCollapsed] = useState(false);
  const toggleList = useCallback(() => setListCollapsed((v) => !v), []);

  useCompareKeyboard({
    isFullscreen,
    isCurrentDocComplete,
    isCurrentFieldDivergent,
    currentField,
    answerGroups,
    onToggleFullscreen: toggleFullscreen,
    onExitFullscreen: exitFullscreen,
    onNextField: goNextField,
    onPrevField: goPrevField,
    onPrepareVerdict: (verdict, chosenResponseId) => {
      const kind =
        verdict === "ambiguo" ? "ambiguous" : verdict === "pular" ? "skip" : "response";
      preparePendingVerdict({
        kind,
        verdict,
        chosenResponseId,
        label:
          kind === "ambiguous"
            ? "Ambíguo"
            : kind === "skip"
              ? "Pular"
              : verdict || "(vazia)",
      });
    },
    onConfirmPendingVerdict: () => void confirmPendingVerdict(),
    hasPendingVerdict: !!pendingVerdict,
  });

  const reviewed = docFields.map(
    (fn) => !!localReviews[currentDoc?.id ?? ""]?.[fn],
  );

  const docListEntries: DocListEntry[] = documents.map((d) => {
    const c = coverageByDoc[d.id];
    const reviewedOverride = localReviews[d.id]
      ? (divergentFields[d.id] ?? []).filter((fn) => !!localReviews[d.id][fn])
          .length
      : c?.reviewedCount ?? 0;
    return {
      id: d.id,
      title: d.title,
      external_id: d.external_id,
      humanCount: c?.humanCount ?? 0,
      totalCount: c?.totalCount ?? 0,
      assignedCodingCount: c?.assignedCodingCount ?? 0,
      humansFromAssigned: c?.humansFromAssigned ?? 0,
      divergentCount: c?.divergentCount ?? 0,
      reviewedCount: reviewedOverride,
      assignmentStatus: c?.assignmentStatus ?? null,
    };
  });

  // Bar do toggle de fila, compartilhada pelos dois branches de return
  // abaixo (estado vazio e visão completa) — só coordenador vê.
  const queueTabsBar = isCoordinator ? (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <CompareQueueTabs value={queueValue} onValueChange={handleQueueChange} />
    </div>
  ) : null;

  if (!currentDoc || docFields.length === 0) {
    // documents.length===0 na aba "Meus" pode ter duas causas bem diferentes:
    // (a) o coordenador não tem NENHUM documento atribuído — trocar pra
    // "Todos" resolve; (b) ele TEM documentos atribuídos, mas nenhum passou
    // nos filtros de cobertura/divergência (minHumans/minTotal/versão/etc.)
    // — trocar de aba não muda nada, o filtro de cobertura é ortogonal ao
    // de assignment. `hasAssignedDocs` (calculado em page.tsx a partir do
    // mesmo Set que já filtra a fila) diferencia os dois casos.
    // Na impersonação a fila exibida é a do membro, então o sujeito da copy
    // muda pra 3ª pessoa — "você" aqui já foi lido como sendo sobre o membro
    // quando descrevia a fila (vazia) do próprio master.
    const filteredOutMessage = isImpersonating
      ? "Os documentos atribuídos a este membro não atendem aos filtros atuais (respostas mínimas, versão, etc.). Ajuste os filtros ou use a aba \"Todos\" para ver a fila completa."
      : "Seus documentos atribuídos não atendem aos filtros atuais (respostas mínimas, versão, etc.). Ajuste os filtros ou use a aba \"Todos\" para ver a fila completa.";
    const nothingAssignedMessage = isImpersonating
      ? 'Este membro não tem documentos atribuídos para comparação. Use a aba "Todos" acima para ver a fila completa do projeto.'
      : 'Você não tem documentos atribuídos para comparação. Use a aba "Todos" acima para ver a fila completa do projeto.';
    const emptyMessage =
      documents.length === 0
        ? isCoordinator && !showingAllQueue
          ? hasAssignedDocs
            ? filteredOutMessage
            : nothingAssignedMessage
          : "Nenhum documento na fila com os filtros atuais."
        : "Nenhuma divergência neste documento.";

    return (
      <div className="flex h-[calc(100vh-96px)] flex-col">
        {queueTabsBar}
        <div className="flex flex-1 w-full">
          <CompareDocList
            docs={docListEntries}
            currentIndex={docIndex}
            onSelect={handleDocNavigate}
            collapsed={listCollapsed}
            onToggle={toggleList}
          />
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            {emptyMessage}
          </div>
        </div>
      </div>
    );
  }

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const parecerUrl = `${baseUrl}/projects/${projectId}/analyze/code?doc=${currentDoc.id}`;
  const docTitle = currentDoc.title || currentDoc.external_id || "Documento";

  const fieldCommentCount =
    (commentCountsByKey[`${currentDoc.id}|${currentFieldName}`] ?? 0) +
    (commentCountsByKey[`${currentDoc.id}|`] ?? 0);
  const fieldSuggestionCount = suggestionCountsByField[currentFieldName] ?? 0;

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-96px)] flex-col"
      }
    >
      {!isFullscreen && queueTabsBar}

      {isFullscreen ? (
        <FullscreenNav
          title={docTitle}
          currentIndex={docIndex}
          total={documents.length}
          onNavigate={handleDocNavigate}
          onExit={toggleFullscreen}
        />
      ) : (
        <CompareNav
          title={docTitle}
          docIndex={docIndex}
          totalDocs={documents.length}
          onDocNavigate={handleDocNavigate}
          filter={filter}
          onFilterChange={changeFilter}
          fields={fields}
          reviewedDocsCount={reviewedDocsCount}
          onToggleFullscreen={toggleFullscreen}
          parecerUrl={parecerUrl}
          respondentNames={respondentNames}
          defaultMinHumans={defaultMinHumans}
          defaultVersion={defaultVersion}
          availableVersions={availableVersions}
          latestMajorLabel={latestMajorLabel}
          currentProjectVersion={currentProjectVersion}
          projectId={projectId}
          documentId={currentDoc.id}
          canRunLlm={canManageAnyPair}
        />
      )}

      <CompareWorkspace
        docs={docListEntries}
        docIndex={docIndex}
        onDocNavigate={handleDocNavigate}
        listCollapsed={listCollapsed}
        onToggleList={toggleList}
        documentText={currentDoc.text}
        comparisonPanel={{
          projectId,
          documentId: currentDoc.id,
          documentTitle: docTitle,
          fieldName: currentFieldName,
          fieldDescription: currentField?.description || currentFieldName,
          fieldHelpText: currentField?.help_text,
          fieldType: currentField?.type,
          fieldOptions: currentField?.options,
          fields,
          fieldIndex,
          totalFields: docFields.length,
          responses: fieldResponses,
          existingVerdict: currentVerdict,
          reviewed,
          isDivergent: isCurrentFieldDivergent,
          docStatus: isCurrentDocComplete
            ? { complete: true, hasNextDoc, onNextDoc: handleNextDoc }
            : { complete: false },
          onFieldNavigate: setFieldIndex,
          onVerdict: (verdict, chosenResponseId) =>
            void handleVerdict(verdict, chosenResponseId),
          pendingVerdict,
          onPrepareVerdict: preparePendingVerdict,
          onConfirmPendingVerdict: () => void confirmPendingVerdict(),
          isConfirmingVerdict,
          onMarkReviewed: () => void handleMarkReviewed(),
          comment,
          onCommentChange: setComment,
          commentCount: fieldCommentCount,
          suggestionCount: fieldSuggestionCount,
          equivalence: { allow: allowEquivalence, canManageAnyPair },
          equivalences: currentFieldEquivalences,
          onConfirmEquivalent: handleConfirmEquivalent,
          onUnmarkEquivalencePair: handleUnmarkPair,
          currentUserId,
        }}
      />
    </div>
  );
}
