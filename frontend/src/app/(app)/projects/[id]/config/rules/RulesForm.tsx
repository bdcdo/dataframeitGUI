"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
