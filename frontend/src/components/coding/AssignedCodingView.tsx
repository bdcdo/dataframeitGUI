"use client";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "./DocumentReader";
import { QuestionsPanel, type OutOfScopeConfig } from "./QuestionsPanel";
import { FullscreenNav } from "./FullscreenNav";
import { CodingEmptyStates } from "./CodingEmptyStates";
import type { RoundFilterData } from "./CodingPage";
import type { AssignedDoc, PydanticField } from "@/lib/types";

interface AssignedCodingViewProps {
  /** Doc atribuído atual — `undefined` quando não há nenhum a mostrar
   *  (lista vazia ou filtro de rodada sem pendências). */
  doc: AssignedDoc | undefined;
  title: string;
  docIndex: number;
  total: number;
  isFullscreen: boolean;
  onNavigate: (index: number) => void;
  onExitFullscreen: () => void;
  fields: PydanticField[];
  answers: Record<string, unknown>;
  onAnswer: (fieldName: string, value: unknown) => void;
  onSubmit: () => void;
  submitting: boolean;
  notes: string;
  onNotesChange: (notes: string) => void;
  readOnly: boolean;
  onReorder: (newOrder: string[]) => void;
  outOfScope?: OutOfScopeConfig;
  /** Todos os docs atribuídos foram codificados nesta sessão. */
  allDone: boolean;
  onExploreMore: () => void;
  hasAssignments: boolean;
  roundFilter?: RoundFilterData;
}

/**
 * Corpo do modo Atribuídos: cascata de estados (tudo concluído / sem doc /
 * leitor + perguntas), espelhando o padrão já usado por `BrowseCodingView`
 * para o modo Explorar — decidir aqui em vez de no container (#389).
 */
export function AssignedCodingView({
  doc,
  title,
  docIndex,
  total,
  isFullscreen,
  onNavigate,
  onExitFullscreen,
  fields,
  answers,
  onAnswer,
  onSubmit,
  submitting,
  notes,
  onNotesChange,
  readOnly,
  onReorder,
  outOfScope,
  allDone,
  onExploreMore,
  hasAssignments,
  roundFilter,
}: AssignedCodingViewProps) {
  if (allDone) {
    return (
      <CodingEmptyStates
        kind="all-done"
        count={total}
        onExploreMore={onExploreMore}
      />
    );
  }
  if (!doc) {
    return (
      <CodingEmptyStates
        kind="no-doc"
        hasAssignments={hasAssignments}
        roundFilter={roundFilter}
      />
    );
  }
  return (
    <>
      {isFullscreen && (
        <FullscreenNav
          title={title}
          currentIndex={docIndex}
          total={total}
          onNavigate={onNavigate}
          onExit={onExitFullscreen}
        />
      )}
      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={55} minSize={25}>
          <DocumentReader text={doc.text} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={45} minSize={25}>
          <QuestionsPanel
            key={doc.id}
            fields={fields}
            answers={answers}
            onAnswer={onAnswer}
            onSubmit={onSubmit}
            submitting={submitting}
            notes={notes}
            onNotesChange={onNotesChange}
            readOnly={readOnly}
            onReorder={onReorder}
            outOfScope={outOfScope}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
