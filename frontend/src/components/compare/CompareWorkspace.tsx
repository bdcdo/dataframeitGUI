"use client";

import { useEffect } from "react";
import {
  useGroupRef,
  type Layout,
  type LayoutChangedMeta,
} from "react-resizable-panels";
import { DocumentReader } from "../coding/DocumentReader";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  LEGACY_SPLIT_STORAGE_KEY,
  MIN_PANEL_SIZE,
  READER_PANEL_ID,
  REVIEW_PANEL_ID,
  parseLegacySplitLayout,
  parseSplitLayout,
  readSplitCookie,
  sameSplit,
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

// Grava só a divisão que a pessoa escolheu. A lib também chama
// `onLayoutChanged` na montagem, e lá o layout é o `defaultLayout` recebido,
// que pode estar velho: na volta pelo histórico o Next reaproveita o payload
// RSC em cache, com o cookie lido ANTES do último arraste. Gravar a montagem
// sobrescrevia a preferência com esse valor velho.
function persistUserSplit(layout: Layout, meta: LayoutChangedMeta) {
  if (!meta.isUserInteraction) return;
  const valid = parseSplitLayout(JSON.stringify(layout));
  if (valid) document.cookie = splitLayoutCookie(valid);
}

/**
 * Acerta a divisão depois da hidratação, sem tocar no render: aplicar antes
 * divergiria do HTML do servidor.
 *
 * - O cookie é a fonte. Se diverge do `savedSplit` recebido (payload RSC em
 *   cache, na volta pelo histórico), vale o cookie.
 * - Sem cookie, recupera uma vez a divisão que o `useDefaultLayout` gravava em
 *   localStorage antes da troca para cookie, e grava o que a lib aplicou (já
 *   dentro do mínimo). A chave antiga é apagada em qualquer caso: com cookie
 *   presente, ela é mais velha que ele.
 */
function useReconcileSplit(
  groupRef: ReturnType<typeof useGroupRef>,
  savedSplit: SplitLayout | null,
) {
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    let legacy: string | null = null;
    try {
      legacy = window.localStorage.getItem(LEGACY_SPLIT_STORAGE_KEY);
      if (legacy !== null) window.localStorage.removeItem(LEGACY_SPLIT_STORAGE_KEY);
    } catch {
      // storage bloqueado: não há chave antiga a migrar
    }

    const current = parseSplitLayout(readSplitCookie(document.cookie));
    if (current) {
      if (!sameSplit(current, savedSplit)) group.setLayout(current);
      return;
    }

    const migrated = parseLegacySplitLayout(legacy);
    if (!migrated) return;
    const applied = parseSplitLayout(JSON.stringify(group.setLayout(migrated)));
    if (applied) document.cookie = splitLayoutCookie(applied);
  }, [groupRef, savedSplit]);
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
  useReconcileSplit(groupRef, savedSplit);

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
        onLayoutChanged={persistUserSplit}
      >
        {/* `id` explícito: é a chave do painel no layout salvo. */}
        <ResizablePanel id={READER_PANEL_ID} defaultSize="50%" minSize={MIN_PANEL_SIZE}>
          <DocumentReader text={documentText} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id={REVIEW_PANEL_ID} defaultSize="50%" minSize={MIN_PANEL_SIZE}>
          <ComparisonPanel {...comparisonPanel} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
