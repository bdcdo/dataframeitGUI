"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProject } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface RulesFormProps {
  projectId: string;
  resolutionRule: string;
  minResponses: number;
  allowResearcherReview: boolean;
}

const RESOLUTION_OPTIONS = [
  { value: "majority", label: "Maioria simples" },
  { value: "unanimous", label: "Unanimidade" },
  { value: "coordinator", label: "Decisão do coordenador" },
];

export function RulesForm({
  projectId,
  resolutionRule,
  minResponses,
  allowResearcherReview,
}: RulesFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rule, setRule] = useState(resolutionRule);
  const [min, setMin] = useState(minResponses);
  const [allowReview, setAllowReview] = useState(allowResearcherReview);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    startTransition(async () => {
      await updateProject(projectId, {
        resolution_rule: rule,
        min_responses_for_comparison: min,
        allow_researcher_review: allowReview,
      });
      setSaved(true);
      router.refresh();
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regras de Resolução</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <label className="text-sm font-medium">Regra de resolução</label>
          <select
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {RESOLUTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            Mínimo de respostas para comparação
          </label>
          <Input
            type="number"
            min={2}
            max={10}
            value={min}
            onChange={(e) => setMin(Number(e.target.value))}
          />
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="allowReview"
            checked={allowReview}
            onChange={(e) => setAllowReview(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <label htmlFor="allowReview" className="text-sm font-medium">
            Permitir revisão por pesquisadores
          </label>
        </div>

        <Button onClick={handleSave} disabled={isPending} className="w-full">
          {isPending ? "Salvando..." : saved ? "Salvo!" : "Salvar Regras"}
        </Button>
      </CardContent>
    </Card>
  );
}
