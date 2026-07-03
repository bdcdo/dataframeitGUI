"use client";

import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface SubmitBarProps {
  outOfScopeBlocked: boolean;
  readOnly: boolean;
  submitting: boolean;
  onClick: () => void;
}

/** Rodapé do painel de perguntas: botão de envio, com texto/estado derivados
 *  de sinalização "fora do escopo" > somente leitura > salvando > normal. */
export function SubmitBar({ outOfScopeBlocked, readOnly, submitting, onClick }: SubmitBarProps) {
  return (
    <div className="border-t px-4 py-3 shrink-0">
      <Button
        onClick={onClick}
        disabled={submitting || readOnly || outOfScopeBlocked}
        className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
      >
        {outOfScopeBlocked ? (
          "Aguardando revisão do coordenador"
        ) : readOnly ? (
          "Somente leitura"
        ) : submitting ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Salvando…
          </>
        ) : (
          "Enviar respostas"
        )}
      </Button>
    </div>
  );
}
