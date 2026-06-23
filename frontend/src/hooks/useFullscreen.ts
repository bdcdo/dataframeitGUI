"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Modo tela cheia + atalhos de teclado (Esc sai, Ctrl+Shift+F alterna).
 * Extraído de `CodingPage` para reduzir o estado/effect do container.
 */
export function useFullscreen(): {
  isFullscreen: boolean;
  toggleFullscreen: () => void;
} {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(
    () => setIsFullscreen((prev) => !prev),
    [],
  );

  useEffect(() => {
    // Sempre `setIsFullscreen(false)` no Esc (no-op quando já `false`: o React
    // faz bail-out do re-render). Sem ler `isFullscreen` no handler, o effect
    // registra o listener uma vez só (deps `[]`) em vez de re-registrar a cada
    // toggle.
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
      if (e.key === "F" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return { isFullscreen, toggleFullscreen };
}
