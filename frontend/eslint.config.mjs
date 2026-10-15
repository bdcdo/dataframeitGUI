import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import {
  RULE_NAME,
  serverActionExportsPlugin,
} from "./eslint-rules/server-action-exports.mjs";

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
      // Sem `id`, o @dnd-kit numera o `aria-describedby` dos itens arrastáveis
      // com um contador de módulo, que o servidor e o navegador avançam
      // separados: a hidratação diverge e o atributo que o React mantém do
      // servidor aponta para um id que não existe no cliente. O `id` vindo de
      // `useId()` é igual nos dois lados.
      //
      // O seletor casa pelo nome `DndContext` no JSX, então as duas primeiras
      // entradas proíbem as importações que o renomeariam (alias e namespace).
      // As duas últimas pegam `id` que não resolve o problema: `undefined` cai
      // no contador, e um literal colide quando o componente aparece duas
      // vezes na página. Wrapper que repassa props e `createElement` ficam fora
      // do alcance de um seletor sintático.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value='@dnd-kit/core'] > ImportSpecifier[imported.name='DndContext'][local.name!='DndContext']",
          message:
            "Importe DndContext sem alias: a regra que exige `id={useId()}` casa pelo nome no JSX.",
        },
        {
          selector:
            "ImportDeclaration[source.value='@dnd-kit/core'] > ImportNamespaceSpecifier",
          message:
            "Importe de @dnd-kit/core por nome: a regra que exige `id={useId()}` no DndContext casa pelo nome no JSX.",
        },
        {
          selector:
            "JSXOpeningElement[name.name='DndContext']:not(:has(> JSXAttribute[name.name='id']))",
          message:
            "Passe `id={useId()}` ao DndContext: o id gerado pelo @dnd-kit diverge entre servidor e cliente na hidratação.",
        },
        {
          selector:
            "JSXOpeningElement[name.name='DndContext'] > JSXAttribute[name.name='id']:matches([value.type='Literal'], [value.expression.type='Literal'], [value.expression.type='TemplateLiteral'], [value.expression.name='undefined'])",
          message:
            "Passe `id={useId()}` ao DndContext: `undefined` volta ao contador do @dnd-kit, e um id fixo colide quando o componente aparece duas vezes.",
        },
      ],
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
