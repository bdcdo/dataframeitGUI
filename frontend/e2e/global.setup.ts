import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

// clerkSetup() troca a secret key do Clerk por um Testing Token, que permite
// ao Playwright criar sessões sem passar pela UI hospedada do Clerk (o
// redirect para `*.accounts.dev` que travava o smoke test — ver issue #107).
// Requer CLERK_SECRET_KEY + NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY no ambiente.
setup("clerk testing token setup", async () => {
  await clerkSetup();
});
