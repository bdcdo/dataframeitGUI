"use client";

import { useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  saveSchemaFromGUI,
  publishMajorVersion,
  backfillSchemaVersionHistory,
  recoverFieldsFromStoredCode,
} from "@/actions/schema";
import { validateGUIFields, generatePydanticCode } from "@/lib/schema-utils";
import { toast } from "sonner";
import { Info } from "lucide-react";
import { SchemaBuilderGUI } from "./SchemaBuilderGUI";
import { ValidationErrorPanel } from "./ValidationErrorPanel";
import { SchemaEditorHeader } from "./SchemaEditorHeader";
import { SchemaEditorBanners } from "./SchemaEditorBanners";
import { SchemaEditorDialogs } from "./SchemaEditorDialogs";
import { useSchemaEditorDialogs } from "./useSchemaEditorDialogs";
import type { PydanticField } from "@/lib/types";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false }
);

interface SchemaEditorProps {
  projectId: string;
  initialCode: string | null;
  initialFields: PydanticField[] | null;
  currentVersion: string;
}

export function SchemaEditor({
  projectId,
  initialCode,
  initialFields,
  currentVersion,
}: SchemaEditorProps) {
  const { refresh } = useRouter();

  // O modo "código" é somente leitura: o schema é editado no modo visual e o
  // código Pydantic é a fonte de verdade gerada a partir dos campos. Por isso
  // o estado inicial é sempre "gui".
  const [mode, setMode] = useState<"gui" | "code">("gui");
  const [fields, setFields] = useState<PydanticField[]>(initialFields || []);
  // O código é uma visualização DERIVADA dos campos, não estado próprio. Para um
  // projeto sem campos mas com código armazenado (legado), mostra o código
  // original até que os campos sejam recuperados (ver banner de recuperação).
  //
  // Só é computado no modo "código" (único lugar que o consome, no Monaco): em
  // modo visual cada edição muda `fields`, e regenerar o código a cada keystroke
  // seria trabalho desperdiçado já que o editor de código nem está montado.
  const code = useMemo(
    () =>
      mode !== "code"
        ? ""
        : fields.length > 0
          ? generatePydanticCode(fields)
          : initialCode || "",
    [mode, fields, initialCode],
  );
  const [guiErrors, setGuiErrors] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();
  const {
    majorDialogOpen,
    setMajorDialogOpen,
    backfillDialogOpen,
    setBackfillDialogOpen,
    helpDismissed,
    dismissHelp,
  } = useSchemaEditorDialogs();

  const handlePublishMajor = () => {
    startTransition(async () => {
      try {
        const r = await publishMajorVersion(projectId);
        if (r?.error) {
          toast.error(r.error);
          // Falha parcial: a MAJOR foi publicada (só o log falhou) — reflete.
          if (!r.bumped) return;
        } else if (r?.bumped) {
          const b = r.bumped;
          toast.success(`Nova versão MAJOR publicada: ${b.major}.${b.minor}.${b.patch}`);
        }
        setMajorDialogOpen(false);
        refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Erro ao publicar MAJOR";
        toast.error(msg);
      }
    });
  };

  const handleBackfill = () => {
    startTransition(async () => {
      try {
        const r = await backfillSchemaVersionHistory(projectId);
        if (r?.error || !r?.stats) {
          toast.error(r?.error ?? "Erro ao reconstruir");
          return;
        }
        const v = r.stats.finalVersion;
        const m = r.stats.byMethod;
        toast.success(
          `v${v.major}.${v.minor}.${v.patch} · ${r.stats.logEntriesUpdated} entradas, ${r.stats.responsesProcessed} respostas — hashes: ${m.hashes}, created_at: ${m.created_at}, fallback: ${m.fallback_created_at}, live_save: ${m.live_save}`,
          { duration: 10000 },
        );
        setBackfillDialogOpen(false);
        refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Erro ao reconstruir";
        toast.error(msg);
      }
    });
  };

  // --- Troca de modo ---
  // O modo "código" é só visualização da fonte de verdade. Alternar não
  // recompila nada: os campos já estão no estado e o código é gerado deles.

  const switchToCode = () => setMode("code");

  const switchToGUI = () => {
    setGuiErrors([]);
    setMode("gui");
  };

  // --- Recuperação de campos a partir do código armazenado (projeto legado) ---
  // Quando o projeto tem pydantic_code mas nenhum campo carregado, o editor
  // abriria vazio e um "Salvar" apagaria o schema (barrado pela guarda em
  // saveSchemaFromGUI). Recuperar reconstrói os campos a partir do código.
  const canRecover =
    !initialFields?.length && !!initialCode && fields.length === 0;

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

  // --- Salvar ---

  const handleSave = () => {
    startTransition(async () => {
      try {
        const errs = validateGUIFields(fields);
        if (errs.length > 0) {
          setGuiErrors(errs);
          return;
        }
        setGuiErrors([]);
        const r = await saveSchemaFromGUI(projectId, fields);
        if (r?.error) {
          toast.error(r.error);
          return;
        }
        toast.success("Schema salvo!");
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Erro ao salvar schema");
      }
    });
  };

  return (
    <div className="flex h-[calc(100vh-148px)] flex-col">
      <SchemaEditorHeader
        mode={mode}
        onSwitchToGUI={switchToGUI}
        onSwitchToCode={switchToCode}
        currentVersion={currentVersion}
        fieldCount={fields.length}
        llmOnlyCount={fields.filter((f) => f.target === "llm_only").length}
        isPending={isPending}
        onOpenBackfill={() => setBackfillDialogOpen(true)}
        onOpenMajor={() => setMajorDialogOpen(true)}
      />

      <SchemaEditorBanners
        helpDismissed={helpDismissed}
        onDismissHelp={dismissHelp}
        canRecover={canRecover}
        onRecover={handleRecover}
        isPending={isPending}
      />

      {/* Conteúdo */}
      <div className="flex-1 overflow-hidden">
        {mode === "gui" ? (
          <SchemaBuilderGUI fields={fields} onChange={setFields} />
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5 shrink-0" />
              Somente leitura — o código é gerado a partir do editor visual.
              Para editar o schema, use o modo Visual.
            </div>
            <div className="flex-1 overflow-hidden">
              <MonacoEditor
                height="100%"
                language="python"
                theme="vs-light"
                value={code}
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: false },
                  fontSize: 14,
                  wordWrap: "on",
                }}
              />
            </div>
          </div>
        )}
      </div>

      {mode === "gui" && guiErrors.length > 0 && (
        <div className="border-t px-4 py-3">
          <ValidationErrorPanel
            errors={guiErrors}
            onDismiss={() => setGuiErrors([])}
          />
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 border-t px-4 py-2">
        {mode === "gui" ? (
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isPending}
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
          >
            Salvar
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            Visualização somente leitura — para editar, use o modo Visual.
          </span>
        )}
      </div>

      <SchemaEditorDialogs
        backfillOpen={backfillDialogOpen}
        onBackfillOpenChange={setBackfillDialogOpen}
        onConfirmBackfill={handleBackfill}
        majorOpen={majorDialogOpen}
        onMajorOpenChange={setMajorDialogOpen}
        onConfirmPublishMajor={handlePublishMajor}
        isPending={isPending}
        currentVersion={currentVersion}
      />
    </div>
  );
}
