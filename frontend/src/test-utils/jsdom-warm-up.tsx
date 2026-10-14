import { beforeAll } from "vitest";

// Cada arquivo de teste roda num processo novo, e o primeiro teste de um
// arquivo jsdom pagava sozinho a compilação de React DOM, Testing Library,
// user-event e Radix: de 1 a 6 s com a suíte disputando a CPU, contra algumas
// centenas de milissegundos dos testes seguintes, e o bastante para estourar o
// timeout de 5 s de qualquer teste que fosse o primeiro. Este hook exercita
// esses caminhos uma vez, antes dos testes e com prazo próprio, e não deixa
// nada montado.
//
// Só entram bibliotecas que nenhum teste mocka. O hook roda depois da coleta do
// arquivo, quando os vi.mock dele já valem, e um módulo do projeto como
// @/components/ui/button chegaria aqui mockado nos arquivos que o mockam: o
// aquecimento exercitaria código diferente em cada arquivo. Os imports são
// dinâmicos e ficam atrás da guarda de ambiente para que os arquivos de
// ambiente node não carreguem nada disto.
//
// O hook também não instala stubs de jsdom: o Dialog do Radix monta sem eles, e
// um stub aqui esconderia a dependência que src/test-utils/radix-jsdom.ts pede
// que cada arquivo declare.
beforeAll(async () => {
  if (typeof document === "undefined") return;
  const [{ cleanup, render, screen }, { default: userEvent }, { Dialog }] =
    await Promise.all([
      import("@testing-library/react"),
      import("@testing-library/user-event"),
      import("radix-ui"),
    ]);
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
}, 30_000);
