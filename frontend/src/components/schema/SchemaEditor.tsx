"use client";

import { useState, useTransition } from "react";
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
  validateSchema,
  saveSchema,
  saveSchemaFromGUI,
  publishMajorVersion,
  backfillSchemaVersionHistory,
} from "@/actions/schema";
import { validateGUIFields, generatePydanticCode } from "@/lib/schema-utils";
import { toast } from "sonner";
import { LayoutGrid, Code, Rocket, Info, X, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { SchemaBuilderGUI } from "./SchemaBuilderGUI";
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

export function SchemaEditor({
  projectId,
  initialCode,
  initialFields,
  currentVersion,
}: SchemaEditorProps) {
  const router = useRouter();
  const defaultMode =
    !initialFields?.length && initialCode ? "code" : "gui";

  const [mode, setMode] = useState<"gui" | "code">(defaultMode);
  const [fields, setFields] = useState<PydanticField[]>(initialFields || []);
  const [code, setCode] = useState(initialCode || "");
  const [codeFields, setCodeFields] = useState<PydanticField[]>(
    initialFields || []
  );
  const [validationStatus, setValidationStatus] = useState<
    "idle" | "valid" | "error"
  >("idle");
  const [errors, setErrors] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();
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

  const handlePublishMajor = () => {
    startTransition(async () => {
      try {
        const bumped = await publishMajorVersion(projectId);
        toast.success(`Nova versão MAJOR publicada: ${bumped.major}.${bumped.minor}.${bumped.patch}`);
        setMajorDialogOpen(false);
        router.refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Erro ao publicar MAJOR";
        toast.error(msg);
      }
    });
  };

  const handleBackfill = () => {
    startTransition(async () => {
      try {
        const result = await backfillSchemaVersionHistory(projectId);
        const v = result.finalVersion;
        toast.success(
          `Versão reconstruída: v${v.major}.${v.minor}.${v.patch} (${result.logEntriesUpdated} entradas, ${result.responsesUpdated} respostas)`,
        );
        setBackfillDialogOpen(false);
        router.refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Erro ao reconstruir";
        toast.error(msg);
      }
    });
  };

  // --- Troca de modo ---

  const switchToCode = () => {
    const generated = generatePydanticCode(fields);
    setCode(generated);
    setCodeFields(fields);
    setValidationStatus("idle");
    setMode("code");
  };

  const switchToGUI = async () => {
    if (!code.trim()) {
      setFields([]);
      setMode("gui");
      return;
    }
    try {
      const result = await validateSchema(code);
      if (result.valid) {
        setFields(result.fields);
        setCodeFields(result.fields);
        setValidationStatus("valid");
        setMode("gui");
      } else {
        toast.error(
          "Corrija os erros no código antes de trocar para o modo visual"
        );
        setErrors(result.errors);
        setValidationStatus("error");
      }
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  // --- Validar (modo código) ---

  const handleValidate = async () => {
    try {
      const result = await validateSchema(code);
      if (result.valid) {
        setCodeFields(result.fields);
        setValidationStatus("valid");
        setErrors([]);
        toast.success(`${result.fields.length} campos encontrados`);
      } else {
        setValidationStatus("error");
        setErrors(result.errors);
        toast.error("Erro na validação");
      }
    } catch (e: any) {
      setValidationStatus("error");
      setErrors([e.message]);
    }
  };

  // --- Salvar ---

  const handleSave = () => {
    startTransition(async () => {
      try {
        if (mode === "gui") {
          const guiErrors = validateGUIFields(fields);
          if (guiErrors.length > 0) {
            toast.error(guiErrors[0]);
            return;
          }
          await saveSchemaFromGUI(projectId, fields);
          toast.success("Schema salvo!");
        } else {
          if (validationStatus !== "valid") {
            toast.error("Valide o schema antes de salvar");
            return;
          }
          await saveSchema(projectId, code, codeFields);
          toast.success("Schema salvo!");
        }
      } catch (e: any) {
        toast.error(e.message);
      }
    });
  };

  // --- Info para badges ---
  const currentFields = mode === "gui" ? fields : codeFields;
  const fieldCount = currentFields.length;
  const llmOnlyCount = currentFields.filter(
    (f) => f.target === "llm_only"
  ).length;

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
              <LayoutGrid className="h-3.5 w-3.5" />
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
              <Code className="h-3.5 w-3.5" />
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
            <History className="h-3.5 w-3.5" />
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
            <Rocket className="h-3.5 w-3.5" />
            Publicar MAJOR
          </Button>
        </div>
      </div>

      {!helpDismissed && (
        <div className="flex items-start gap-2 border-b bg-blue-500/5 px-4 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600" />
          <div className="flex-1">
            <strong className="text-foreground">Sobre versões do schema.</strong>{" "}
            Toda edição bumpa a versão automaticamente (MINOR para mudanças
            estruturais como adicionar/remover campo ou opção, PATCH para texto).
            Nenhuma edição apaga respostas — elas ficam rotuladas com a versão em
            que foram dadas. Quando você quiser consolidar o codebook como{" "}
            <strong className="text-foreground">baseline oficial</strong>, clique em{" "}
            <strong className="text-foreground">Publicar MAJOR</strong>. A partir daí,
            o filtro padrão da aba Comparar passa a ignorar respostas de versões
            anteriores.
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={dismissHelp}
            title="Dispensar"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Conteúdo */}
      <div className="flex-1 overflow-hidden">
        {mode === "gui" ? (
          <SchemaBuilderGUI fields={fields} onChange={setFields} />
        ) : (
          <MonacoEditor
            height="100%"
            language="python"
            theme="vs-light"
            value={code}
            onChange={(val) => {
              setCode(val || "");
              setValidationStatus("idle");
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              wordWrap: "on",
            }}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t px-4 py-2">
        {mode === "code" && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={isPending}
          >
            Validar
          </Button>
        )}
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isPending}
          className="bg-brand hover:bg-brand/90 text-brand-foreground"
        >
          Salvar
        </Button>
        {mode === "code" && validationStatus === "error" && (
          <Badge variant="destructive" className="text-xs">
            {errors[0]}
          </Badge>
        )}
      </div>

      <AlertDialog open={backfillDialogOpen} onOpenChange={setBackfillDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reconstruir versão pelo histórico?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso percorre todas as entradas do histórico de mudanças do schema em
              ordem cronológica e reatribui change_type (MINOR quando houve adição/remoção
              de opções; PATCH quando só texto foi alterado; MAJOR preservado se já existir).
              A versão do projeto e as versões das respostas existentes são recalculadas
              com base nos timestamps. Útil em projetos antigos que começaram antes do
              versionamento. Idempotente — pode rodar de novo sem problemas.
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
