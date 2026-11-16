/** Session token sintético: só o payload importa. A assinatura nunca é
 * verificada no frontend — quem verifica é o Supabase e o FastAPI, contra o
 * JWKS do Clerk. */
export function sessionTokenWith(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.assinatura-nao-verificada`;
}

export const LINKED_CLAIMS = {
  sub: "user_2abc",
  iss: "https://clerk.test",
  role: "authenticated",
  supabase_uid: "11111111-1111-1111-1111-111111111111",
};

/** Sessão válida de quem ainda não tem o vínculo: os claims default do Clerk,
 * sem `supabase_uid` (o custom claim sai vazio enquanto a metadata não existe). */
export const UNLINKED_CLAIMS = {
  sub: "user_2abc",
  iss: "https://clerk.test",
  role: "authenticated",
};
