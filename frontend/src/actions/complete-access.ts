"use server";

import { auth } from "@clerk/nextjs/server";
import {
  ClerkIdentityConflictError,
  reconcileClerkUserAccess,
} from "@/lib/clerk-sync";

// Resultado da conclusão de acesso. `type` é apagado na compilação, então não
// vira export síncrono proibido em arquivo "use server" (lição do #412).
//
// `identity-conflict` é o único motivo terminal: os demais convidam a retry,
// este convida a procurar o coordenador. Sem a distinção, um conflito
// estrutural — que por definição não muda com insistência — era servido como
// "Tentar novamente" e prendia o usuário num loop sem saída.
export type CompleteAccessResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "sync-temporary-failure"
        | "unknown-recoverable"
        | "identity-conflict";
    };

/**
 * Conclui/repara o vínculo Clerk↔Supabase de forma idempotente e explícita —
 * o reparo que a decisão D3 tirou do render path protegido. Chamada pelo botão
 * "Tentar novamente" da tela de conclusão de acesso; segura para retry:
 * `reconcileClerkUserAccess` não duplica profiles, mappings, vínculos nem
 * memberships e relê aliases resolvidos por tentativas anteriores (SC-007).
 */
export async function completeAccess(): Promise<CompleteAccessResult> {
  let clerkUserId: string | null = null;
  try {
    clerkUserId = (await auth()).userId;
    if (!clerkUserId) {
      return { ok: false, reason: "sync-temporary-failure" };
    }

    const supabaseUserId = await reconcileClerkUserAccess(clerkUserId);
    if (!supabaseUserId) {
      return { ok: false, reason: "sync-temporary-failure" };
    }
    return { ok: true };
  } catch (error) {
    // Não expor detalhe técnico ao usuário (FR-010): logamos para suporte e
    // devolvemos um motivo recuperável genérico.
    console.error("completeAccess: falha ao concluir vínculo", {
      clerkUserId,
      error,
    });
    // Conflito estrutural não melhora com insistência — mesma leitura que
    // addMember já aplica ao mesmo erro. Devolvê-lo como recuperável ofereceria
    // um botão que nunca conclui.
    if (error instanceof ClerkIdentityConflictError) {
      return { ok: false, reason: "identity-conflict" };
    }
    return { ok: false, reason: "unknown-recoverable" };
  }
}
