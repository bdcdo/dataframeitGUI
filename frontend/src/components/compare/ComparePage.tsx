"use client";

import { useCallback } from "react";
import { CompareQueueTabs, type CompareQueueScope } from "./CompareQueueTabs";
import { CompareEmptyState } from "./CompareEmptyState";
import { CompareMainView } from "./CompareMainView";
import { useCompareReviews } from "./useCompareReviews";
import { useCompareNavigation } from "./useCompareNavigation";
import { useStableDocOrder } from "./useStableDocOrder";
import { useCompareFieldData } from "./useCompareFieldData";
import { useCompareVerdicts } from "./useCompareVerdicts";
import { useCompareCommentDraft } from "./useCompareCommentDraft";
import { useCompareVerdictSubmission } from "./useCompareVerdictSubmission";
import { useCompareNavGuard } from "./useCompareNavGuard";
import { useCompareViewToggles } from "./useCompareViewToggles";
import { useCompareKeyboard } from "./useCompareKeyboard";
import {
  buildDocListEntries,
  resolveEmptyMessage,
  type CompareDocStatus,
} from "./compare-view";
import { useUrlState } from "@/hooks/useUrlState";
import type { ReviewsByDoc } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { DocCoverage } from "@/app/(app)/projects/[id]/analyze/compare/page";
import type {
  CompareDocument,
  CompareResponse,
  EquivalencePairWire,
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
  // Estado da fila e da sessão, todo resolvido no servidor. Agrupado num objeto
  // porque as três flags descrevem a mesma coisa — o contexto da fila exibida —
  // e são consumidas juntas na copy do estado vazio; soltas, contavam como
  // quatro props booleanas e disparavam `no-many-boolean-props`.
  queueContext: QueueContext;
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
  queueContext,
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

  // Mantido como objeto (não desestruturado): repassado agrupado a
  // `CompareMainView`/`buildComparisonPanel`, que o leem via `fieldData.x`.
  const fieldData = useCompareFieldData({
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

  // Identidade do par (doc, campo, readOnly): fonte única da "troca de
  // contexto" que reseta o comentário e descarta o rascunho pendente (#430).
  // Trocar de campo re-semeia do novo veredito; entrar/sair de impersonação
  // (readOnly muda) descarta rascunho da identidade anterior. `null` quando não
  // há doc/campo — a sentinela `undefined` interna dos guards ainda dispara no
  // primeiro render.
  const ctxKey =
    currentDoc && currentFieldName
      ? `${currentDoc.id}|${currentFieldName}|${readOnly}`
      : null;

  const { comment, setComment } = useCompareCommentDraft({
    currentVerdict,
    ctxKey,
  });

  // Objetos mantidos agrupados (ver `fieldData` acima): consumidos por
  // `buildComparisonPanel` via `verdicts.x`/`submission.x`. O container só lê
  // deles os campos que alimentam navegação e teclado.
  const verdicts = useCompareVerdicts({
    readOnly,
    projectId,
    currentDoc,
    currentFieldName,
    isCurrentFieldDivergent,
    allDocDivergent,
    localReviews,
    fieldResponses: fieldData.fieldResponses,
    comment,
    recordReview,
    goNextField,
  });

  const submission = useCompareVerdictSubmission({
    ctxKey,
    handleVerdict: verdicts.handleVerdict,
  });

  // Mantido como objeto: repassado agrupado a `CompareEmptyState`/
  // `CompareMainView` (evita props booleanas soltas — `no-many-boolean-props`).
  const toggles = useCompareViewToggles();

  const {
    guardNavigation,
    navigateDoc,
    navigateField,
    nextDoc,
    nextField,
    prevField,
    changeFieldFilter,
    changeQueue,
  } = useCompareNavGuard({
    pendingVerdict: submission.pendingVerdict,
    isSaveInFlight: submission.isSaveInFlight,
    handleDocNavigate,
    setFieldIndex,
    handleNextDoc,
    goNextField,
    goPrevField,
    changeFilter,
    handleQueueChange,
  });

  // Adaptadores `async () => Promise` → `() => void` para as assinaturas
  // síncronas de `useCompareKeyboard`. Precisam de identidade estável: o hook
  // recebe os dois no array de deps do seu único effect, então um arrow inline
  // religaria o listener de `keydown` a cada render do container.
  const submitVerdictSingleFlight = submission.submitVerdictSingleFlight;
  const confirmPendingVerdict = submission.confirmPendingVerdict;
  const handleSpecialVerdict = useCallback(
    (verdict: "ambiguo" | "pular") => void submitVerdictSingleFlight(verdict),
    [submitVerdictSingleFlight],
  );
  const handleConfirmPending = useCallback(
    () => void confirmPendingVerdict(),
    [confirmPendingVerdict],
  );

  useCompareKeyboard({
    readOnly,
    isFullscreen: toggles.isFullscreen,
    isCurrentDocComplete,
    isCurrentFieldDivergent,
    currentField,
    answerGroups: fieldData.answerGroups,
    onToggleFullscreen: toggles.toggleFullscreen,
    onExitFullscreen: toggles.exitFullscreen,
    onNextField: nextField,
    onPrevField: prevField,
    onPrepareVerdict: submission.preparePendingVerdict,
    onSubmitSpecialVerdict: handleSpecialVerdict,
    onConfirmPendingVerdict: handleConfirmPending,
    hasPendingVerdict: !!submission.pendingVerdict,
  });

  const reviewed = docFields.map(
    (fn) => !!localReviews[currentDoc?.id ?? ""]?.[fn],
  );

  const docListEntries = buildDocListEntries(
    documents,
    coverageByDoc,
    divergentFields,
    localReviews,
  );

  // Bar do toggle de fila, compartilhada pelos dois branches de return
  // abaixo (estado vazio e visão completa) — só coordenador vê.
  const queueTabsBar = isCoordinator ? (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <CompareQueueTabs value={queueValue} onValueChange={changeQueue} />
    </div>
  ) : null;

  const readOnlyNotice = readOnly ? (
    <output
      className="block shrink-0 border-b border-violet-200 bg-violet-50 px-4 py-1.5 text-center text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-100"
    >
      Visualização como outro membro: a Comparação está somente leitura. Volte
      para master para registrar vereditos, equivalências, notas ou sugestões e
      para executar LLM.
    </output>
  ) : null;

  if (!currentDoc || docFields.length === 0) {
    // A copy distingue "sem nada atribuído" de "atribuído mas filtrado" e muda
    // de pessoa na impersonação — a lógica completa vive em `resolveEmptyMessage`.
    const emptyMessage = resolveEmptyMessage({
      documentsLength: documents.length,
      isCoordinator,
      showingAllQueue,
      hasAssignedDocs,
      isImpersonating,
    });

    return (
      <CompareEmptyState
        queueTabsBar={queueTabsBar}
        readOnlyNotice={readOnlyNotice}
        docListEntries={docListEntries}
        docIndex={docIndex}
        onSelect={navigateDoc}
        listCollapsed={toggles.listCollapsed}
        onToggleList={toggles.toggleList}
        emptyMessage={emptyMessage}
      />
    );
  }

  // União discriminada montada aqui (não em `CompareMainView`) para que o
  // documento concluído/pendente viaje como uma prop só (ver #430; e evita
  // `isComplete`/`hasNextDoc` soltos em `no-many-boolean-props`).
  const docStatus: CompareDocStatus = isCurrentDocComplete
    ? { complete: true, hasNextDoc, onNextDoc: nextDoc }
    : { complete: false };

  return (
    <CompareMainView
      submission={submission}
      verdicts={verdicts}
      fieldData={fieldData}
      queueTabsBar={queueTabsBar}
      readOnlyNotice={readOnlyNotice}
      currentDoc={currentDoc}
      currentField={currentField}
      currentFieldName={currentFieldName}
      currentVerdict={currentVerdict}
      fields={fields}
      fieldIndex={fieldIndex}
      totalFields={docFields.length}
      docIndex={docIndex}
      documentsCount={documents.length}
      filter={filter}
      reviewedDocsCount={reviewedDocsCount}
      reviewed={reviewed}
      isDivergent={isCurrentFieldDivergent}
      docStatus={docStatus}
      docListEntries={docListEntries}
      comment={comment}
      readOnly={readOnly}
      projectId={projectId}
      canManageAnyPair={canManageAnyPair}
      currentUserId={currentUserId}
      respondentNames={respondentNames}
      defaultMinHumans={defaultMinHumans}
      defaultVersion={defaultVersion}
      availableVersions={availableVersions}
      latestMajorLabel={latestMajorLabel}
      currentProjectVersion={currentProjectVersion}
      commentCountsByKey={commentCountsByKey}
      suggestionCountsByField={suggestionCountsByField}
      toggles={toggles}
      guardNavigation={guardNavigation}
      onDocNavigate={navigateDoc}
      onFieldNavigate={navigateField}
      onFilterChange={changeFieldFilter}
      onConfirmPendingVerdict={handleConfirmPending}
      onCommentChange={setComment}
    />
  );
}
