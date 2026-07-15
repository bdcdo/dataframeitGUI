// Fábrica do corpo do mock de @/lib/auth usada por testes de Server Actions
// que exigem coordenador de projeto (#387). A chamada
// `vi.mock("@/lib/auth", () => ...)` precisa continuar escrita no corpo de
// cada arquivo de teste (restrição de hoisting estático do Vitest).
//
// IMPORTANTE: `vi.hoisted(fn)` executa `fn` IMEDIATAMENTE na posição
// hoisted, acima dos bindings de import transpilados — chamar uma função
// importada de dentro de `vi.hoisted(() => ...)` quebra com
// "Cannot access '...' before initialization". Por isso `isCoord` continua
// sendo criado inline com `vi.fn(...)` dentro de `vi.hoisted()` em cada
// arquivo de teste; só o corpo (lazy) da factory de `vi.mock` é delegado
// para `authModuleMock`, chamado de dentro do callback de `vi.mock`, que
// SÓ roda quando o módulo mockado é de fato importado (bem depois de todo o
// topo do arquivo, imports inclusive, já ter executado).
//
// Um mock GLOBAL via `vitest.config.ts` (setupFiles) foi cogitado e
// descartado: `src/lib/__tests__/auth-effective-member.test.ts` testa a
// implementação REAL de `getEffectiveMemberId`/`getAuthUser` (só mocka as
// dependências transitivas — Clerk, supabase/admin — não `@/lib/auth` em
// si); um `vi.mock("@/lib/auth", ...)` em setupFiles substituiria esse
// módulo incondicionalmente para TODOS os arquivos, quebrando esse teste.
// A duplicação do par vi.hoisted/vi.mock nos poucos arquivos que precisam de
// override por teste é o preço de não ter um mock global de auth no repo.
export function authModuleMock(
  isCoord: () => Promise<boolean>,
  userId = "userCoord",
) {
  return {
    getAuthUser: async () => ({ id: userId }),
    // Espelha requireCoordinator real (lib/auth.ts): getAuthUser nesta
    // factory nunca retorna null, então só o gate de coordenador varia.
    requireCoordinator: async (_projectId: string, deniedMessage: string) => {
      if (!(await isCoord())) {
        return { ok: false, code: "forbidden", error: deniedMessage };
      }
      return { ok: true, user: { id: userId } };
    },
  };
}

export function projectIdentityAuthModuleMock(
  getEffectiveMemberId: (projectId: string) => Promise<string>,
  accountUserId = "linked-account",
) {
  return {
    getAuthUser: async () => ({ id: accountUserId }),
    getEffectiveMemberId,
  };
}

export function projectAccessAuthModuleMock(
  getAuthUser: () => Promise<unknown>,
  getProjectAccessContext: (
    projectId: string,
    user: unknown,
  ) => Promise<unknown>,
) {
  return { getAuthUser, getProjectAccessContext };
}
