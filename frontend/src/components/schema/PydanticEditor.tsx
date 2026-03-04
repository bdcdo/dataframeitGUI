"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { validateSchema, saveSchema } from "@/actions/schema";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), { ssr: false });

interface PydanticEditorProps {
  projectId: string;
  initialCode: string | null;
  initialFields: PydanticField[] | null;
}

export function PydanticEditor({ projectId, initialCode, initialFields }: PydanticEditorProps) {
  const [code, setCode] = useState(initialCode || "");
  const [fields, setFields] = useState<PydanticField[]>(initialFields || []);
  const [validationStatus, setValidationStatus] = useState<"idle" | "valid" | "error">("idle");
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const handleValidate = async () => {
    setLoading(true);
    try {
      const result = await validateSchema(code);
      if (result.valid) {
        setFields(result.fields);
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
    setLoading(false);
  };

  const handleSave = async () => {
    if (validationStatus !== "valid") {
      toast.error("Valide o schema antes de salvar");
      return;
    }
    setLoading(true);
    try {
      await saveSchema(projectId, code, fields);
      toast.success("Schema salvo!");
    } catch (e: any) {
      toast.error(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="flex h-[calc(100vh-140px)] flex-col">
      <div className="flex-1">
        <MonacoEditor
          height="100%"
          language="python"
          theme="vs-light"
          value={code}
          onChange={(val) => { setCode(val || ""); setValidationStatus("idle"); }}
          options={{ minimap: { enabled: false }, fontSize: 14, wordWrap: "on" }}
        />
      </div>
      <div className="flex items-center gap-2 border-t px-4 py-2">
        <Button variant="outline" size="sm" onClick={handleValidate} disabled={loading}>
          Validar
        </Button>
        <Button size="sm" onClick={handleSave} disabled={loading} className="bg-brand hover:bg-brand/90 text-brand-foreground">
          Salvar
        </Button>
        {validationStatus === "valid" && <Badge className="bg-green-500/10 text-green-700">OK — {fields.length} campos</Badge>}
        {validationStatus === "error" && <Badge variant="destructive">{errors[0]}</Badge>}
      </div>
    </div>
  );
}
