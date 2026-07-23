"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface SubmitBarProps {
  outOfScopeBlocked: boolean;
  readOnly: boolean;
  submitting: boolean;
  /** Obrigatórias visíveis ainda em branco, pela régua de `isCodingComplete`. */
  missingRequiredCount: number;
  onClick: () => void;
}

interface SubmitBarState {
  label: string;
  /** Pendência do formulário: neutra, para o botão não convidar ao clique. */
  pending: boolean;
  spinner: boolean;
}

// Estado do botão em ordem de precedência: sinalização "fora do escopo" >
// somente leitura > salvando > pendências > normal.
function resolveSubmitBarState({
  outOfScopeBlocked,
  readOnly,
  submitting,
  missingRequiredCount,
}: Omit<SubmitBarProps, "onClick">): SubmitBarState {
  if (outOfScopeBlocked) {
    return { label: "Aguardando revisão do coordenador", pending: false, spinner: false };
  }
  if (readOnly) return { label: "Somente leitura", pending: false, spinner: false };
  if (submitting) return { label: "Salvando…", pending: false, spinner: true };
  if (missingRequiredCount > 0) {
    return {
      label:
        missingRequiredCount === 1
          ? "Falta 1 obrigatória"
          : `Faltam ${missingRequiredCount} obrigatórias`,
      pending: true,
      spinner: false,
    };
  }
  return { label: "Enviar respostas", pending: false, spinner: false };
}

/** Rodapé do painel de perguntas. A contagem de pendências sai da mesma régua
 *  que o servidor usa para concluir a codificação: antes de existir, o botão
 *  prometia "Enviar respostas" a quem ainda não podia enviar, e o pesquisador só
 *  descobria a pendência depois do clique (#519). O botão segue habilitado —
 *  quem clica recebe o destaque e o rolamento até o primeiro campo em branco. */
export function SubmitBar({ onClick, ...state }: SubmitBarProps) {
  const { label, pending, spinner } = resolveSubmitBarState(state);
  return (
    <div className="border-t px-4 py-3 shrink-0">
      <Button
        onClick={onClick}
        disabled={state.submitting || state.readOnly || state.outOfScopeBlocked}
        variant={pending ? "outline" : "default"}
        className={cn("w-full", !pending && "bg-brand hover:bg-brand/90 text-brand-foreground")}
      >
        {spinner && <Loader2 className="size-4 animate-spin" />}
        {label}
      </Button>
    </div>
  );
}
