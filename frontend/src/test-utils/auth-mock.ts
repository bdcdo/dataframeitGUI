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
export function authModuleMock(isCoord: () => Promise<boolean>, userId = "userCoord") {
  return {
    getAuthUser: async () => ({ id: userId }),
    isProjectCoordinator: () => isCoord(),
  };
}
