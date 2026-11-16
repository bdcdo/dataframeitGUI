"use client";

import { useCallback, useState } from "react";

const LIST_COLLAPSED_KEY = "compare:listCollapsed";

/**
 * Tela cheia e lista lateral recolhida da Comparação. Extraído de
 * `ComparePage` na decomposição do container (#564).
 */
export function useCompareLayoutToggles() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(
    () => setIsFullscreen((prev) => !prev),
    [],
  );
  const exitFullscreen = useCallback(() => setIsFullscreen(false), []);

  // Lista lateral recolhida atravessa sessões: quem revisa muito recolhe uma
  // vez e não quer refazer o gesto todo dia (#610). Mesmo idioma do
  // `AutoReviewFooter` — lazy initializer no mount, sem flicker — e não o
  // `usePinnedDoc`: aquele existe para reagir a escrita externa e limpar
  // órfãos, e um toggle de sidebar não tem escritor concorrente nem domínio de
  // validade.
  const [listCollapsed, setListCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(LIST_COLLAPSED_KEY) === "1";
  });
  // `setItem` no handler e NÃO dentro do updater: o React pode reexecutar o
  // updater e o efeito colateral se repetiria. Ler `listCollapsed` do closure
  // é seguro porque só o clique altera o valor — e a dependência mantém o
  // closure fresco, ao custo de trocar a identidade da callback uma vez por
  // alternância.
  const toggleList = useCallback(() => {
    const next = !listCollapsed;
    setListCollapsed(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LIST_COLLAPSED_KEY, next ? "1" : "0");
    }
  }, [listCollapsed]);

  return {
    isFullscreen,
    toggleFullscreen,
    exitFullscreen,
    listCollapsed,
    toggleList,
  };
}
