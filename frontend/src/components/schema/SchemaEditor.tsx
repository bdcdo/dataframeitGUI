"use client";

import { useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  validateSchema,
  saveSchema,
  saveSchemaFromGUI,
} from "@/actions/schema";
import { validateGUIFields, generatePydanticCode } from "@/lib/schema-utils";
import { toast } from "sonner";
import { LayoutGrid, Code } from "lucide-react";
import { cn } from "@/lib/utils";
import { SchemaBuilderGUI } from "./SchemaBuilderGUI";
import type { PydanticField } from "@/lib/types";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false }
);

interface SchemaEditorProps {
  projectId: string;
  initialCode: string | null;
  initialFields: PydanticField[] | null;
}

export function SchemaEditor({
  projectId,
  initialCode,
  initialFields,
}: SchemaEditorProps) {
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
    <div className="flex h-[calc(100vh-140px)] flex-col">
      {/* Header: toggle de modo */}
      <div className="flex items-center justify-between border-b px-4 py-2">
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
        </div>
      </div>

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
    </div>
  );
}
