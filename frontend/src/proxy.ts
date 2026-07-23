import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Cutover de dominio (#194): redirect 308 (preserva metodo + corpo) do dominio
// legado para o canonico, preservando path + query. O middleware dispara pelo
// header Host da requisicao, independente de onde o app roda (licao do #341) —
// so pode estar em producao com o DNS de CANONICAL_HOST no ar e LEGACY_HOST ja
// servido por este app.
const LEGACY_HOST = "ac.brunodcdo.com.br";
const CANONICAL_HOST = "dataframeit.com.br";

const isPublicRoute = createRouteMatcher([
  "/auth/(.*)",
  "/api/webhooks(.*)",
  "/api/internal/auto-review/reconcile",
  "/api/health",
]);

export default clerkMiddleware(async (auth, request) => {
  if (request.headers.get("host") === LEGACY_HOST) {
    return NextResponse.redirect(
      `https://${CANONICAL_HOST}${request.nextUrl.pathname}${request.nextUrl.search}`,
      308,
    );
  }
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  // Expõe o pathname atual aos Server Components (layouts) via header de
  // requisição, para a conclusão de acesso preservar o deep-link em `?next` e
  // devolver o usuário ao destino pretendido após reparar o vínculo. Aditivo:
  // não altera o redirect do cutover nem o auth.protect() acima.
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
