import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listFiles, productionSourceFiles, SRC_ROOT } from "@/test-utils/source-files";

const rel = (files: string[]) => files.map((file) => path.relative(SRC_ROOT, file));

describe("productionSourceFiles", () => {
  const files = rel(productionSourceFiles());

  it("traz o código de produção de src/", () => {
    expect(files).toContain("lib/server-error.ts");
    expect(files).toContain("proxy.ts");
    expect(files).toContain("components/shared/DocPager.tsx");
  });

  it("deixa de fora testes, __tests__ e test-utils", () => {
    expect(files.some((file) => /\.(test|spec)\./.test(file))).toBe(false);
    expect(files.some((file) => file.split(path.sep).includes("__tests__"))).toBe(false);
    expect(files.some((file) => file.startsWith(`test-utils${path.sep}`))).toBe(false);
  });

  it("aceita outra raiz", () => {
    const supabase = rel(productionSourceFiles(path.join(SRC_ROOT, "lib", "supabase")));
    expect(supabase).toContain(path.join("lib", "supabase", "admin.ts"));
    expect(supabase.every((file) => file.startsWith(path.join("lib", "supabase")))).toBe(true);
  });
});

describe("listFiles", () => {
  it("lista pelo predicado do nome e desce nas pastas", () => {
    const tests = rel(listFiles(SRC_ROOT, (name) => name.endsWith(".test.ts")));
    expect(tests).toContain(path.join("test-utils", "__tests__", "source-files.test.ts"));
  });
});

// A regra num diretório de fixture: o src/ real não tem `.spec.` nem `.md`, e
// sem fixture a exclusão deles nunca seria exercida.
describe("productionSourceFiles — regra de inclusão", () => {
  it("só fonte JS/TS fora de testes, __tests__ e test-utils", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-files-"));
    try {
      for (const file of [
        "a.ts",
        "b.tsx",
        "c.mjs",
        "a.spec.ts",
        "a.test.tsx",
        "nota.md",
        "__tests__/x.ts",
        "test-utils/y.ts",
        "pasta/d.cts",
      ]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), "");
      }
      expect(productionSourceFiles(root).map((file) => path.relative(root, file)).sort()).toEqual(
        ["a.ts", "b.tsx", "c.mjs", path.join("pasta", "d.cts")].sort(),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
