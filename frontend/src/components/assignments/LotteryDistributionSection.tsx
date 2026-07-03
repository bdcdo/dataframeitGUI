"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { LotteryBalancing } from "@/lib/lottery-utils";
import type { LotteryParamsState } from "./useLotteryParams";

// Resumo do rodapé da seção, calculado no LotteryDialog a partir do
// useLotteryRun — união discriminada em vez de booleanos soltos, para que
// "ready sem contagens" seja irrepresentável.
export type LotterySummary =
  | { kind: "blocked"; message: string }
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "ready";
      eligibleCount: number;
      participantCount: number;
      estimatedPerParticipant: number;
    };

// Seção "Distribuição" do LotteryDialog: revisores por documento, limites,
// subconjunto, equilíbrio e o resumo de estimativa.
export function LotteryDistributionSection({
  params,
  membersCount,
  summary,
}: {
  params: Pick<
    LotteryParamsState,
    | "type"
    | "researchersPerDoc"
    | "setResearchersPerDoc"
    | "docsPerResearcherEnabled"
    | "setDocsPerResearcherEnabled"
    | "docsPerResearcher"
    | "setDocsPerResearcher"
    | "docSubsetEnabled"
    | "setDocSubsetEnabled"
    | "docSubsetSize"
    | "setDocSubsetSize"
    | "balancing"
    | "setBalancing"
  >;
  membersCount: number;
  summary: LotterySummary;
}) {
  const {
    type,
    researchersPerDoc,
    setResearchersPerDoc,
    docsPerResearcherEnabled,
    setDocsPerResearcherEnabled,
    docsPerResearcher,
    setDocsPerResearcher,
    docSubsetEnabled,
    setDocSubsetEnabled,
    docSubsetSize,
    setDocSubsetSize,
    balancing,
    setBalancing,
  } = params;
  const isComparacao = type === "comparacao";

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-semibold">Distribuição</h4>

      <div>
        <Label htmlFor="per-doc">
          {isComparacao ? "Revisores por documento" : "Pesquisadores por documento"}
        </Label>
        <Input
          id="per-doc"
          type="number"
          min={1}
          max={Math.max(1, Math.min(10, membersCount))}
          value={researchersPerDoc}
          onChange={(e) =>
            setResearchersPerDoc(parseInt(e.target.value) || 1)
          }
          className="mt-1 w-24"
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="docs-per-switch">
          Limite de docs por pesquisador
        </Label>
        <Switch
          id="docs-per-switch"
          checked={docsPerResearcherEnabled}
          onCheckedChange={setDocsPerResearcherEnabled}
        />
      </div>
      {docsPerResearcherEnabled && (
        <Input
          type="number"
          min={1}
          value={docsPerResearcher}
          onChange={(e) =>
            setDocsPerResearcher(parseInt(e.target.value) || 1)
          }
          className="w-24"
        />
      )}

      <div className="flex items-center justify-between">
        <Label htmlFor="subset-switch">
          Subconjunto de documentos
        </Label>
        <Switch
          id="subset-switch"
          checked={docSubsetEnabled}
          onCheckedChange={setDocSubsetEnabled}
        />
      </div>
      {docSubsetEnabled && (
        <Input
          type="number"
          min={1}
          value={docSubsetSize}
          onChange={(e) =>
            setDocSubsetSize(parseInt(e.target.value) || 1)
          }
          className="w-24"
        />
      )}

      <div>
        <Label>Equilíbrio</Label>
        <RadioGroup
          value={balancing}
          onValueChange={(v) => setBalancing(v as LotteryBalancing)}
          className="mt-2 space-y-1"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="round" id="bal-round" />
            <Label htmlFor="bal-round" className="font-normal">
              Equilibrar só esta rodada
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="history" id="bal-history" />
            <Label htmlFor="bal-history" className="font-normal">
              Equilibrar considerando rodadas anteriores
            </Label>
          </div>
        </RadioGroup>
        <p className="mt-1 text-xs text-muted-foreground">
          {balancing === "round"
            ? "Cada participante recebe a mesma quantidade de atribuições novas (±1)."
            : "Quem tem menos atribuições acumuladas recebe mais, até nivelar."}
        </p>
      </div>

      {summary.kind === "blocked" ? (
        <p className="text-xs text-destructive">{summary.message}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {summary.kind === "error"
            ? "Não foi possível carregar os documentos."
            : summary.kind === "loading"
              ? "Carregando documentos..."
              : `${summary.eligibleCount} documentos elegíveis, ${summary.participantCount} participantes. ${
                  balancing === "round"
                    ? `Estimativa: ~${summary.estimatedPerParticipant} docs por participante.`
                    : `Média: ~${summary.estimatedPerParticipant} docs por participante — quem tem menos carga recebe mais.`
                }`}
        </p>
      )}
    </div>
  );
}
