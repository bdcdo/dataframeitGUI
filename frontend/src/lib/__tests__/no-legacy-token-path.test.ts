import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// T028 — RC-003/RC-004 (FR-004, FR-010, FR-014, SC-005/SC-006): gate estrutural
// que falha se o caminho crítico de autenticação regredir. É a "regressão
// detectável" exigida pela decisão D6: um teste barato que lê o código-fonte e
// trava três invariantes que uma edição futura poderia desfazer em silêncio.

const SRC = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
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

  it("FR-010: dashboard e conclusão de acesso não instruem debug de token", () => {
    for (const page of [
      "app/(app)/dashboard/page.tsx",
      "app/auth/post-login/page.tsx",
    ]) {
      expect(read(page)).not.toContain("debug-token");
    }
  });
});
