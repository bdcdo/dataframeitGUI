/**
 * Contrato do session token do Clerk exigido pela RLS (#348).
 *
 * `createSupabaseServer` é o chokepoint de todo read via RLS. Quando o token não
 * traz `supabase_uid` ou `role: "authenticated"`, o Postgres NÃO reclama: as
 * policies simplesmente não casam, e a aplicação renderiza com listas vazias.
 * Estes testes fixam a única barreira que transforma isso em erro visível.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let token: string | null = null;
const getTokenArgs: unknown[][] = [];

// A metadata do Clerk decide se um token sem claim é config quebrada (uid
// presente → cutover → lança) ou vínculo ainda pendente (uid ausente → deixa a
// página redirecionar). Default: uid presente, o estado em que a ausência do
// claim no token é o bug do cutover que a barreira existe para pegar.
let metadataUid: string | undefined = "11111111-1111-1111-1111-111111111111";
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({
    getToken: async (...args: unknown[]) => {
      getTokenArgs.push(args);
      return token;
    },
  }),
  currentUser: async () => ({ publicMetadata: { supabase_uid: metadataUid } }),
}));

const created: Array<{ headers: Record<string, string> }> = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts: { global: { headers: Record<string, string> } }) => {
    created.push({ headers: opts.global.headers });
    return { __fake: true };
  },
}));

const { createSupabaseServer } = await import("../server");

/** JWT sintético: só o payload importa — a assinatura nunca é verificada aqui
 * (quem verifica é o Supabase, contra o JWKS do Clerk). */
function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.assinatura-nao-verificada`;
}

const VALID = {
  sub: "user_2abc",
  iss: "https://clerk.test",
  role: "authenticated",
  supabase_uid: "11111111-1111-1111-1111-111111111111",
};

beforeEach(() => {
  created.length = 0;
  getTokenArgs.length = 0;
  token = null;
  metadataUid = "11111111-1111-1111-1111-111111111111";
});

describe("createSupabaseServer — contrato do session token", () => {
  it("aceita um session token completo e o repassa no Authorization", async () => {
    token = jwtWith(VALID);
    await createSupabaseServer();
    expect(created[0].headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("pede o session token, nunca um JWT template", async () => {
    // `getToken({ template: "supabase" })` voltaria a emitir um token com `aud`
    // e sem os claims default — o backend valida `iss` agora (#487), e o
    // template está deprecado pelo Supabase desde 01/04/2025.
    token = jwtWith(VALID);
    await createSupabaseServer();
    expect(getTokenArgs).toEqual([[]]);
  });

  it("lança quando falta supabase_uid E a metadata TEM o vínculo (cutover)", async () => {
    // O modo de falha de uma troca de instância: o custom claim não foi
    // replicado no Dashboard novo. Metadata com uid + token sem claim = config
    // quebrada, não vínculo pendente. Sem esta barreira, a RLS negaria tudo em
    // silêncio e o dashboard apareceria vazio, sem erro nenhum.
    token = jwtWith({ ...VALID, supabase_uid: undefined });
    await expect(createSupabaseServer()).rejects.toThrow(/supabase_uid/);
  });

  it("NÃO lança quando o vínculo ainda está pendente (link-pending)", async () => {
    // O bloqueador que esta lógica corrige: um usuário recém-criado, com sessão
    // Clerk mas sem `supabase_uid` na metadata, chegando por deep-link numa
    // página protegida. Do token puro é idêntico ao cutover, mas a metadata
    // ainda não tem o uid. Lançar aqui atropelaria o redirect gracioso da
    // conclusão de acesso — e como toda página faz
    // `Promise.all([requirePageAuthUser(), createSupabaseServer()])`, o crash
    // venceria o redirect. Aqui a barreira se cala e devolve o cliente.
    metadataUid = undefined;
    token = jwtWith({ ...VALID, supabase_uid: undefined });
    await expect(createSupabaseServer()).resolves.toBeDefined();
  });

  it("NÃO lança quando falta role mas a metadata não tem vínculo", async () => {
    // Simetria do anterior no ramo do `role`: sem uid na metadata, a conta ainda
    // está em reparo e a página redireciona; a barreira não atropela.
    metadataUid = undefined;
    token = jwtWith({ ...VALID, role: undefined });
    await expect(createSupabaseServer()).resolves.toBeDefined();
  });

  it('lança quando role !== "authenticated" (PostgREST trataria como anon)', async () => {
    token = jwtWith({ ...VALID, role: undefined });
    await expect(createSupabaseServer()).rejects.toThrow(/role/);
  });

  it("nomeia as duas claims quando as duas faltam", async () => {
    token = jwtWith({ sub: "user_2abc", iss: "https://clerk.test" });
    await expect(createSupabaseServer()).rejects.toThrow(
      /supabase_uid e role/,
    );
  });

  it("não lança quando não há token: deslogado é anon, não config quebrada", async () => {
    // Distinção que importa: sem sessão, o cliente sai sem Authorization e a RLS
    // nega — comportamento correto e esperado. Lançar aqui quebraria toda página
    // pública/de login.
    token = null;
    await expect(createSupabaseServer()).resolves.toBeDefined();
    expect(created[0].headers).toEqual({});
  });

  it("token indecifrável cai no mesmo erro (sem claim é sem claim)", async () => {
    // Não deveria acontecer — o Clerk sempre devolve um JWT. Fixado só para
    // garantir que o payload malformado vira erro nomeado, e não um SyntaxError
    // cru vazando de JSON.parse.
    token = "isto-nao-e-um-jwt";
    await expect(createSupabaseServer()).rejects.toThrow(/supabase_uid/);
  });

  it("payload JSON válido mas não-objeto também vira erro nomeado", async () => {
    // O buraco que o `try/catch` sozinho não fecha: `JSON.parse("null")` não
    // lança, devolve `null`, e a destructuring das claims estouraria com um
    // TypeError cru — o oposto do erro acionável que esta barreira existe para
    // produzir.
    token = jwtWith(null as unknown as Record<string, unknown>);
    await expect(createSupabaseServer()).rejects.toThrow(/supabase_uid e role/);
  });
});
