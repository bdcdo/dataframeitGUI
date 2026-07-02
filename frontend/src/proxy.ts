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
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
