"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateProject } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AUTOMATION_MODES, type AutomationMode } from "@/lib/types";

interface RulesFormProps {
  projectId: string;
  resolutionRule: string;
  minResponses: number;
  allowResearcherReview: boolean;
  automationMode: AutomationMode;
  comparisonIncludesLlm: boolean;
}

const RESOLUTION_OPTIONS = [
  { value: "majority", label: "Maioria simples" },
  { value: "unanimous", label: "Unanimidade" },
  { value: "coordinator", label: "Decisão do coordenador" },
];

// Controlador do formulário de regras: o estado é semeado uma vez a partir dos
// valores salvos do projeto e editado localmente (capture-once — re-sincronizar
// com as props no meio da edição apagaria o que o usuário digitou). Extrair para
// hook mantém o componente focado em layout e agrupa os campos do form.
function useRulesFormState({
  projectId,
  resolutionRule,
  minResponses,
  allowResearcherReview,
  automationMode,
  comparisonIncludesLlm,
}: RulesFormProps) {
  const { refresh } = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rule, setRule] = useState(resolutionRule);
  const [min, setMin] = useState(minResponses);
  const [allowReview, setAllowReview] = useState(allowResearcherReview);
  const [mode, setMode] = useState<AutomationMode>(automationMode);
  const [includesLlm, setIncludesLlm] = useState(comparisonIncludesLlm);
  const [saved, setSaved] = useState(false);

  const modeMeta = AUTOMATION_MODES.find((m) => m.value === mode);

  function handleSave() {
    startTransition(async () => {
      try {
        const r = await updateProject(projectId, {
          resolution_rule: rule,
          min_responses_for_comparison: min,
          allow_researcher_review: allowReview,
          automation_mode: mode,
          comparison_includes_llm: includesLlm,
        });
        if (r?.error) {
          toast.error(r.error);
          return;
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Erro ao salvar as regras");
        return;
      }
      setSaved(true);
      refresh();
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return {
    rule,
    setRule,
    min,
    setMin,
    allowReview,
    setAllowReview,
    mode,
    setMode,
    includesLlm,
    setIncludesLlm,
    saved,
    isPending,
    modeMeta,
    handleSave,
  };
}

export function RulesForm(props: RulesFormProps) {
  const {
    rule,
    setRule,
    min,
    setMin,
    allowReview,
    setAllowReview,
    mode,
    setMode,
    includesLlm,
    setIncludesLlm,
    saved,
    isPending,
    modeMeta,
    handleSave,
  } = useRulesFormState(props);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regras de Revisão</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label className="text-sm">Modo de automação</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as AutomationMode)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTOMATION_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {modeMeta && (
            <p className="text-xs text-muted-foreground">{modeMeta.description}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Mudar o modo só afeta novas codificações; o backlog existente é
            preenchido conforme as pessoas codificam (ou via sorteio manual).
            Determina também quais abas de revisão aparecem no projeto.
          </p>
        </div>

        {mode === "compare_humans" && (
          <div className="flex items-start gap-3">
            <Switch
              id="includesLlm"
              checked={includesLlm}
              onCheckedChange={setIncludesLlm}
              aria-label="Incluir o LLM no disparo da comparação"
            />
            <div className="space-y-1">
              <Label htmlFor="includesLlm" className="text-sm">
                Incluir o LLM no disparo da comparação
              </Label>
              <p className="text-xs text-muted-foreground">
                Quando ligado, a comparação é liberada também se os humanos
                concordam mas o LLM diverge. Desligado, só dispara quando os
                humanos divergem entre si (o LLM ainda aparece na comparação).
              </p>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-sm">Regra de resolução</Label>
          <Select value={rule} onValueChange={setRule}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESOLUTION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-sm">
            Mínimo de respostas para comparação
          </Label>
          <Input
            type="number"
            min={2}
            max={10}
            value={min}
            onChange={(e) => setMin(Number(e.target.value))}
          />
        </div>

        <div className="flex items-center gap-3">
          <Checkbox
            id="allowReview"
            checked={allowReview}
            onCheckedChange={(checked) => setAllowReview(checked === true)}
          />
          <Label htmlFor="allowReview" className="text-sm">
            Permitir revisão por pesquisadores
          </Label>
        </div>

        <Button onClick={handleSave} disabled={isPending} className="w-full">
          {isPending ? "Salvando..." : saved ? "Salvo!" : "Salvar Regras"}
        </Button>
      </CardContent>
    </Card>
  );
}
