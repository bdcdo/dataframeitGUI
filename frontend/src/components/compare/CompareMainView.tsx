"use client";

import type { ReactNode } from "react";
import { FullscreenNav } from "../coding/FullscreenNav";
import { CompareNav } from "./CompareNav";
import { CompareWorkspace } from "./CompareWorkspace";
import { type DocListEntry } from "./CompareDocList";
import {
  buildCompareMeta,
  buildComparisonPanel,
  type CompareDocStatus,
} from "./compare-view";
import type { VerdictInfo } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { CompareDocument } from "./compare-types";
import type { CompareFieldData } from "./useCompareFieldData";
import type { CompareVerdicts } from "./useCompareVerdicts";
import type { CompareVerdictSubmission } from "./useCompareVerdictSubmission";
import type { CompareViewToggles } from "./useCompareViewToggles";

interface CompareMainViewProps {
  // Hooks de orquestração agrupados — repassados a `buildComparisonPanel` como
  // objetos, não desmembrados aqui (ver a nota anti-duplicação lá).
  submission: CompareVerdictSubmission;
  verdicts: CompareVerdicts;
  fieldData: CompareFieldData;
  // Barras de topo montadas no container (só coordenador / só impersonação).
  queueTabsBar: ReactNode;
  readOnlyNotice: ReactNode;
  // Documento/campo atual e derivados de navegação.
  currentDoc: CompareDocument;
  currentField: PydanticField | undefined;
  currentFieldName: string;
  currentVerdict: VerdictInfo | null;
  fields: PydanticField[];
  fieldIndex: number;
  totalFields: number;
  docIndex: number;
  documentsCount: number;
  filter: string;
  reviewedDocsCount: number;
  reviewed: boolean[];
  isDivergent: boolean;
  docStatus: CompareDocStatus;
  docListEntries: DocListEntry[];
  comment: string;
  // Contexto de projeto/sessão e configuração de fila.
  readOnly: boolean;
  projectId: string;
  canManageAnyPair: boolean;
  currentUserId: string;
  respondentNames: string[];
  defaultMinHumans: number;
  defaultVersion: string;
  availableVersions: string[];
  latestMajorLabel: string | null;
  currentProjectVersion: string;
  commentCountsByKey: Record<string, number>;
  suggestionCountsByField: Record<string, number>;
  // Estado de apresentação agrupado (tela cheia + sidebar) — passado como
  // objeto para não somar props booleanas soltas (`no-many-boolean-props`,
  // mesma razão de `queueContext` em `ComparePageProps`).
  toggles: CompareViewToggles;
  // Handlers de navegação (já guardados).
  guardNavigation: () => boolean;
  onDocNavigate: (index: number) => void;
  onFieldNavigate: (index: number) => void;
  onFilterChange: (value: string) => void;
  onConfirmPendingVerdict: () => void;
  onCommentChange: (value: string) => void;
}

/**
 * Visão principal da Comparação quando há documento/campo: barra de navegação
 * (tela cheia ou normal) + workspace com o painel de comparação. Extraída de
 * `ComparePage` na decomposição do container (`no-giant-component`, #564) para
 * separar a orquestração (hooks, no container) da apresentação (aqui). Os
 * valores derivados vêm de `buildCompareMeta`/`buildComparisonPanel`, mantendo
 * este componente sem lógica de montagem própria.
 */
export function CompareMainView({
  submission,
  verdicts,
  fieldData,
  queueTabsBar,
  readOnlyNotice,
  currentDoc,
  currentField,
  currentFieldName,
  currentVerdict,
  fields,
  fieldIndex,
  totalFields,
  docIndex,
  documentsCount,
  filter,
  reviewedDocsCount,
  reviewed,
  isDivergent,
  docStatus,
  docListEntries,
  comment,
  readOnly,
  projectId,
  canManageAnyPair,
  currentUserId,
  respondentNames,
  defaultMinHumans,
  defaultVersion,
  availableVersions,
  latestMajorLabel,
  currentProjectVersion,
  commentCountsByKey,
  suggestionCountsByField,
  toggles,
  guardNavigation,
  onDocNavigate,
  onFieldNavigate,
  onFilterChange,
  onConfirmPendingVerdict,
  onCommentChange,
}: CompareMainViewProps) {
  const { isFullscreen, toggleFullscreen, listCollapsed, toggleList } = toggles;
  const meta = buildCompareMeta({
    currentDoc,
    projectId,
    currentFieldName,
    commentCountsByKey,
    suggestionCountsByField,
  });

  const comparisonPanel = buildComparisonPanel({
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
  });

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-96px)] flex-col"
      }
    >
      {!isFullscreen && queueTabsBar}
      {readOnlyNotice}

      {isFullscreen ? (
        <FullscreenNav
          title={meta.docTitle}
          currentIndex={docIndex}
          total={documentsCount}
          onNavigate={onDocNavigate}
          onExit={toggleFullscreen}
        />
      ) : (
        <CompareNav
          readOnly={readOnly}
          title={meta.docTitle}
          docIndex={docIndex}
          totalDocs={documentsCount}
          onDocNavigate={onDocNavigate}
          filter={filter}
          onFilterChange={onFilterChange}
          fields={fields}
          reviewedDocsCount={reviewedDocsCount}
          onToggleFullscreen={toggleFullscreen}
          parecerUrl={meta.parecerUrl}
          respondentNames={respondentNames}
          defaultMinHumans={defaultMinHumans}
          defaultVersion={defaultVersion}
          availableVersions={availableVersions}
          latestMajorLabel={latestMajorLabel}
          currentProjectVersion={currentProjectVersion}
          projectId={projectId}
          documentId={currentDoc.id}
          canRunLlm={canManageAnyPair}
          guardNavigation={guardNavigation}
        />
      )}

      <CompareWorkspace
        docs={docListEntries}
        docIndex={docIndex}
        onDocNavigate={onDocNavigate}
        listCollapsed={listCollapsed}
        onToggleList={toggleList}
        documentText={currentDoc.text}
        comparisonPanel={comparisonPanel}
      />
    </div>
  );
}
