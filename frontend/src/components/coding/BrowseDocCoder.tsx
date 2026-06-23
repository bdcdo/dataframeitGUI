"use client";

import { useCallback, useState } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "./DocumentReader";
import { QuestionsPanel } from "./QuestionsPanel";
import { FullscreenNav } from "./FullscreenNav";
import type { CodingDocument } from "@/hooks/useDocumentForCoding";
import type { PydanticField } from "@/lib/types";

interface BrowseDocCoderProps {
  /** Documento já carregado (texto + respostas/notas iniciais). */
  doc: CodingDocument;
  fields: PydanticField[];
  submitting: boolean;
  readOnly: boolean;
  isFullscreen: boolean;
  /** Título exibido na barra de fullscreen. */
  title: string;
  responseCount: number;
  onToggleFullscreen: () => void;
  onReorder: (newOrder: string[]) => void;
  /** Dispara o envio; o container faz o `saveResponse` + coordenação. */
  onSubmit: (answers: Record<string, unknown>, notes: string) => void;
  /** Reporta o rascunho atual para cima (autosave-on-exit + dirty tracking). */
  onDraftChange: (answers: Record<string, unknown>, notes: string) => void;
}

/**
 * Coder de um único documento do modo Explorar. Filho **keyed por docId** no
 * container: o estado editável é semeado via lazy `useState` a partir do `doc`
 * já carregado (sem `setState` em effect), e remonta limpo a cada doc.
 *
 * Não guarda o doc selecionado em estado no container nem usa effect de
 * deep-link — isso zera `no-derived-state`/`no-chain-state-updates`/
 * `no-event-handler` do `CodingPage`. O rascunho é reportado para cima
 * (`onDraftChange`) para o autosave-on-exit centralizado (#28) ler via ref.
 */
export function BrowseDocCoder({
  doc,
  fields,
  submitting,
  readOnly,
  isFullscreen,
  title,
  responseCount,
  onToggleFullscreen,
  onReorder,
  onSubmit,
  onDraftChange,
}: BrowseDocCoderProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>(
    () => doc.initialAnswers,
  );
  const [notes, setNotes] = useState(() => doc.initialNotes);

  const handleAnswer = useCallback(
    (fieldName: string, value: unknown) => {
      const next = { ...answers, [fieldName]: value };
      setAnswers(next);
      onDraftChange(next, notes);
    },
    [answers, notes, onDraftChange],
  );

  const handleNotesChange = useCallback(
    (next: string) => {
      setNotes(next);
      onDraftChange(answers, next);
    },
    [answers, onDraftChange],
  );

  const handleSubmit = useCallback(() => {
    onSubmit(answers, notes);
  }, [answers, notes, onSubmit]);

  return (
    <>
      {isFullscreen && (
        <FullscreenNav
          title={title}
          responseCount={responseCount}
          onExit={onToggleFullscreen}
        />
      )}
      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={55} minSize={25}>
          <DocumentReader text={doc.document.text} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={45} minSize={25}>
          <QuestionsPanel
            fields={fields}
            answers={answers}
            onAnswer={handleAnswer}
            onSubmit={handleSubmit}
            submitting={submitting}
            notes={notes}
            onNotesChange={handleNotesChange}
            readOnly={readOnly}
            onReorder={onReorder}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
