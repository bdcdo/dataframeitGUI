"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  generatePydanticCode,
  validateGUIFields,
} from "@/lib/schema-utils";
import { toast } from "sonner";
import { Info } from "lucide-react";
import { SchemaBuilderGUI } from "./SchemaBuilderGUI";
import { ValidationErrorPanel } from "./ValidationErrorPanel";
import { SchemaEditorHeader } from "./SchemaEditorHeader";
import { SchemaEditorBanners } from "./SchemaEditorBanners";
import { SchemaEditorDialogs } from "./SchemaEditorDialogs";
import { SchemaEditorFooter } from "./SchemaEditorFooter";
import { useSchemaEditorDialogs } from "./useSchemaEditorDialogs";
import { useSchemaEditorActions } from "./useSchemaEditorActions";
import {
  useSchemaDraft,
  type SchemaDraftConflict,
} from "@/hooks/useSchemaDraft";
import type { PydanticField } from "@/lib/types";
import { parsePydanticFields } from "@/lib/pydantic-field";
import { unresolvedSchemaConflicts } from "@/lib/schema-merge";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false }
);

interface SchemaEditorSessionProps {
  projectId: string;
  // Usuário autenticado no Clerk, não a identidade efetiva de `viewAsUser`: é
  // ele que a RPC grava como autor em `schema_change_log`, e o rascunho precisa
  // pertencer a quem vai assinar a mudança.
  userId: string;
  initialCode: string | null;
  initialFields: PydanticField[] | null;
  currentVersion: string;
  currentRevision: number;
}

interface SchemaEditorProps extends Omit<SchemaEditorSessionProps, "initialFields"> {
  initialFields: PydanticField[];
}

// Estado terminal: o schema gravado não corresponde ao contrato canônico. Não há
// ação na UI que resolva — `loadSchemaSaveContext` recusa salvar pelo mesmo
// motivo, porque precisa dos campos antigos para calcular o diff da auditoria —,
// então a tela informa em vez de oferecer uma saída que o servidor rejeitaria.
function SchemaEditorInvalidState() {
  return (
    <div className="flex h-[calc(100vh-148px)] items-center justify-center p-6">
      <div className="max-w-md space-y-2 text-center">
        <p className="text-sm font-medium">
          O schema gravado deste projeto está inválido.
        </p>
        <p className="text-xs text-muted-foreground">
          Ele precisa ser corrigido no banco antes que a edição seja liberada.
          Nenhuma alteração é possível enquanto isso — inclusive salvar, que
          depende de ler o schema atual para registrar o histórico.
        </p>
      </div>
    </div>
  );
}

// A identidade da sessão é o par projeto+usuário. Revisões novas entram no hook
// como snapshots remotos e passam pelo mesmo merge de três vias dos conflitos de
// save; já uma troca de usuário não tem merge possível — é outro rascunho.
export function SchemaEditorSession(props: SchemaEditorSessionProps) {
  // Lançar aqui derrubaria a rota inteira: este segmento não tem `error.tsx`, e
  // o usuário veria a tela genérica de erro do Next em vez de saber o que houve.
  // O servidor já trata a mesma condição devolvendo copy — a UI acompanha.
  const fields = parsePydanticFields(props.initialFields ?? []);
  if (!fields) return <SchemaEditorInvalidState />;

  return (
    <SchemaEditor
      key={`${props.userId}:${props.projectId}`}
      {...props}
      initialFields={fields}
    />
  );
}

function SchemaEditorLoadingState() {
  return (
    <div
      className="h-[calc(100vh-148px)] animate-pulse bg-muted/20"
      aria-label="Carregando editor de schema"
    />
  );
}

function generatedSchemaCode(
  mode: "gui" | "code",
  fields: PydanticField[],
  initialCode: string | null,
): string {
  if (mode !== "code") return "";
  if (fields.length > 0) return generatePydanticCode(fields);
  return initialCode ?? "";
}

// Os dois helpers abaixo têm um chamador só, mas não são supérfluos: `SchemaEditor`
// já é grande, e inliná-los empurra o ramo para dentro dele e estoura o gate de
// complexidade cognitiva do fallow. Mantê-los aqui é o que segura o custo fora do
// componente.
function currentValidationErrors(
  attempted: boolean,
  fields: PydanticField[],
): string[] {
  return attempted ? validateGUIFields(fields) : [];
}

function pendingConflictCount(conflict: SchemaDraftConflict | null): number | null {
  return conflict ? unresolvedSchemaConflicts(conflict.merge).length : null;
}

function SchemaEditor({
  projectId,
  userId,
  initialCode,
  initialFields,
  currentVersion,
  currentRevision,
}: SchemaEditorProps) {
  // O modo "código" é somente leitura: o schema é editado no modo visual e o
  // código Pydantic é a fonte de verdade gerada a partir dos campos. Por isso
  // o estado inicial é sempre "gui".
  const [mode, setMode] = useState<"gui" | "code">("gui");
  const {
    fields,
    setFields,
    isDirty,
    origin,
    savedVersion,
    baseline,
    conflict,
    storageAvailable,
    storageBlocked,
    staleDraftDiscarded,
    draftPersisted,
    prepareSubmission,
    markSaved,
    registerRemoteConflict,
    resolveConflict,
    applyResolvedDraft,
    discardConflictingDraft,
    isHydrated,
  } = useSchemaDraft({
    projectId,
    userId,
    initialFields,
    currentVersion,
    currentRevision,
  });
  // O código é uma visualização DERIVADA dos campos, não estado próprio. Para um
  // projeto sem campos mas com código armazenado (legado), mostra o código
  // original até que os campos sejam recuperados (ver banner de recuperação).
  //
  // Só é computado no modo "código" (único lugar que o consome, no Monaco): em
  // modo visual cada edição muda `fields`, e regenerar o código a cada keystroke
  // seria trabalho desperdiçado já que o editor de código nem está montado.
  const code = generatedSchemaCode(mode, fields, initialCode);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const {
    majorDialogOpen,
    setMajorDialogOpen,
    backfillDialogOpen,
    setBackfillDialogOpen,
    helpDismissed,
    dismissHelp,
  } = useSchemaEditorDialogs();

  const {
    isPending,
    canRecover,
    handlePublishMajor,
    handleBackfill,
    handleRecover,
    handleSave,
  } = useSchemaEditorActions({
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
  });

  // Cada proveniência anuncia o que de fato aconteceu. Antes as duas caíam na
  // mesma mensagem, e um merge automático durante a sessão dizia "rascunho
  // recuperado" para quem nunca tinha fechado a aba.
  useEffect(() => {
    if (origin === "recovered") {
      toast.info(
        "Rascunho local recuperado. Revise e salve para confirmar as alterações.",
      );
    }
  }, [origin]);

  // O anúncio de rebase chaveia também na revisão: `origin` fica em "rebased"
  // após o primeiro merge automático, e um segundo rebase consecutivo trocava
  // os campos no canvas sem aviso (#501). A guarda anti-retrocesso do
  // useSchemaDraft garante que todo rebase avança `baseline.revision`, então a
  // revisão é o token de "aconteceu de novo".
  useEffect(() => {
    if (origin === "rebased") {
      toast.info(
        "O schema mudou em outra sessão. Suas alterações foram mescladas com a versão mais recente.",
      );
    }
  }, [origin, baseline.revision]);

  // --- Troca de modo ---
  // O modo "código" é só visualização da fonte de verdade. Alternar não
  // recompila nada: os campos já estão no estado e o código é gerado deles.

  const switchToCode = () => setMode("code");

  const switchToGUI = () => {
    setValidationAttempted(false);
    setMode("gui");
  };

  if (!isHydrated) {
    return <SchemaEditorLoadingState />;
  }

  const guiErrors = currentValidationErrors(validationAttempted, fields);
  // O rodapé e o diálogo precisam do mesmo número; recomputá-lo em cada um
  // deixaria os dois livres para discordar.
  const conflictCount = pendingConflictCount(conflict);

  return (
    <div className="flex h-[calc(100vh-148px)] flex-col">
      <SchemaEditorHeader
        mode={mode}
        onSwitchToGUI={switchToGUI}
        onSwitchToCode={switchToCode}
        currentVersion={savedVersion}
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
        storageBlocked={storageBlocked}
        staleDraftDiscarded={staleDraftDiscarded}
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
            onDismiss={() => setValidationAttempted(false)}
          />
        </div>
      )}

      <SchemaEditorFooter
        mode={mode}
        onSave={handleSave}
        saveDisabled={isPending || conflict !== null || !isDirty}
        isDirty={isDirty}
        conflictCount={conflictCount}
        storageAvailable={storageAvailable}
        storageBlocked={storageBlocked}
        draftPersisted={draftPersisted}
        origin={origin}
      />

      <SchemaEditorDialogs
        backfillOpen={backfillDialogOpen}
        onBackfillOpenChange={setBackfillDialogOpen}
        onConfirmBackfill={handleBackfill}
        majorOpen={majorDialogOpen}
        onMajorOpenChange={setMajorDialogOpen}
        onConfirmPublishMajor={handlePublishMajor}
        isPending={isPending}
        currentVersion={savedVersion}
        conflict={conflict}
        conflictCount={conflictCount}
        onResolveConflict={resolveConflict}
        onApplyResolvedDraft={applyResolvedDraft}
        onDiscardConflictingDraft={discardConflictingDraft}
      />
    </div>
  );
}
