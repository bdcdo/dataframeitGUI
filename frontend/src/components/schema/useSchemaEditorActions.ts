"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  saveSchemaFromGUI,
  publishMajorVersion,
  backfillSchemaVersionHistory,
  recoverFieldsFromStoredCode,
} from "@/actions/schema";
import { validateGUIFields } from "@/lib/schema-utils";
import type {
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSnapshot,
} from "@/lib/types";
import type { SchemaDraftConflict } from "@/hooks/useSchemaDraft";

/**
 * As quatro ações de servidor do SchemaEditor — salvar, publicar MAJOR,
 * reconstruir histórico, recuperar campos legados. Extraídas do corpo do
 * componente (que passava de 300 linhas) para um hook co-localizado, no mesmo
 * espírito de `useSchemaDraft`/`useSchemaEditorDialogs`. A lógica é idêntica: o
 * hook só recebe do componente o estado do rascunho e os setters de diálogo de
 * que cada ação precisa, e devolve os handlers já embrulhados no `startTransition`.
 *
 * `isPending` sai daqui porque é o `useTransition` que envolve as quatro ações;
 * o rodapé e os botões o consomem para desabilitar durante a escrita.
 */
export interface SchemaEditorActionsDeps {
  projectId: string;
  initialCode: string | null;
  initialFields: PydanticField[];
  fields: PydanticField[];
  isDirty: boolean;
  conflict: SchemaDraftConflict | null;
  baseline: SchemaBaselineIdentity;
  setFields: (fields: PydanticField[]) => void;
  markSaved: (snapshot: SchemaSnapshot) => void;
  registerRemoteConflict: (current: SchemaSnapshot) => void;
  prepareSubmission: () => {
    fields: PydanticField[];
    expectedBaseline: SchemaBaselineIdentity;
  };
  setValidationAttempted: (attempted: boolean) => void;
  setMajorDialogOpen: (open: boolean) => void;
  setBackfillDialogOpen: (open: boolean) => void;
}

export function useSchemaEditorActions({
  projectId,
  initialCode,
  initialFields,
  fields,
  isDirty,
  conflict,
  baseline,
  setFields,
  markSaved,
  registerRemoteConflict,
  prepareSubmission,
  setValidationAttempted,
  setMajorDialogOpen,
  setBackfillDialogOpen,
}: SchemaEditorActionsDeps) {
  const { refresh } = useRouter();
  const [isPending, startTransition] = useTransition();

  const handlePublishMajor = () => {
    if (isDirty || conflict) {
      toast.warning("Resolva e salve as alterações pendentes antes de publicar uma versão MAJOR.");
      return;
    }
    startTransition(async () => {
      try {
        const r = await publishMajorVersion(projectId, baseline);
        if (r.status === "error") {
          toast.error(r.message);
          return;
        }
        if (r.status === "conflict") {
          registerRemoteConflict(r.current);
          toast.error("O schema mudou em outra sessão. Revise o conflito antes de publicar.");
          return;
        }
        markSaved(r.snapshot);
        toast.success(`Nova versão MAJOR publicada: ${r.snapshot.version}`);
        setMajorDialogOpen(false);
        refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Erro ao publicar MAJOR";
        toast.error(msg);
      }
    });
  };

  const handleBackfill = () => {
    if (isDirty || conflict) {
      toast.warning("Resolva e salve as alterações pendentes antes de reconstruir o histórico.");
      return;
    }
    startTransition(async () => {
      try {
        const r = await backfillSchemaVersionHistory(projectId, baseline);
        if (r.status === "error") {
          toast.error(r.message);
          return;
        }
        if (r.status === "conflict") {
          registerRemoteConflict(r.current);
          toast.error("O schema mudou em outra sessão. Revise o conflito antes de reconstruir.");
          return;
        }
        const v = r.stats.finalVersion;
        const m = r.stats.byMethod;
        toast.success(
          `v${v.major}.${v.minor}.${v.patch} · ${r.stats.logEntriesUpdated} entradas, ${r.stats.responsesProcessed} respostas — hashes: ${m.hashes}, created_at: ${m.created_at}, fallback: ${m.fallback_created_at}, live_save: ${m.live_save}`,
          { duration: 10000 },
        );
        markSaved(r.snapshot);
        setBackfillDialogOpen(false);
        refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Erro ao reconstruir";
        toast.error(msg);
      }
    });
  };

  // Quando o projeto tem pydantic_code mas nenhum campo carregado, o editor
  // abriria vazio e um "Salvar" apagaria o schema (barrado pela guarda em
  // saveSchemaFromGUI). Recuperar reconstrói os campos a partir do código.
  const canRecover =
    initialFields.length === 0 && !!initialCode && fields.length === 0;

  const handleRecover = () => {
    startTransition(async () => {
      const r = await recoverFieldsFromStoredCode(projectId);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      setFields(r.fields || []);
      toast.success(`${r.fields?.length ?? 0} campos recuperados do código`);
    });
  };

  const handleSave = () => {
    if (conflict) {
      toast.warning("Aplique ou descarte o rascunho conflitante antes de salvar.");
      return;
    }
    startTransition(async () => {
      try {
        const submission = prepareSubmission();
        setValidationAttempted(true);
        const errs = validateGUIFields(submission.fields);
        if (errs.length > 0) return;
        setValidationAttempted(false);
        const r = await saveSchemaFromGUI(
          projectId,
          submission.fields,
          submission.expectedBaseline,
        );
        if (r.status === "error") {
          toast.error(r.message);
          return;
        }
        if (r.status === "conflict") {
          registerRemoteConflict(r.current);
          toast.warning("O schema mudou em outra sessão. Revise as diferenças para continuar.");
          return;
        }
        markSaved(r.snapshot);
        toast.success("Schema salvo!");
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Erro ao salvar schema");
      }
    });
  };

  return {
    isPending,
    canRecover,
    handlePublishMajor,
    handleBackfill,
    handleRecover,
    handleSave,
  };
}
