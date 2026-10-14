import type { Locator } from "@playwright/test";

// Restringe o locator ao que está na tela. Todo locator que parte da página e
// não é `getByRole` passa por aqui (a regra `no-restricted-syntax` de
// `eslint.config.mjs`, bloco `e2e/**`, barra quem não passar), porque o DOM
// pode ter uma segunda cópia oculta de um trecho inteiro da página.
//
// De onde ela vem: conteúdo dentro de um <Suspense> chega no SSR num segmento à
// parte (`<div hidden id="S:n">`, no fim do body), que o último script do
// documento (`$RC`) move para o lugar. Se o HTML termina antes desse script
// (num pre-push com a máquina carregada, o dev server registrou "The
// destination stream closed early"), o React vê a boundary ainda pendente com o
// documento já carregado, renderiza o conteúdo no cliente e o segmento do
// servidor fica órfão, escondido. O usuário não o vê e ele sai da árvore de
// acessibilidade, então `getByRole` já o ignora. `getByText`,
// `getByPlaceholder`, `getByTestId`, `locator(css)` e os demais não ignoram: a
// cópia órfã vira strict mode violation, dobra o `toHaveCount(n)` e faz o
// `toHaveCount(0)` acusar um elemento que ninguém vê.
//
// Não trocar por `.first()`/`.nth()`: a ordem das cópias no DOM é detalhe do
// streaming, e o índice errado afirmaria sobre um trecho que ninguém vê. Pelo
// mesmo motivo o filtro vem antes de qualquer `.first()`/`.nth()`, nunca depois.
export function visivel(locator: Locator): Locator {
  return locator.filter({ visible: true });
}
