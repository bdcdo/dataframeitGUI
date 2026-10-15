import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { vi } from "vitest";

export interface HydrationResult {
  container: HTMLElement;
  /** Avisos de hidratação que o React emitiu (console.error e erros recuperáveis). */
  hydrationErrors: string[];
  unmount: () => void;
}

/**
 * Reproduz o caminho SSR → hidratação do Next num único processo: o HTML vem de
 * `renderToString`, é posto num container e hidratado com `hydrateRoot`.
 *
 * Num único processo, estado de módulo compartilhado entre os dois renders (um
 * contador global de ids, por exemplo) avança entre o render do servidor e o do
 * cliente, que é exatamente a divergência que acontece entre o processo do
 * servidor e o bundle do navegador. Por isso o helper serve de prova para id que
 * não vem de `useId()`.
 *
 * Divergência de atributo não lança no React 19: ela só sai em `console.error`
 * em modo dev, e o DOM fica com o valor do servidor. O filtro por "hydrat" separa
 * esse aviso de outros erros do console que o teste não quer julgar.
 */
export async function hydrateFromServerHtml(element: ReactElement): Promise<HydrationResult> {
  const html = renderToString(element);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  const hydrationErrors: string[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (/hydrat/i.test(message)) hydrationErrors.push(message);
  });

  let root: Root | undefined;
  try {
    // `act` assíncrono deixa os efeitos de montagem rodarem, inclusive os que
    // renderizam conteúdo só no cliente depois da hidratação.
    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: (error) => {
          hydrationErrors.push(error instanceof Error ? error.message : String(error));
        },
      });
    });
  } finally {
    consoleError.mockRestore();
  }

  return {
    container,
    hydrationErrors,
    unmount: () => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}
