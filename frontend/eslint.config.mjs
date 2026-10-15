import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import {
  RULE_NAME,
  serverActionExportsPlugin,
} from "./eslint-rules/server-action-exports.mjs";

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

// Sem type-checker, a regra reconhece a página pelo nome da variável. O
// segundo bloco de seletores abaixo impõe esse nome onde um `Page` nasce ou é
// recebido, para que renomear não seja um jeito silencioso de escapar.
const PAGE_NAME = "/^(page|.*Page)$/";

// Receptor que é a página: `page`/`*Page` direto ou como propriedade
// (`this.page` de um page object).
const PAGE_RECEIVER = `:matches([callee.object.name=${PAGE_NAME}], [callee.object.property.name=${PAGE_NAME}])`;

// `expect(page.getByText(x)).toHaveCount(0)` fica livre: a cópia órfã só
// duplica o que o servidor renderizou, então nunca cria o elemento que a
// asserção nega, e o filtro de visibilidade só a enfraqueceria (um elemento
// presente e oculto passaria).
const COUNT_ZERO_ARGUMENT =
  'CallExpression[callee.property.name="toHaveCount"][arguments.0.value=0] > MemberExpression.callee > CallExpression.object[callee.name="expect"] > CallExpression.arguments';

const PAGE_NAME_MESSAGE =
  "Page se chama page ou termina em Page: é pelo nome que a regra de visivel() reconhece a página.";

// Locator criado sobre um container achado por `getByRole` (dialog, article)
// não precisa do filtro: o container visível não contém a cópia órfã. `body` e
// `html` são a exceção, porque a cópia mora dentro deles; por isso ficam
// barrados mesmo dentro de visivel().
const e2eLocatorRules = [
  {
    selector: `CallExpression${PAGE_RECEIVER}[callee.property.name=/^(${HIDDEN_INSENSITIVE_LOCATORS.join("|")})$/]:not(CallExpression[callee.name="visivel"] > CallExpression.arguments):not(${COUNT_ZERO_ARGUMENT})`,
    message:
      "Locator que parte da página e não é getByRole enxerga a cópia oculta de um segmento de Suspense. Envolva a chamada direto em visivel(), de ./visivel, antes de .first()/.nth().",
  },
  {
    selector: `CallExpression${PAGE_RECEIVER}[callee.property.name=/^(\\$|\\$\\$|\\$eval|\\$\\$eval|textContent|innerText|innerHTML|getAttribute|inputValue)$/]`,
    message:
      "API legada da página que recebe seletor enxerga a cópia oculta de um segmento de Suspense. Use um locator com visivel() (ver e2e/visivel.ts).",
  },
  {
    selector:
      'CallExpression[callee.property.name="locator"][arguments.0.value=/^\\s*(html|body|:root)\\s*$/]',
    message:
      "body e html contêm a cópia oculta de um segmento de Suspense, mesmo filtrados por visivel(). Parta de getByRole (main, dialog) ou de um locator mais específico.",
  },
  {
    selector:
      'CallExpression[callee.property.name="getByRole"] Property[key.name="includeHidden"][value.value=true]',
    message:
      "includeHidden: true devolve a cópia oculta de um segmento de Suspense, que o getByRole ignora por padrão (ver e2e/visivel.ts).",
  },
  {
    selector: `VariableDeclarator[init.argument.callee.property.name="newPage"]:not([id.name=${PAGE_NAME}])`,
    message: `Variável criada por newPage(): ${PAGE_NAME_MESSAGE}`,
  },
  {
    selector: `VariableDeclarator[init.argument.callee.property.name="waitForEvent"][init.argument.arguments.0.value=/^(page|popup)$/]:not([id.name=${PAGE_NAME}])`,
    message: `Variável com a página de um evento page/popup: ${PAGE_NAME_MESSAGE}`,
  },
  {
    selector: `Identifier[typeAnnotation.typeAnnotation.typeName.name="Page"]:not([name=${PAGE_NAME}])`,
    message: `Parâmetro ou variável do tipo Page: ${PAGE_NAME_MESSAGE}`,
  },
  {
    selector: `TSPropertySignature[typeAnnotation.typeAnnotation.typeName.name="Page"]:not([key.name=${PAGE_NAME}])`,
    message: `Propriedade do tipo Page (fixture de test.extend, por exemplo): ${PAGE_NAME_MESSAGE}`,
  },
  {
    selector: `ObjectPattern > Property[key.name="page"][value.type="Identifier"]:not([value.name=${PAGE_NAME}])`,
    message: `A fixture page não se renomeia na desestruturação: ${PAGE_NAME_MESSAGE}`,
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{mts,ts,tsx}"],
    plugins: {
      "server-actions": serverActionExportsPlugin,
    },
    rules: {
      [`server-actions/${RULE_NAME}`]: "error",
    },
  },
  {
    files: ["e2e/**/*.{mts,ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...e2eLocatorRules],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
