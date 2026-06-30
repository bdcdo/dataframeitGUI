"use client";

import { useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  saveSchemaFromGUI,
  publishMajorVersion,
  backfillSchemaVersionHistory,
  recoverFieldsFromStoredCode,
} from "@/actions/schema";
import { validateGUIFields, generatePydanticCode } from "@/lib/schema-utils";
import { toast } from "sonner";
import { LayoutGrid, Code, Rocket, Info, X, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { SchemaBuilderGUI } from "./SchemaBuilderGUI";
import { ValidationErrorPanel } from "./ValidationErrorPanel";
import type { PydanticField } from "@/lib/types";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false }
);

const VERSIONING_HELP_KEY = "schema-versioning-help-dismissed";

interface SchemaEditorProps {
  projectId: string;
  initialCode: string | null;
  initialFields: PydanticField[] | null;
  currentVersion: string;
}

// Agrupa as flags de UI (dialogs de MAJOR/backfill e o banner de ajuda de
// versionamento) num hook co-localizado. Pura relocação de estado para manter
// o componente abaixo do limiar de useState do react-doctor — sem mudança de
// comportamento. O lazy initializer de `helpDismissed` lê o localStorage uma
// única vez na montagem e é preservado exatamente.
function useSchemaEditorDialogs() {
  const [majorDialogOpen, setMajorDialogOpen] = useState(false);
  const [backfillDialogOpen, setBackfillDialogOpen] = useState(false);
  const [helpDismissed, setHelpDismissed] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(VERSIONING_HELP_KEY) === "1";
  });

  const dismissHelp = () => {
    setHelpDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VERSIONING_HELP_KEY, "1");
    }
  };

  return {
    majorDialogOpen,
    setMajorDialogOpen,
    backfillDialogOpen,
    setBackfillDialogOpen,
    helpDismissed,
    dismissHelp,
  };
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

  // --- Info para badges ---
  const fieldCount = fields.length;
  const llmOnlyCount = fields.filter((f) => f.target === "llm_only").length;

  return (
    <div className="flex h-[calc(100vh-148px)] flex-col">
      {/* Header: toggle de modo */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 text-xs gap-1.5",
                mode === "gui" && "bg-background shadow-sm"
              )}
              onClick={() => (mode === "code" ? switchToGUI() : undefined)}
            >
              <LayoutGrid className="size-3.5" />
              Visual
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 text-xs gap-1.5",
                mode === "code" && "bg-background shadow-sm"
              )}
              onClick={() => (mode === "gui" ? switchToCode() : undefined)}
            >
              <Code className="size-3.5" />
              Código
            </Button>
          </div>
          <Badge
            variant="outline"
            className="h-6 px-2 font-mono text-xs"
            title="Versão atual do schema"
          >
            v{currentVersion}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {fieldCount > 0 && (
            <Badge className="bg-green-500/10 text-green-700 text-xs">
              {fieldCount} {fieldCount === 1 ? "campo" : "campos"}
            </Badge>
          )}
          {llmOnlyCount > 0 && (
            <Badge className="bg-blue-500/10 text-blue-700 text-xs">
              {llmOnlyCount} LLM-only
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-muted-foreground"
            onClick={() => setBackfillDialogOpen(true)}
            disabled={isPending}
            title="Reconstruir versão a partir do histórico de mudanças"
          >
            <History className="size-3.5" />
            Reconstruir histórico
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setMajorDialogOpen(true)}
            disabled={isPending}
            title="Consolidar baseline e bumpar MAJOR"
          >
            <Rocket className="size-3.5" />
            Publicar MAJOR
          </Button>
        </div>
      </div>

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
            onClick={dismissHelp}
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
            onClick={handleRecover}
            disabled={isPending}
          >
            Recuperar do código
          </Button>
        </div>
      )}

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

      <AlertDialog open={backfillDialogOpen} onOpenChange={setBackfillDialogOpen}>
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
            <AlertDialogAction onClick={handleBackfill} disabled={isPending}>
              Reconstruir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={majorDialogOpen} onOpenChange={setMajorDialogOpen}>
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
            <AlertDialogAction onClick={handlePublishMajor} disabled={isPending}>
              Publicar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
