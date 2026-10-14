import { beforeAll } from "vitest";

// Cada arquivo de teste roda num processo novo, e o primeiro teste de um
// arquivo jsdom pagava sozinho a compilação de React DOM, Testing Library,
// user-event e Radix: de 1 a 6 s com a suíte disputando a CPU, contra algumas
// centenas de milissegundos dos testes seguintes, e o bastante para estourar o
// timeout de 5 s de qualquer teste que fosse o primeiro. Este hook exercita
// esses caminhos uma vez, antes dos testes e com prazo próprio, e não deixa
// nada montado: um Dialog com digitação e clique, e um Popover com um Select
// aberto e escolhido, que é o caminho de Popper e Select dos filtros.
//
// Só entram bibliotecas que nenhum teste mocka. O hook roda depois da coleta do
// arquivo, quando os vi.mock dele já valem, e um módulo do projeto como
// @/components/ui/button chegaria aqui mockado nos arquivos que o mockam: o
// aquecimento exercitaria código diferente em cada arquivo. Os imports são
// dinâmicos e ficam atrás da guarda de ambiente para que os arquivos de
// ambiente node não carreguem nada disto.

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

beforeAll(async () => {
  if (typeof document === "undefined") return;
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
  } finally {
    cleanup();
    restoreStubs();
  }
}, 30_000);
