// Listas da regra de locators visíveis nos specs E2E (bloco `e2e/**` de
// `eslint.config.mjs`). Ficam num módulo sem dependência para que o teste da
// regra as leia sem carregar o grafo do eslint-config-next.

// Seletores E2E que enxergam a cópia órfã e oculta de um segmento de Suspense
// (mecanismo descrito em `e2e/visivel.ts`). `getByRole` fica de fora porque já
// exclui o que saiu da árvore de acessibilidade, salvo com `includeHidden`.
export const HIDDEN_INSENSITIVE_LOCATORS = [
  "getByAltText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "getByText",
  "getByTitle",
  "locator",
];

// Métodos da página que recebem seletor em vez de partir de um locator. Ações
// (`click`, `fill`...) e consultas (`isVisible`, `waitForSelector`...) resolvem o
// seletor contra o DOM inteiro, cópia órfã inclusive.
export const LEGACY_SELECTOR_APIS = [
  "$",
  "$$",
  "$eval",
  "$$eval",
  "check",
  "click",
  "dblclick",
  "dispatchEvent",
  "dragAndDrop",
  "fill",
  "focus",
  "getAttribute",
  "hover",
  "innerHTML",
  "innerText",
  "inputValue",
  "isChecked",
  "isDisabled",
  "isEditable",
  "isEnabled",
  "isHidden",
  "isVisible",
  "press",
  "selectOption",
  "setChecked",
  "setInputFiles",
  "tap",
  "textContent",
  "type",
  "uncheck",
  "waitForSelector",
];
