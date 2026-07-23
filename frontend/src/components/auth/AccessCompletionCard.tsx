"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  completeAccess,
  type CompleteAccessResult,
} from "@/actions/complete-access";
import type { AuthResolution } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

// Cópia por motivo (contracts/access-completion "User-visible states"), em
// pt-BR e sem termo técnico, token, claim ou nome de tabela (FR-010). O motivo
// vem da resolução read-only (link-pending/divergent, sync-temporary-failure) e
// pode evoluir para unknown-recoverable após um retry que não resolveu.
//
// Derivado de quem produz o motivo, não relistado à mão: um estado novo em
// AuthResolution ou em CompleteAccessResult passa a quebrar o REASON_COPY
// abaixo em tempo de compilação, em vez de renderizar undefined em runtime.
export type CompletionReason =
  | Extract<AuthResolution, { reason: string }>["reason"]
  | Extract<CompleteAccessResult, { ok: false }>["reason"];

// `action` ausente = estado terminal, sem botão de retry.
const REASON_COPY: Record<
  CompletionReason,
  { title: string; description: string; action?: string; supportHint?: string }
> = {
  "link-pending": {
    title: "Estamos preparando seu acesso",
    description:
      "Sua conta entrou com sucesso, mas ainda estamos preparando o acesso aos dados protegidos. Isso costuma levar apenas alguns instantes.",
    action: "Tentar novamente",
  },
  "link-divergent": {
    title: "Precisamos confirmar sua conta",
    description:
      "Sua conta entrou, mas precisamos confirmar qual é o vínculo correto antes de liberar os dados protegidos.",
    action: "Tentar reparar acesso",
  },
  "sync-temporary-failure": {
    title: "Instabilidade temporária no acesso",
    description:
      "Houve uma instabilidade temporária ao confirmar seu acesso. Você pode tentar novamente em instantes.",
    action: "Tentar novamente",
  },
  "unknown-recoverable": {
    title: "Não foi possível concluir o acesso agora",
    description:
      "Não conseguimos concluir seu acesso nesta tentativa. Tente novamente; se continuar, fale com o coordenador do seu projeto.",
    action: "Tentar novamente",
    supportHint:
      "Se o problema persistir após algumas tentativas, procure o coordenador responsável pelo seu projeto.",
  },
  // Único motivo sem `action`: o conflito não muda por insistência, então
  // oferecer um botão aqui seria prometer uma saída que não existe.
  "identity-conflict": {
    title: "Seu e-mail já está em uso por outra conta",
    description:
      "O e-mail desta conta já pertence a um cadastro ativo na plataforma. Por segurança, não é possível concluir o acesso automaticamente.",
    supportHint:
      "Procure o coordenador responsável pelo seu projeto para unificar os cadastros.",
  },
};

export function AccessCompletionCard({
  reason,
  actorEmail,
  nextUrl,
}: {
  reason: CompletionReason;
  actorEmail?: string;
  nextUrl: string;
}) {
  const router = useRouter();
  const { getToken } = useAuth();
  const [currentReason, setCurrentReason] = useState<CompletionReason>(reason);
  const [isPending, startTransition] = useTransition();
  const copy = REASON_COPY[currentReason];

  // Move o foco para o título ao montar e sempre que o motivo muda (ex.: após um
  // retry que não resolveu). Um `<h1>` com `tabIndex={-1}` recebe foco
  // programático sem entrar na ordem de tabulação; o ref + effect é mais
  // confiável que `autoFocus` em elemento não-form entre SSR e hidratação, e
  // garante que leitores de tela anunciem o novo estado (WCAG 2.1 AA).
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, [currentReason]);

  function handleRetry() {
    startTransition(async () => {
      const result = await completeAccess();
      if (result.ok) {
        // A action atualiza a metadata no backend do Clerk e o vínculo JÁ está
        // gravado neste ponto. O token em cache, porém, foi emitido ANTES disso,
        // e é dele que sai o claim `supabase_uid` — daí o `skipCache`, que a
        // própria doc do Clerk indica para claims que "depend on data that can
        // be updated (e.g. user fields)". Sem `template`: o JWT template saiu no
        // #348 e o que se renova aqui é o session token.
        //
        // Best-effort, não um portão: a página de destino é renderizada no
        // servidor e minta o próprio token por request (lib/supabase/server.ts),
        // então quem depende deste cache é só o cliente ao chamar o FastAPI
        // (lib/api.ts). Bloquear a navegação por um blip aqui anunciaria falha
        // sobre um acesso que já foi concluído.
        try {
          await getToken({ skipCache: true });
        } catch (error) {
          console.error(
            "AccessCompletionCard: falha ao renovar token após concluir acesso",
            { error },
          );
        }

        // Vínculo confirmado: segue para o destino pretendido ou dashboard.
        router.replace(nextUrl);
        router.refresh();
        return;
      }
      // Retry não resolveu: atualiza a mensagem para o motivo devolvido, sem
      // enviar o usuário de volta ao login como se estivesse sem sessão.
      setCurrentReason(result.reason);
    });
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          {/* Heading real (`<h1>`) para ser anunciado como cabeçalho por AT, com
              foco inicial gerenciado por ref (ver useEffect acima) — WCAG 2.1 AA
              / contracts/access-completion. `outline-none` evita anel de foco
              visível num alvo que a pessoa não navegou por Tab. */}
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="leading-none font-semibold outline-none"
          >
            {copy.title}
          </h1>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Região viva: quando o motivo muda após um retry (ex.: link-pending
              → unknown-recoverable), a descrição é reanunciada por AT sem depender
              do foco — complementa o re-foco no título. */}
          <p
            className="text-sm text-muted-foreground"
            aria-live="polite"
            aria-atomic="true"
          >
            {copy.description}
          </p>
          {actorEmail ? (
            <p className="text-sm text-muted-foreground">
              Conta conectada: <span className="font-medium">{actorEmail}</span>
            </p>
          ) : null}
          {copy.supportHint ? (
            <p className="text-sm text-muted-foreground">{copy.supportHint}</p>
          ) : null}
          {copy.action ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleRetry}
                disabled={isPending}
                aria-busy={isPending}
              >
                {isPending ? "Concluindo acesso…" : copy.action}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
