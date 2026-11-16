import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// O filtro `files:` do hook do react-doctor no .pre-commit-config.yaml. O
// pre-commit casa o regex (Python `re.search`) contra o caminho a partir da
// raiz do repositório; os padrões usados aqui valem igual em JS.
const config = fs.readFileSync(
  fileURLToPath(new URL("../../../../.pre-commit-config.yaml", import.meta.url)),
  "utf8",
);
const fromHook = config.slice(config.indexOf("- id: react-doctor"));
// Só o bloco do hook, até o próximo `- id:`: sem o corte, um `files:` ausente
// aqui casaria o de outro hook.
const hook = fromHook.slice(0, fromHook.indexOf("\n      - id:", 1));
const files = new RegExp(/^\s+files: (.+)$/m.exec(hook)![1]);

describe("hook do react-doctor: o que o dispara", () => {
  it("dispara com o package.json e o lock, e não só com TS", () => {
    for (const path of [
      "frontend/package.json",
      "frontend/package-lock.json",
      "frontend/src/components/coding/CodingPage.tsx",
      "frontend/src/lib/server-error.ts",
    ]) {
      expect(files.test(path), path).toBe(true);
    }
  });

  it("não dispara fora do frontend nem com outro JSON", () => {
    for (const path of ["backend/pyproject.toml", "docs/LINT_CONFIG.md", "frontend/tsconfig.json"]) {
      expect(files.test(path), path).toBe(false);
    }
  });
});
