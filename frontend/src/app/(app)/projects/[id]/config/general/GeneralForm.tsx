"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateProject } from "@/actions/projects";
import { toast } from "sonner";

interface GeneralFormProps {
  projectId: string;
  name: string;
  description: string;
}

export function GeneralForm({
  projectId,
  name: initialName,
  description: initialDescription,
}: GeneralFormProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProject(projectId, { name, description });
      toast.success("Projeto atualizado!");
    } catch (e: any) {
      toast.error(e.message);
    }
    setSaving(false);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h2 className="text-lg font-semibold">Informações do Projeto</h2>

      <div className="space-y-1.5">
        <Label className="text-sm">Nome</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">Descrição</Label>
        <p className="text-xs text-muted-foreground">
          Descreva o objetivo da revisão sistemática. Esta descrição é usada
          automaticamente como contexto no prompt enviado ao LLM.
        </p>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex: Esta revisão sistemática investiga os fatores associados à evasão escolar no ensino superior brasileiro..."
          className="min-h-[120px] resize-y"
        />
      </div>

      <Button
        onClick={handleSave}
        disabled={saving}
        className="bg-brand hover:bg-brand/90 text-brand-foreground"
      >
        Salvar
      </Button>
    </div>
  );
}
