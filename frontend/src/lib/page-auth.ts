import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  getProjectAccessContext,
  resolveAuth,
  type AuthUser,
} from "@/lib/auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { completionRedirectPath } from "@/lib/safe-next-path";

/**
 * Exige uma identidade pronta em pages/layouts protegidos sem apagar os estados
 * recuperáveis. Diferente de `getAuthUser`, este helper controla navegação:
 * ausência real de sessão vai ao login; vínculo pendente, divergente ou falha
 * técnica vão à conclusão de acesso, preservando o deep-link atual.
 */
export async function requirePageAuthUser(): Promise<AuthUser> {
  const resolution = await resolveAuth();
  if (resolution.status === "signed-out") {
    redirect("/auth/login");
  }
  if (resolution.status !== "authenticated") {
    const pathname = (await headers()).get("x-pathname");
    redirect(completionRedirectPath(pathname));
  }
  return resolution.user;
}

export async function requireProjectPageAccess(
  params: Promise<{ id: string }>,
) {
  const [{ id }, user] = await Promise.all([params, requirePageAuthUser()]);
  const access = requireResolvedProjectAccess(
    await getProjectAccessContext(id, user),
  );
  return { id, user, access };
}
