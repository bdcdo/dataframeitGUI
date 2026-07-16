// Config ESLint *type-checked* — separada da base rapida (`eslint.config.mjs`)
// porque regras que precisam do type-checker (projectService) sao lentas e nao
// devem pesar o `npm run lint` do dia a dia. Roda via `npm run lint:types` e no
// hook de pre-push. Ver docs/CODE_QUALITY_TOOLING.md.
//
// Subset curado (nao o `recommendedTypeChecked` inteiro) para controlar ruido:
// foca nos footguns async que aparecem em Server Actions e chamadas ao Supabase.
// Importa o parser/plugin do pacote `typescript-eslint` explicitamente (em vez de
// depender do transitivo do eslint-config-next) para o vinculo ser robusto.
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import base from "./eslint.config.mjs";

const typedConfig = defineConfig([
  ...base,
  {
    files: ["src/**/*.{mts,ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
]);

export default typedConfig;
