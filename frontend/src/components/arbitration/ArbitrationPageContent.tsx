import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { DocumentReader } from "@/components/coding/DocumentReader";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";
import {
  ArbitrationDocList,
  type ArbitrationDocListEntry,
} from "./ArbitrationDocList";
import type { ArbitrationDoc } from "./ArbitrationPage";
import { BlindPhase } from "./BlindPhase";
import { RevealPhase } from "./RevealPhase";

interface ArbitrationPageContentProps {
  doc: ArbitrationDoc;
  fieldMeta: Map<string, PydanticField>;
  phase: "blind" | "reveal";
  arbitrationBlind: boolean;
  docListEntries: ArbitrationDocListEntry[];
  docIndex: number;
  listCollapsed: boolean;
  onSelectDoc: (index: number) => void;
  onToggleList: () => void;
  blindChoices: Record<string, "a" | "b">;
  finalChoices: Record<string, ArbitrationVerdict>;
  suggestions: Record<string, string>;
  comments: Record<string, string>;
  onChooseBlind: (fieldReviewId: string, choice: "a" | "b") => void;
  onChooseFinal: (fieldReviewId: string, verdict: ArbitrationVerdict) => void;
  onSuggestion: (fieldReviewId: string, v: string) => void;
  onComment: (fieldReviewId: string, v: string) => void;
}

export function ArbitrationPageContent({
  doc,
  fieldMeta,
  phase,
  arbitrationBlind,
  docListEntries,
  docIndex,
  listCollapsed,
  onSelectDoc,
  onToggleList,
  blindChoices,
  finalChoices,
  suggestions,
  comments,
  onChooseBlind,
  onChooseFinal,
  onSuggestion,
  onComment,
}: ArbitrationPageContentProps) {
  return (
    <div className="flex flex-1 overflow-hidden">
      <ArbitrationDocList
        docs={docListEntries}
        currentIndex={docIndex}
        onSelect={onSelectDoc}
        collapsed={listCollapsed}
        onToggle={onToggleList}
      />
      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={50} minSize={25}>
          <DocumentReader text={doc.text} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={50} minSize={25}>
          <div className="flex h-full flex-col">
            <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
              {phase === "blind"
                ? "Fase 1 (cega): escolha sem ver a justificativa do LLM."
                : "Fase 2: agora você vê a justificativa do LLM. Pode manter ou mudar sua escolha."}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {phase === "blind" ? (
                <BlindPhase
                  fields={doc.fields}
                  fieldMeta={fieldMeta}
                  choices={blindChoices}
                  onChoose={onChooseBlind}
                />
              ) : (
                <RevealPhase
                  fields={doc.fields}
                  fieldMeta={fieldMeta}
                  arbitrationBlind={arbitrationBlind}
                  finalChoices={finalChoices}
                  suggestions={suggestions}
                  comments={comments}
                  onChooseFinal={onChooseFinal}
                  onSuggestion={onSuggestion}
                  onComment={onComment}
                />
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
