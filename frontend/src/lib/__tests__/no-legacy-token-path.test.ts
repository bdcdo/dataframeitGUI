import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// T028 — RC-003/RC-004 (FR-004, FR-010, FR-014, SC-005/SC-006): gate estrutural
// que falha se o caminho crítico de autenticação regredir. É a "regressão
// detectável" exigida pela decisão D6: um teste barato que lê o código-fonte e
// trava três invariantes que uma edição futura poderia desfazer em silêncio.

const SRC = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** Todos os `.ts`/`.tsx` de produção sob `src/`, com os testes de fora.
 *
 * Exclui tanto os diretórios `__tests__` quanto arquivos `*.test.ts(x)` soltos —
 * nem todo teste do projeto mora num `__tests__` (ex.: `app/api/webhooks/clerk/
 * route.test.ts`), e um teste varrido aqui viraria falso-positivo por citar de
 * propósito a forma que o gate proíbe. */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(full);
    }
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("gate de regressão do render path autenticado", () => {
  it("RC-004: a rota de debug de token não volta (superfície de token-debug)", () => {
    // A rota diagnóstica que despejava claims/JWT/supabase_uid foi removida
    // (FR-010). Sua reintrodução reabriria a exposição de token ao usuário.
    expect(existsSync(join(SRC, "app/api/debug-token/route.ts"))).toBe(false);
  });

  it("RC-002: layouts protegidos delegam identidade ao page-auth", () => {
    // A decisão de navegação fica em uma única fronteira: page-auth consome a
    // resolução discriminada, enquanto layouts não projetam estados em null nem
    // voltam a chamar currentUser()/auth() por conta própria.
    const pageAuth = read("lib/page-auth.ts");
    expect(pageAuth).toMatch(/\bresolveAuth\s*\(/);
    expect(pageAuth).not.toMatch(/\b(?:currentUser|getAuthUser)\s*\(/);

    for (const layout of [
      "app/(app)/layout.tsx",
      "app/(app)/projects/[id]/layout.tsx",
    ]) {
      const code = read(layout);
      expect(code).toMatch(/\brequirePageAuthUser\s*\(/);
      expect(code).not.toMatch(
        /\b(?:resolveAuth|currentUser|getAuthUser)\s*\(/,
      );
    }
  });

  it("RC-003/FR-008: getAuthUser não repara vínculo no render (sem sync no auth.ts)", () => {
    // A resolução read-only não pode voltar a chamar syncClerkUserToSupabase —
    // o reparo mora só na Server Action de conclusão de acesso.
    const auth = read("lib/auth.ts");
    // Casa a CHAMADA (com parêntese), não menções em comentário — a doc do
    // próprio arquivo cita o nome ao explicar por que não o chama.
    expect(auth).not.toMatch(/syncClerkUserToSupabase\s*\(/);
    expect(auth).not.toContain('import { syncClerkUserToSupabase }');
  });

  it("#348: nenhuma chamada de getToken passa `template` (JWT template não volta)", () => {
    // O template `supabase` foi removido do código em favor do session token.
    // Uma chamada `getToken({ template: "supabase" })` reintroduzida emitiria um
    // token com `aud` e sem os custom claims — o backend valida `iss` (#487) e a
    // RLS depende de `supabase_uid`/`role`, então a regressão apareceria como
    // listas vazias e 401, não como erro de compilação. Este gate torna
    // permanente o `grep` que hoje se faz à mão a cada revisão.
    //
    // O alvo é a propriedade `template`, NÃO o objeto de opções: `getToken({
    // skipCache: true })` é legítimo e está em uso no AccessCompletionCard (#440)
    // para reemitir o token depois que `completeAccess` grava a metadata. Um gate
    // sobre `getToken({` proibiria esse uso junto com o legado.
    //
    // Casa a CHAMADA com objeto literal, nunca a passagem da referência
    // (`requireSupabaseToken(getToken)`), e ignora testes: o contrato do session
    // token cita a forma legada de propósito, ao explicar por que ela não volta.
    const offenders = sourceFiles()
      .filter((file) =>
        /getToken\s*\(\s*\{[^}]*\btemplate\b/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("FR-010: dashboard e conclusão de acesso não instruem debug de token", () => {
    for (const page of [
      "app/(app)/dashboard/page.tsx",
      "app/auth/post-login/page.tsx",
    ]) {
      expect(read(page)).not.toContain("debug-token");
    }
  });
});
