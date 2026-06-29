"use client";

import { DocumentReader } from "../coding/DocumentReader";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ComparisonPanel } from "./ComparisonPanel";
import { CompareDocList, type DocListEntry } from "./CompareDocList";

interface CompareWorkspaceProps {
  docs: DocListEntry[];
  docIndex: number;
  onDocNavigate: (index: number) => void;
  listCollapsed: boolean;
  onToggleList: () => void;
  documentText: string;
  comparisonPanel: React.ComponentProps<typeof ComparisonPanel>;
}

/**
 * Corpo presentacional da Comparação: lista de documentos + leitor do texto e
 * o painel de comparação, lado a lado e redimensionáveis. Extraído de
 * `ComparePage` para reduzir o tamanho do container (`no-giant-component`).
 */
export function CompareWorkspace({
  docs,
  docIndex,
  onDocNavigate,
  listCollapsed,
  onToggleList,
  documentText,
  comparisonPanel,
}: CompareWorkspaceProps) {
  return (
    <div className="flex flex-1 overflow-hidden">
      <CompareDocList
        docs={docs}
        currentIndex={docIndex}
        onSelect={onDocNavigate}
        collapsed={listCollapsed}
        onToggle={onToggleList}
      />

      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={50} minSize={25}>
          <DocumentReader text={documentText} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={50} minSize={25}>
          <ComparisonPanel {...comparisonPanel} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
