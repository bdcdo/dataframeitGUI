"use client";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "./DocumentReader";
import { QuestionsPanel } from "./QuestionsPanel";
import { FullscreenNav } from "./FullscreenNav";
import type { PydanticField } from "@/lib/types";

interface AssignedCodingViewProps {
  docId: string;
  text: string;
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
}

/** Painel de codificação do modo Atribuídos (leitor + perguntas). */
export function AssignedCodingView({
  docId,
  text,
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
}: AssignedCodingViewProps) {
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
          <DocumentReader text={text} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={45} minSize={25}>
          <QuestionsPanel
            key={docId}
            fields={fields}
            answers={answers}
            onAnswer={onAnswer}
            onSubmit={onSubmit}
            submitting={submitting}
            notes={notes}
            onNotesChange={onNotesChange}
            readOnly={readOnly}
            onReorder={onReorder}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
