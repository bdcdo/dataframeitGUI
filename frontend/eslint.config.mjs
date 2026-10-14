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

// Locator criado sobre um container já achado por `getByRole` (dialog, article)
// não precisa do filtro: o container visível não contém a cópia órfã.
const e2eLocatorRules = [
  {
    selector: `CallExpression[callee.object.name=${PAGE_NAME}][callee.property.name=/^(${HIDDEN_INSENSITIVE_LOCATORS.join("|")})$/]:not(CallExpression[callee.name="visivel"] > CallExpression.arguments)`,
    message:
      "Locator que parte da página e não é getByRole enxerga a cópia oculta de um segmento de Suspense. Envolva a chamada direto em visivel(), de ./visivel, antes de .first()/.nth().",
  },
  {
    selector:
      'CallExpression[callee.property.name="getByRole"] Property[key.name="includeHidden"][value.value=true]',
    message:
      "includeHidden: true devolve a cópia oculta de um segmento de Suspense, que o getByRole ignora por padrão (ver e2e/visivel.ts).",
  },
  {
    selector: `VariableDeclarator[init.argument.callee.property.name="newPage"]:not([id.name=${PAGE_NAME}])`,
    message:
      "Variável com Page se chama page ou termina em Page: é pelo nome que a regra de visivel() reconhece a página.",
  },
  {
    selector: `Identifier[typeAnnotation.typeAnnotation.typeName.name="Page"]:not([name=${PAGE_NAME}])`,
    message:
      "Parâmetro ou variável do tipo Page se chama page ou termina em Page: é pelo nome que a regra de visivel() reconhece a página.",
  },
  {
    selector: `ObjectPattern > Property[key.name="page"][value.type="Identifier"]:not([value.name=${PAGE_NAME}])`,
    message:
      "A fixture page não se renomeia na desestruturação: é pelo nome que a regra de visivel() reconhece a página.",
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
