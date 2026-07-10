"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { completeAccess } from "@/actions/complete-access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

// Cópia por motivo (contracts/access-completion "User-visible states"), em
// pt-BR e sem termo técnico, token, claim ou nome de tabela (FR-010). O motivo
// vem da resolução read-only (link-pending/divergent, sync-temporary-failure) e
// pode evoluir para unknown-recoverable após um retry que não resolveu.
export type CompletionReason =
  | "link-pending"
  | "link-divergent"
  | "sync-temporary-failure"
  | "unknown-recoverable";

const REASON_COPY: Record<
  CompletionReason,
  { title: string; description: string; action: string; supportHint?: string }
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
};

export function AccessCompletionCard({
  reason,
  actorEmail,
  nextUrl,
}: {
  reason: CompletionReason;
  actorEmail: string;
  nextUrl: string;
}) {
  const router = useRouter();
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
        // Vínculo confirmado: segue para o destino pretendido ou dashboard.
        router.replace(nextUrl);
        router.refresh();
        return;
      }
      // Retry não resolveu: atualiza a mensagem para o motivo devolvido, sem
      // enviar o usuário de volta ao login como se estivesse sem sessão.
      setCurrentReason(
        result.reason === "sync-temporary-failure"
          ? "sync-temporary-failure"
          : "unknown-recoverable",
      );
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
          <p className="text-sm text-muted-foreground">
            Conta conectada: <span className="font-medium">{actorEmail}</span>
          </p>
          {copy.supportHint ? (
            <p className="text-sm text-muted-foreground">{copy.supportHint}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleRetry}
              disabled={isPending}
              aria-busy={isPending}
            >
              {isPending ? "Concluindo acesso…" : copy.action}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
