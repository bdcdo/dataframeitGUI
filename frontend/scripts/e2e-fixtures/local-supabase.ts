// Host do Supabase local: o único em que as fixtures que escrevem de propósito
// podem nascer. Uma regra só para o gerador de llm-decisions
// (`fixtureClient({ localOnly: true })`) e para o spec que a consome
// (`e2e/llm-decisions.smoke.spec.ts`). Os geradores de coding e compare não a
// aplicam: rodam também contra o banco E2E que o `.env.e2e` apontar.
export const LOCAL_SUPABASE_HOST = /^(localhost|127\.0\.0\.1)$/;
