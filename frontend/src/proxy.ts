import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Cutover de dominio (#194): o dominio antigo na Vercel passa a apontar para o
// frontend no Fly; aqui redirecionamos 308 (preserva metodo + corpo) para o
// dominio canonico, preservando path + query. Inerte ate o DNS de LEGACY_HOST
// apontar para o Fly, entao e seguro deployar cedo.
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
