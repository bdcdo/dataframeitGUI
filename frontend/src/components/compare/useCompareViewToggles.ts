"use client";

import { useCallback, useState } from "react";

export interface CompareViewToggles {
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  exitFullscreen: () => void;
  listCollapsed: boolean;
  toggleList: () => void;
}

/**
 * Estado de apresentação da Comparação sem regra de negócio: tela cheia e
 * sidebar recolhida. Extraído de `ComparePage` na decomposição do container
 * (`no-giant-component`, #564) — dois toggles independentes da orquestração de
 * veredito/navegação, agrupados por serem puramente visuais.
 */
export function useCompareViewToggles(): CompareViewToggles {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(
    () => setIsFullscreen((prev) => !prev),
    [],
  );
  const exitFullscreen = useCallback(() => setIsFullscreen(false), []);
  const [listCollapsed, setListCollapsed] = useState(false);
  const toggleList = useCallback(() => setListCollapsed((v) => !v), []);
  return {
    isFullscreen,
    toggleFullscreen,
    exitFullscreen,
    listCollapsed,
    toggleList,
  };
}
