"use client";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "./DocumentReader";
import { QuestionsPanel, type QuestionsPanelProps } from "./QuestionsPanel";
import { FullscreenNav } from "./FullscreenNav";

interface AssignedCodingViewProps extends QuestionsPanelProps {
  docId: string;
  text: string;
  title: string;
  docIndex: number;
  total: number;
  isFullscreen: boolean;
  onNavigate: (index: number) => void;
  onExitFullscreen: () => void;
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
  outOfScope,
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
            outOfScope={outOfScope}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
