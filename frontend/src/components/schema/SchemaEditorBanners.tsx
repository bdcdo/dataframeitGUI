"use client";

import { Button } from "@/components/ui/button";
import { Info, X } from "lucide-react";

interface SchemaEditorBannersProps {
  helpDismissed: boolean;
  onDismissHelp: () => void;
  canRecover: boolean;
  onRecover: () => void;
  isPending: boolean;
}

/**
 * Banners do editor de schema: ajuda de versionamento (dispensável, persiste
 * em localStorage via hook do pai) e recuperação de campos de projeto legado.
 */
export function SchemaEditorBanners({
  helpDismissed,
  onDismissHelp,
  canRecover,
  onRecover,
  isPending,
}: SchemaEditorBannersProps) {
  return (
    <>
      {!helpDismissed && (
        <div className="flex items-start gap-2 border-b bg-blue-500/5 px-4 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-blue-600" />
          <div className="flex-1">
            <strong className="text-foreground">Sobre versões do schema.</strong>{" "}
            Toda edição bumpa a versão automaticamente (MINOR para mudanças
            estruturais como adicionar/remover campo ou opção, PATCH para texto).
            Nenhuma edição apaga respostas: elas ficam rotuladas com a versão em
            que foram dadas. Quando você quiser consolidar o codebook como{" "}
            <strong className="text-foreground">baseline oficial</strong>, clique em{" "}
            <strong className="text-foreground">Publicar MAJOR</strong>. A partir daí,
            o filtro padrão da aba Comparar passa a ignorar respostas de versões
            anteriores.
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-5 shrink-0"
            onClick={onDismissHelp}
            title="Dispensar"
          >
            <X className="size-3" />
          </Button>
        </div>
      )}

      {canRecover && (
        <div className="flex items-start gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <div className="flex-1 text-muted-foreground">
            <strong className="text-foreground">Editor visual vazio.</strong>{" "}
            Este projeto tem código Pydantic armazenado, mas nenhum campo
            carregado no editor. Salvar agora apagaria o schema — recupere os
            campos a partir do código.
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={onRecover}
            disabled={isPending}
          >
            Recuperar do código
          </Button>
        </div>
      )}
    </>
  );
}
