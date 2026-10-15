import { vi } from "vitest";

// Cada arquivo de teste roda num processo novo, e o primeiro teste de um
// arquivo jsdom paga sozinho o carregamento de React DOM, Testing Library,
// user-event e Radix (transformação pelo Vite e avaliação dos módulos) e a
// primeira execução dos caminhos de render, evento e consulta por papel, ainda
// sem otimização do JIT: de 1 a 6 s com a suíte disputando a CPU, contra algumas
// centenas de milissegundos dos testes seguintes, e o bastante para estourar o
// timeout de 5 s do primeiro teste. Um arquivo que sofre disso chama esta
// função num beforeAll com prazo próprio, e o custo sai do primeiro teste:
//
//   beforeAll(() => warmUpJsdom(), 30_000);
//
// A função não é um setupFiles de todos os arquivos jsdom de propósito. Num
// arquivo que usa Dialog e user-event ela só antecipa o que o primeiro teste
// pagaria; nos demais é custo novo, e aplicada a todos somava cerca de 20% da
// CPU da suíte para proteger cargas acima da faixa que a suíte precisa
// aguentar. Ela exercita um Dialog com digitação e clique e, com
// `select: true`, um Popover com um Select aberto e escolhido, que é o caminho
// de Popper e Select dos filtros. Nada fica montado.
//
// Só entram bibliotecas que nenhum teste mocka: um módulo do projeto como
// @/components/ui/button chegaria aqui mockado nos arquivos que o mockam, e o
// aquecimento exercitaria código diferente em cada arquivo.
//
// Um estado sobra, por desenho do user-event: o setup() prepara o document uma
// vez por processo, com ouvintes de focus e blur em captura que acompanham o
// valor dos campos e disparam change no blur quando ele mudou. Num arquivo que
// já usa user-event isso aconteceria de qualquer forma.

const ELEMENT_STUBS = [
  "scrollIntoView",
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
] as const;

// O Select e o Popper do Radix usam APIs que o jsdom não implementa. O hook as
// instala só enquanto roda e remove apenas as que ele mesmo instalou: um stub
// que sobrevivesse ao aquecimento esconderia a dependência que
// src/test-utils/radix-jsdom.ts pede que cada arquivo declare.
function installTemporaryRadixStubs(): () => void {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  const installed = ELEMENT_STUBS.filter((name) => typeof proto[name] !== "function");
  for (const name of installed) {
    proto[name] = name === "hasPointerCapture" ? () => false : () => {};
  }
  const globals = globalThis as unknown as Record<string, unknown>;
  const installedResizeObserver = typeof globals.ResizeObserver === "undefined";
  if (installedResizeObserver) {
    globals.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  return () => {
    for (const name of installed) delete proto[name];
    if (installedResizeObserver) delete globals.ResizeObserver;
  };
}

// Devolve as fases que percorreu, para que o teste da função prove que ela
// exercitou cada caminho, e não só que não deixou rastro.
export type WarmUpPhase = "dialog" | "select";

export async function warmUpJsdom({ select = false }: { select?: boolean } = {}): Promise<WarmUpPhase[]> {
  // Com timers falsos ligados, os setTimeout de user-event e do findByRole
  // ficam congelados e a função esperaria até estourar o prazo do hook. Trocar
  // para timers reais e voltar descartaria o relógio que o arquivo configurou.
  const ran: WarmUpPhase[] = [];
  if (vi.isFakeTimers()) return ran;
  const [{ cleanup, render, screen, within }, { default: userEvent }, { Dialog, Popover, Select }] =
    await Promise.all([
      import("@testing-library/react"),
      import("@testing-library/user-event"),
      import("radix-ui"),
    ]);
  const restoreStubs = installTemporaryRadixStubs();
  try {
    const user = userEvent.setup();
    render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Content aria-describedby={undefined}>
            <Dialog.Title>Aquecimento</Dialog.Title>
            <input aria-label="Campo" />
            <button type="button">Confirmar</button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );
    await user.type(screen.getByRole("textbox", { name: "Campo" }), "abc");
    await user.click(await screen.findByRole("button", { name: "Confirmar" }));
    cleanup();
    ran.push("dialog");
    if (!select) return ran;

    render(
      <Popover.Root>
        <Popover.Trigger>Abrir</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content>
            <Select.Root defaultValue="a">
              <Select.Trigger aria-label="Opção">
                <Select.Value />
              </Select.Trigger>
              <Select.Portal>
                <Select.Content position="popper">
                  <Select.Viewport>
                    <Select.Item value="a">
                      <Select.ItemText>A</Select.ItemText>
                    </Select.Item>
                    <Select.Item value="b">
                      <Select.ItemText>B</Select.ItemText>
                    </Select.Item>
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>,
    );
    await user.click(screen.getByRole("button", { name: "Abrir" }));
    await user.click(await screen.findByRole("combobox", { name: "Opção" }));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("B"));
    ran.push("select");
    return ran;
  } finally {
    cleanup();
    restoreStubs();
  }
}
