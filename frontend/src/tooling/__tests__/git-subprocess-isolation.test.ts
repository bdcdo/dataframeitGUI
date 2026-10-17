import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isolatedGitEnvironment, runGit } from "@/test-utils/isolated-git";

// Teste que chama git em subprocesso sem passar por src/test-utils/isolated-git.ts
// herda, no pre-push, o GIT_DIR do hook e age sobre o repositório do push. A
// regra é textual: reprova a chamada direta de git por child_process em
// arquivo de teste, e o helper é o único lugar autorizado.
const SRC_ROOT = path.resolve(process.cwd(), "src");
// O helper é o lugar autorizado, e este arquivo traz amostras da regra.
const ALLOWED = new Set([
  path.join(SRC_ROOT, "test-utils/isolated-git.ts"),
  path.join(SRC_ROOT, "tooling/__tests__/git-subprocess-isolation.test.ts"),
]);
const DIRECT_GIT_CALL = /\b(?:execFileSync|execFile|execSync|exec|spawnSync|spawn)\(\s*["'`]git\b/;

function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(absolute);
    return /\.test\.(?:ts|tsx|mts|mjs)$/.test(entry.name) ? [absolute] : [];
  });
}

describe("git em subprocesso nos testes", () => {
  it("só pelo helper que limpa o ambiente do hook", () => {
    const offenders = testFiles(SRC_ROOT)
      .filter((file) => !ALLOWED.has(file) && DIRECT_GIT_CALL.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("a regra reconhece as formas de chamar git", () => {
    for (const call of ['execFileSync("git", ["init"])', "spawnSync('git', [])", "execSync(`git status`)", 'spawn(\n  "git", [])']) {
      expect(DIRECT_GIT_CALL.test(call)).toBe(true);
    }
    expect(DIRECT_GIT_CALL.test('spawnSync("bash", ["git.sh"])')).toBe(false);
  });

  it("o helper tira toda variável GIT_* e roda só pelo cwd", () => {
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "isca-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "alvo-"));
    try {
      runGit(["init", "-q"], decoy);
      vi.stubEnv("GIT_DIR", path.join(decoy, ".git"));
      vi.stubEnv("GIT_INDEX_FILE", path.join(decoy, ".git/index"));
      expect(Object.keys(isolatedGitEnvironment()).filter((name) => name.startsWith("GIT_"))).toEqual([]);

      runGit(["init", "-q"], target);
      fs.writeFileSync(path.join(target, "a.txt"), "");
      runGit(["add", "a.txt"], target);

      expect(runGit(["ls-files"], target)).toBe("a.txt\n");
      expect(fs.existsSync(path.join(decoy, ".git/index"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(decoy, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
