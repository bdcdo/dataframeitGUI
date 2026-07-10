"use server";

import { currentUser } from "@clerk/nextjs/server";
import {
  activateProfileIfPending,
  syncClerkUserToSupabase,
} from "@/lib/clerk-sync";

// Resultado da conclusão de acesso. `type` é apagado na compilação, então não
// vira export síncrono proibido em arquivo "use server" (lição do #412).
export type CompleteAccessResult =
  | { ok: true }
  | { ok: false; reason: "sync-temporary-failure" | "unknown-recoverable" };

/**
 * Conclui/repara o vínculo Clerk↔Supabase de forma idempotente e explícita —
 * o reparo que a decisão D3 tirou do render path protegido. Chamada pelo botão
 * "Tentar novamente" da tela de conclusão de acesso; segura para retry:
 * `syncClerkUserToSupabase` e `activateProfileIfPending` já não duplicam
 * `profiles` / `clerk_user_mapping` / memberships nem reativam um profile já
 * ativo (SC-007).
 */
export async function completeAccess(): Promise<CompleteAccessResult> {
  const user = await currentUser();
  // Sem sessão ou sem e-mail utilizável não há como concluir o vínculo — a
  // tela mostra estado recuperável (a página trata a ausência de sessão
  // redirecionando ao login).
  const email = user?.emailAddresses[0]?.emailAddress;
  if (!user || !email) {
    return { ok: false, reason: "sync-temporary-failure" };
  }

  try {
    const supabaseUid = await syncClerkUserToSupabase(
      user.id,
      email,
      user.firstName,
      user.lastName,
    );
    await activateProfileIfPending(supabaseUid);
    return { ok: true };
  } catch (error) {
    // Não expor detalhe técnico ao usuário (FR-010): logamos para suporte e
    // devolvemos um motivo recuperável genérico.
    console.error("completeAccess: falha ao concluir vínculo", {
      clerkUserId: user.id,
      error,
    });
    return { ok: false, reason: "unknown-recoverable" };
  }
}
