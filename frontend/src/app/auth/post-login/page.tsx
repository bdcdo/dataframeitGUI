import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveAuth } from "@/lib/auth";
import { safeNextPath } from "@/lib/safe-next-path";
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

  // Sanitiza o destino contra open-redirect (inclui protocol-relative
  // "//evil.com"); só um caminho interno passa. O card recebe o valor já
  // saneado, então o router.replace do cliente herda a sanitização.
  const nextUrl = safeNextPath(params.next);

  if (resolution.status === "signed-out") {
    redirect("/auth/login");
  }

  if (resolution.status === "authenticated") {
    // Vínculo já ativo: nada a concluir, segue para o destino pretendido.
    redirect(nextUrl);
  }

  return (
    <AccessCompletionCard
      reason={resolution.reason}
      actorEmail={resolution.actorEmail}
      nextUrl={nextUrl}
    />
  );
}
