"use client";

import { useEffect } from "react";
import { useGroupRef, type Layout } from "react-resizable-panels";
import { DocumentReader } from "../coding/DocumentReader";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  LEGACY_SPLIT_STORAGE_KEY,
  READER_PANEL_ID,
  REVIEW_PANEL_ID,
  parseSplitLayout,
  splitLayoutCookie,
  type SplitLayout,
} from "@/lib/compare-split-layout";
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
  /** Divisão salva, lida do cookie pela página no servidor; `null` = 50/50. */
  savedSplit: SplitLayout | null;
}

// Grava toda divisão aplicada, inclusive a da montagem: se a salva cair fora
// das restrições (abaixo do `minSize`), a lib a ajusta ao montar, e gravar o
// ajuste faz o salto acontecer uma vez em vez de a cada carga.
function persistSplit(layout: Layout) {
  const valid = parseSplitLayout(JSON.stringify(layout));
  if (valid) document.cookie = splitLayoutCookie(valid);
}

/**
 * Até a divisão ir para cookie, o `useDefaultLayout` a gravava em
 * localStorage. Quem salvou uma naquela época a recupera aqui, uma vez, depois
 * da hidratação: aplicar antes divergiria do HTML do servidor, que não lê
 * localStorage. O `setLayout` dispara `onLayoutChanged`, que grava o cookie.
 */
function useMigrateLegacySplit(
  groupRef: ReturnType<typeof useGroupRef>,
  hasSavedSplit: boolean,
) {
  useEffect(() => {
    let legacy: string | null;
    try {
      legacy = window.localStorage.getItem(LEGACY_SPLIT_STORAGE_KEY);
      if (legacy !== null) window.localStorage.removeItem(LEGACY_SPLIT_STORAGE_KEY);
    } catch {
      return; // storage bloqueado: não há o que migrar
    }
    // Com cookie presente, ele é mais novo que a chave antiga.
    if (hasSavedSplit) return;
    const layout = parseSplitLayout(legacy);
    if (layout) groupRef.current?.setLayout(layout);
    // Rodar de novo é inócuo: a chave antiga já foi apagada na primeira vez.
  }, [groupRef, hasSavedSplit]);
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
  savedSplit,
}: CompareWorkspaceProps) {
  // Quem revisa muito ajusta a divisão uma vez e a mantém; sem isto, toda
  // sessão recomeçava em 50/50 (#610). A divisão chega por prop, e não por
  // leitura de storage no render, para que servidor e hidratação usem o MESMO
  // valor por construção (ver `compare-split-layout.ts`).
  const groupRef = useGroupRef();
  useMigrateLegacySplit(groupRef, savedSplit !== null);

  return (
    <div className="flex flex-1 overflow-hidden">
      <CompareDocList
        docs={docs}
        currentIndex={docIndex}
        onSelect={onDocNavigate}
        collapsed={listCollapsed}
        onToggle={onToggleList}
      />

      <ResizablePanelGroup
        className="flex-1"
        groupRef={groupRef}
        defaultLayout={savedSplit ?? undefined}
        onLayoutChanged={persistSplit}
      >
        {/* `id` explícito: é a chave do painel no layout salvo. */}
        <ResizablePanel id={READER_PANEL_ID} defaultSize="50%" minSize="25%">
          <DocumentReader text={documentText} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id={REVIEW_PANEL_ID} defaultSize="50%" minSize="25%">
          <ComparisonPanel {...comparisonPanel} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
