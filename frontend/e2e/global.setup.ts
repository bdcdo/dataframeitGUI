import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

// clerkSetup() troca a secret key do Clerk por um Testing Token, que permite
// ao Playwright criar sessões sem passar pela UI hospedada do Clerk (o
// redirect para `*.accounts.dev` que travava o smoke test — ver issue #107).
// Requer CLERK_SECRET_KEY + NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY no ambiente.
setup("clerk testing token setup", async () => {
  // No modo manual, sem chaves Clerk, pula o setup em vez de lançar — os specs
  // autenticados também pulam quando faltam usuários/projetos de teste. No
  // pre-push, playwright.config.ts já falha fechado antes daqui se as envs
  // obrigatórias não estiverem configuradas.
  setup.skip(
    !process.env.CLERK_SECRET_KEY ||
      !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    "CLERK_SECRET_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ausentes",
  );
  await clerkSetup();
});
