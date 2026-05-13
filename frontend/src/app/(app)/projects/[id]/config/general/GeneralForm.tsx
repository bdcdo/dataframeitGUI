"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { updateProject } from "@/actions/projects";
import { toast } from "sonner";

interface GeneralFormProps {
  projectId: string;
  name: string;
  description: string;
  arbitrationBlind: boolean;
}

export function GeneralForm({
  projectId,
  name: initialName,
  description: initialDescription,
  arbitrationBlind: initialArbitrationBlind,
}: GeneralFormProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [arbitrationBlind, setArbitrationBlind] = useState(
    initialArbitrationBlind,
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Informe um nome para o projeto.");
      return;
    }
    setSaving(true);
    try {
      await updateProject(projectId, {
        name: trimmedName,
        description,
        arbitration_blind: arbitrationBlind,
      });
      toast.success("Projeto atualizado!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
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

      <div className="border-t pt-6 space-y-3">
        <h3 className="text-sm font-medium">Arbitragem</h3>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-sm">Arbitragem cega na fase 2</Label>
            <p className="text-xs text-muted-foreground">
              Quando ativado, mesmo após a fase cega o árbitro continua vendo
              as respostas como &quot;A&quot; e &quot;B&quot; (apenas a
              justificativa do LLM é revelada). Quando desativado, a fase 2
              mostra os rótulos &quot;Humano&quot; e &quot;LLM&quot;
              explicitamente.
            </p>
          </div>
          <Switch
            checked={arbitrationBlind}
            onCheckedChange={setArbitrationBlind}
          />
        </div>
      </div>

      <Button
        onClick={handleSave}
        disabled={saving || !name.trim()}
        className="bg-brand hover:bg-brand/90 text-brand-foreground"
      >
        Salvar
      </Button>
    </div>
  );
}
