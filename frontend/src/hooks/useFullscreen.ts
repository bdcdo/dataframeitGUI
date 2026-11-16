"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Modo tela cheia + atalhos de teclado (Esc sai, Ctrl+Shift+F alterna).
 * Extraído de `CodingPage` para reduzir o estado/effect do container.
 *
 * `exitedAt` é o instante da última saída (0 antes da primeira): o que estava
 * escondido em fullscreen, como a oferta do rascunho, chega à tela nesse
 * momento, e a idade que ela mostra é medida dali.
 */
export function useFullscreen(): {
  isFullscreen: boolean;
  exitedAt: number;
  toggleFullscreen: () => void;
} {
  const [state, setState] = useState({ isFullscreen: false, exitedAt: 0 });

  // O instante é lido no handler, e não no updater, que o React pode chamar
  // duas vezes. Sem mudança, devolve o estado anterior: o Esc fora do
  // fullscreen é no-op (bail-out do re-render) e não mexe em `exitedAt`.
  const setFullscreen = useCallback((next: (prev: boolean) => boolean) => {
    const now = Date.now();
    setState((prev) => {
      const isFullscreen = next(prev.isFullscreen);
      if (isFullscreen === prev.isFullscreen) return prev;
      return { isFullscreen, exitedAt: isFullscreen ? prev.exitedAt : now };
    });
  }, []);

  const toggleFullscreen = useCallback(
    () => setFullscreen((prev) => !prev),
    [setFullscreen],
  );

  useEffect(() => {
    // Sem ler o estado no handler, o effect registra o listener uma vez só em
    // vez de re-registrar a cada toggle.
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullscreen(() => false);
      }
      if (e.key === "F" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        setFullscreen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setFullscreen]);

  return { ...state, toggleFullscreen };
}
