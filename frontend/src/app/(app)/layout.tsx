import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveAuth } from "@/lib/auth";
import { completionRedirectPath } from "@/lib/safe-next-path";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fail-closed via a resolução única read-only (FR-008): sessão ausente vai ao
  // login; sessão válida com vínculo pendente/divergente ou falha técnica vai à
  // conclusão de acesso — nunca de volta ao login como se estivesse sem sessão,
  // nem tratada como acesso liberado. `resolveAuth` é cache()d, então esta
  // chamada e as dos layouts/pages filhos resolvem a identidade uma vez por
  // request (RC-001).
  const resolution = await resolveAuth();

  if (resolution.status === "signed-out") {
    redirect("/auth/login");
  }
  if (resolution.status !== "authenticated") {
    // Preserva o deep-link pretendido para voltar a ele após concluir o acesso.
    const pathname = (await headers()).get("x-pathname");
    redirect(completionRedirectPath(pathname));
  }

  return <>{children}</>;
}
