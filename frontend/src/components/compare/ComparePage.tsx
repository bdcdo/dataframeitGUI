"use client";

import { useCallback, useRef, useState } from "react";
import { FullscreenNav } from "../coding/FullscreenNav";
import { CompareNav } from "./CompareNav";
import { CompareDocList, type DocListEntry } from "./CompareDocList";
import { CompareWorkspace } from "./CompareWorkspace";
import { useCompareReviews } from "./useCompareReviews";
import { useCompareNavigation } from "./useCompareNavigation";
import { useCompareFieldData } from "./useCompareFieldData";
import { useCompareVerdicts } from "./useCompareVerdicts";
import { useCompareKeyboard } from "./useCompareKeyboard";
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
}

export function ComparePage({
  projectId,
  documents,
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
}: ComparePageProps) {
  const { localReviews, recordReview } = useCompareReviews(existingReviews);

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
  } = useCompareNavigation({ documents, divergentFields, fields, localReviews });

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
  const commentCtxKey =
    currentDoc && currentFieldName
      ? `${currentDoc.id}|${currentFieldName}`
      : null;
  // Sentinela `undefined` (≠ qualquer chave e ≠ null) força o guard a disparar
  // no PRIMEIRO render, semeando o comentário do veredito existente já na
  // montagem — o effect original fazia isso (depois do paint); aqui é antes.
  const commentCtxRef = useRef<string | null | undefined>(undefined);
  if (commentCtxKey !== commentCtxRef.current) {
    commentCtxRef.current = commentCtxKey;
    setComment(currentVerdict?.comment ?? "");
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
    onVerdict: handleVerdict,
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

  if (!currentDoc || docFields.length === 0) {
    return (
      <div className="flex h-[calc(100vh-96px)] w-full">
        <CompareDocList
          docs={docListEntries}
          currentIndex={docIndex}
          onSelect={handleDocNavigate}
          collapsed={listCollapsed}
          onToggle={toggleList}
        />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          {documents.length === 0
            ? "Nenhum documento na fila com os filtros atuais."
            : "Nenhuma divergência neste documento."}
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
          onVerdict: handleVerdict,
          onMarkReviewed: handleMarkReviewed,
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
