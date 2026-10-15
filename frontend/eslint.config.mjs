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
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.name='DndContext']:not(:has(> JSXAttribute[name.name='id']))",
          message:
            "Passe `id={useId()}` ao DndContext: o id gerado pelo @dnd-kit diverge entre servidor e cliente na hidratação.",
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
