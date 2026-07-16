"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { propertyLabel } from "@/lib/schema-change-format";
import type { SchemaDraftConflict } from "@/hooks/useSchemaDraft";
import type {
  SchemaMergeChoice,
  SchemaMergeConflict,
} from "@/lib/schema-merge";

interface SchemaEditorDialogsProps {
  backfillOpen: boolean;
  onBackfillOpenChange: (open: boolean) => void;
  onConfirmBackfill: () => void;
  majorOpen: boolean;
  onMajorOpenChange: (open: boolean) => void;
  onConfirmPublishMajor: () => void;
  isPending: boolean;
  currentVersion: string;
  conflict: SchemaDraftConflict | null;
  onResolveConflict: (id: string, choice: SchemaMergeChoice) => void;
  onApplyResolvedDraft: () => boolean;
  onDiscardConflictingDraft: () => void;
}

function conflictTitle(conflict: SchemaMergeConflict): string {
  if (conflict.kind === "property") {
    return `${conflict.fieldName}: ${conflict.property === "hash" ? "hash do campo" : propertyLabel(conflict.property)}`;
  }
  if (conflict.kind === "order") return "Ordem dos campos";
  const reason = {
    "add-add": "campo adicionado nas duas versões",
    "delete-edit": "campo removido localmente e editado remotamente",
    "edit-delete": "campo editado localmente e removido remotamente",
  }[conflict.reason];
  return `${conflict.fieldName}: ${reason}`;
}

function readableObject(value: object): string {
  const field = value as { name?: string; description?: string };
  if (!field.name) return JSON.stringify(value);
  return field.description ? `${field.name} — ${field.description}` : field.name;
}

function readableArray(value: unknown[]): string {
  if (value.length === 0) return "Lista vazia";
  return value
    .map((item) => (typeof item === "object" && item !== null ? readableObject(item) : String(item)))
    .join(", ");
}

function readableValue(value: unknown): string {
  if (value === undefined) return "Ausente";
  if (value === null) return "Removido / nenhum valor";
  if (Array.isArray(value)) return readableArray(value);
  if (typeof value === "object") return readableObject(value);
  if (typeof value === "string" && value.length === 0) return "Texto vazio";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  return String(value);
}

function conflictChoiceValue(
  conflict: SchemaMergeConflict,
  choice: SchemaMergeChoice,
): unknown {
  if (conflict.kind === "property") {
    return choice === "local" ? conflict.localValue : conflict.remoteValue;
  }
  if (conflict.kind === "field") {
    return choice === "local" ? conflict.localField : conflict.remoteField;
  }
  return choice === "local" ? conflict.localOrder : conflict.remoteOrder;
}

/** Dialogs de confirmação do editor de schema: backfill de histórico e MAJOR. */
export function SchemaEditorDialogs({
  backfillOpen,
  onBackfillOpenChange,
  onConfirmBackfill,
  majorOpen,
  onMajorOpenChange,
  onConfirmPublishMajor,
  isPending,
  currentVersion,
  conflict,
  onResolveConflict,
  onApplyResolvedDraft,
  onDiscardConflictingDraft,
}: SchemaEditorDialogsProps) {
  return (
    <>
      <AlertDialog open={backfillOpen} onOpenChange={onBackfillOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reconstruir versão pelo histórico?</AlertDialogTitle>
            <AlertDialogDescription>
              Percorre o histórico de mudanças em ordem cronológica, classifica cada
              entrada (MINOR em mudanças estruturais; PATCH em texto; MAJOR preservado)
              e reconstrói o schema em cada versão. Para atribuir versão a cada resposta,
              tenta match por <strong>answer_field_hashes</strong> (hashes gravados a cada
              save); se não bater, cai em <strong>created_at</strong>. Respostas salvas
              diretamente na plataforma (live_save) preservam a versão original.
              Idempotente: pode rodar de novo sem problemas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmBackfill} disabled={isPending}>
              Reconstruir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={majorOpen} onOpenChange={onMajorOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publicar nova versão MAJOR?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso bumpa a versão do projeto de <strong>{currentVersion}</strong> para uma nova MAJOR
              (próximo inteiro). Use quando o codebook estiver estável e você quiser declarar uma
              baseline oficial. A partir daí, o filtro padrão da aba Comparar ignorará respostas
              de versões anteriores. Respostas antigas continuam salvas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmPublishMajor} disabled={isPending}>
              Publicar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={conflict !== null}>
        <DialogContent
          className="max-h-[85vh] overflow-hidden sm:max-w-2xl"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Resolver alterações concorrentes</DialogTitle>
            <DialogDescription>
              As edições independentes já foram combinadas. Para cada colisão,
              escolha sua alteração ou o valor que já está salvo. Nada será
              enviado ao servidor até você confirmar o merge e clicar em Salvar.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 overflow-y-auto pr-1">
            {conflict?.merge.conflicts.map((item) => (
              <fieldset key={item.id} className="rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">
                  {conflictTitle(item)}
                </legend>
                <RadioGroup
                  value={item.resolution ?? ""}
                  onValueChange={(value) =>
                    onResolveConflict(item.id, value as SchemaMergeChoice)
                  }
                  aria-label={`Escolha para ${conflictTitle(item)}`}
                  className="mt-2 grid gap-2 sm:grid-cols-2"
                >
                  {(["local", "remote"] as const).map((choice) => {
                    const id = `${item.id}-${choice}`;
                    return (
                      <label
                        key={choice}
                        htmlFor={id}
                        className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm has-[[data-state=checked]]:border-brand has-[[data-state=checked]]:bg-brand/5"
                      >
                        <RadioGroupItem id={id} value={choice} className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="block font-medium">
                            {choice === "local" ? "Minha alteração" : "Alteração salva"}
                          </span>
                          <span className="mt-1 block break-words text-xs text-muted-foreground">
                            {readableValue(conflictChoiceValue(item, choice))}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </RadioGroup>
              </fieldset>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onDiscardConflictingDraft}>
              Descartar meu rascunho
            </Button>
            <Button
              onClick={onApplyResolvedDraft}
              disabled={(conflict?.merge.unresolvedConflictIds.length ?? 1) > 0}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              Aplicar merge para revisar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
