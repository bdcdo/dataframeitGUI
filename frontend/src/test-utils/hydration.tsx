import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { onTestFinished } from "vitest";

export interface HydrationResult {
  container: HTMLElement;
  /** Avisos de hidratação que o React emitiu (console.error e erros recuperáveis). */
  hydrationErrors: string[];
}

/**
 * Renderiza com `renderToString`, põe o HTML num container e hidrata com
 * `hydrateRoot`, no mesmo processo, para pegar divergência entre o HTML do
 * servidor e o primeiro render do cliente.
 *
 * Alcance: pega divergência que vem de estado de módulo ou de valor que muda
 * entre um render e outro. Um contador global de ids, por exemplo, avança entre
 * os dois renders, como avança entre o processo do servidor e o bundle do
 * navegador. NÃO reproduz o ambiente do servidor: o `renderToString` roda no
 * jsdom, com `window`, `localStorage` e `matchMedia` definidos, então um desvio
 * por `typeof window` renderiza igual nos dois lados e passa despercebido.
 *
 * Divergência de atributo não lança no React 19: ela só sai em `console.error`
 * em modo dev, e o DOM fica com o valor do servidor. O que casa com "hydrat" vai
 * para `hydrationErrors`; o resto segue para o `console.error` original, para o
 * helper não esconder aviso que o teste não está julgando.
 *
 * O container é desmontado e removido ao fim do teste, mesmo quando o teste
 * falha antes, para que um alvo de `aria-describedby` de um teste não satisfaça
 * a busca no `document` do teste seguinte.
 */
export async function hydrateFromServerHtml(element: ReactElement): Promise<HydrationResult> {
  const html = renderToString(element);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  const hydrationErrors: string[] = [];
  // Troca direta, sem `vi.spyOn`: quando o teste já espiona `console.error`, o
  // `spyOn` devolve o mesmo espião, e o "original" guardado aqui seria ele
  // mesmo, com recursão infinita no repasse.
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (/hydrat/i.test(message)) hydrationErrors.push(message);
    else originalConsoleError(...args);
  };

  let root: Root | undefined;
  onTestFinished(() => {
    act(() => root?.unmount());
    container.remove();
  });
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
    console.error = originalConsoleError;
  }

  return { container, hydrationErrors };
}
