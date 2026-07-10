import type { Metadata } from "next";
import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolveAuth } from "@/lib/auth";
import { AccessCompletionCard } from "@/components/auth/AccessCompletionCard";

export const metadata: Metadata = {
  title: "Concluindo acesso · GUI Análise Sistemática",
  description: "Conferindo o vínculo da sua conta após o login",
};

// Rota canônica de conclusão/reparo de acesso (afterSignInUrl do Clerk e destino
// do fail-closed dos layouts protegidos). Read-only: apenas resolve o estado e
// delega o reparo idempotente ao botão de retry — nenhuma mutação de vínculo
// acontece aqui no render (decisão D3).
export default async function PostLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const [resolution, params] = await Promise.all([resolveAuth(), searchParams]);

  // Só aceita destino interno (começa com "/") — impede open-redirect via ?next.
  const nextUrl =
    params.next && params.next.startsWith("/") ? params.next : "/dashboard";

  if (resolution.status === "signed-out") {
    redirect("/auth/login");
  }

  if (resolution.status === "authenticated") {
    // Vínculo já ativo: nada a concluir, segue para o destino pretendido.
    redirect(nextUrl);
  }

  // access-completion-required | technical-sync-failure: mostra o estado
  // recuperável. O e-mail do ator é lido só para reconhecimento da conta
  // (currentUser é memoizado por request pelo Clerk).
  const user = await currentUser();
  const actorEmail = user?.emailAddresses[0]?.emailAddress ?? "";

  return (
    <AccessCompletionCard
      reason={resolution.reason}
      actorEmail={actorEmail}
      nextUrl={nextUrl}
    />
  );
}
