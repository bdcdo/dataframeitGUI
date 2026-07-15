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
import { isLlmEnabled } from "@/lib/feature-flags";
import {
  AUTOMATION_MODES,
  automationModeRequiresLlm,
  getAutomationModeOption,
  getAvailableAutomationModes,
  isAutomationMode,
  isAutomationModeAvailable,
  type AutomationMode,
} from "@/lib/automation-modes";

interface RulesFormProps {
  projectId: string;
  resolutionRule: string;
  minResponses: number;
  allowResearcherReview: boolean;
  automationMode: AutomationMode;
  comparisonIncludesLlm: boolean;
  outOfScopeEnabled: boolean;
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
  outOfScopeEnabled,
  llmEnabled,
}: RulesFormProps & { llmEnabled: boolean }) {
  const { refresh } = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rule, setRule] = useState(resolutionRule);
  const [min, setMin] = useState(minResponses);
  const [allowReview, setAllowReview] = useState(allowResearcherReview);
  const [mode, setMode] = useState<AutomationMode>(automationMode);
  const [includesLlm, setIncludesLlm] = useState(comparisonIncludesLlm);
  const [outOfScope, setOutOfScope] = useState(outOfScopeEnabled);
  const [saved, setSaved] = useState(false);

  const modeMeta = getAutomationModeOption(mode);
  const hasHistoricalLlmMode =
    !llmEnabled && automationModeRequiresLlm(automationMode);
  const modeOptions = hasHistoricalLlmMode
    ? AUTOMATION_MODES.filter(
        ({ value, requiresLlm }) =>
          !requiresLlm || value === automationMode,
      )
    : getAvailableAutomationModes(llmEnabled);

  function handleModeChange(value: string) {
    if (!isAutomationMode(value)) return;
    if (!isAutomationModeAvailable(value, llmEnabled)) return;
    setMode(value);
    if (!llmEnabled) setIncludesLlm(false);
  }

  function handleSave() {
    startTransition(async () => {
      try {
        const data: Parameters<typeof updateProject>[1] = {
          resolution_rule: rule,
          min_responses_for_comparison: min,
          allow_researcher_review: allowReview,
          out_of_scope_enabled: outOfScope,
        };
        // Um valor LLM já salvo continua visível como histórico, mas não volta
        // no payload enquanto a flag está desligada. Assim outras regras podem
        // ser editadas sem regravar nem apagar a configuração existente.
        if (llmEnabled || !automationModeRequiresLlm(mode)) {
          data.automation_mode = mode;
        }
        if (llmEnabled || !includesLlm) {
          data.comparison_includes_llm = includesLlm;
        }

        const r = await updateProject(projectId, data);
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
    handleModeChange,
    includesLlm,
    setIncludesLlm,
    outOfScope,
    setOutOfScope,
    saved,
    isPending,
    modeMeta,
    modeOptions,
    hasHistoricalLlmMode,
    handleSave,
  };
}

export function RulesForm(props: RulesFormProps) {
  const llmEnabled = isLlmEnabled();
  const {
    rule,
    setRule,
    min,
    setMin,
    allowReview,
    setAllowReview,
    mode,
    handleModeChange,
    includesLlm,
    setIncludesLlm,
    outOfScope,
    setOutOfScope,
    saved,
    isPending,
    modeMeta,
    modeOptions,
    hasHistoricalLlmMode,
    handleSave,
  } = useRulesFormState({ ...props, llmEnabled });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regras de Revisão</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label className="text-sm">Modo de automação</Label>
          <Select value={mode} onValueChange={handleModeChange}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modeOptions.map((m) => (
                <SelectItem
                  key={m.value}
                  value={m.value}
                  disabled={!isAutomationModeAvailable(m.value, llmEnabled)}
                >
                  {m.label}
                  {!llmEnabled && m.requiresLlm ? " (histórico)" : ""}
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
          {hasHistoricalLlmMode && (
            <p
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
            >
              Este projeto mantém o modo LLM já salvo apenas como histórico.
              Ele não pode ser escolhido novamente enquanto o LLM estiver
              desabilitado. Selecione Nenhuma automação ou Comparação
              humano-vs-humano para substituí-lo; respostas e filas existentes
              continuarão disponíveis.
            </p>
          )}
        </div>

        {mode === "compare_humans" && (llmEnabled || includesLlm) && (
          <div className="flex items-start gap-3">
            <Switch
              id="includesLlm"
              checked={includesLlm}
              onCheckedChange={(checked) => {
                if (llmEnabled || !checked) setIncludesLlm(checked);
              }}
              disabled={!llmEnabled && !includesLlm}
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
              {!llmEnabled && includesLlm && (
                <p role="alert" className="text-xs text-amber-700">
                  Esta opção está preservada como configuração histórica. Você
                  pode desligá-la, mas não reativá-la enquanto o LLM estiver
                  desabilitado.
                </p>
              )}
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

        <div className="flex items-start gap-3">
          <Switch
            id="outOfScope"
            checked={outOfScope}
            onCheckedChange={setOutOfScope}
            aria-label="Permitir sinalizar documento fora do escopo"
          />
          <div className="space-y-1">
            <Label htmlFor="outOfScope" className="text-sm">
              Permitir sinalizar documento fora do escopo
            </Label>
            <p className="text-xs text-muted-foreground">
              Mostra a pergunta &quot;Documento fora do escopo?&quot; no topo do
              formulário de codificação. Documento sinalizado sai das filas de
              todos até o coordenador aprovar (remoção) ou rejeitar (retorno) em
              Comentários. Desligar só esconde a pergunta; sinalizações
              pendentes continuam valendo.
            </p>
          </div>
        </div>

        <Button onClick={handleSave} disabled={isPending} className="w-full">
          {isPending ? "Salvando..." : saved ? "Salvo!" : "Salvar Regras"}
        </Button>
      </CardContent>
    </Card>
  );
}
