"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { LotteryMode } from "@/lib/lottery-utils";
import type { LotteryMember } from "./lottery-dialog-types";
import { useLotteryStats } from "./useLotteryStats";
import { useLotteryParams } from "./useLotteryParams";
import { useLotteryRun } from "./useLotteryRun";
import {
  capValue,
  isParticipant,
  weightValue,
} from "./lottery-participant-values";
import { LotteryEligibilitySection } from "./LotteryEligibilitySection";
import {
  LotteryDistributionSection,
  type LotterySummary,
} from "./LotteryDistributionSection";

interface LotteryDialogProps {
  projectId: string;
  members: LotteryMember[];
}

export function LotteryDialog({ projectId, members }: LotteryDialogProps) {
  const [open, setOpen] = useState(false);

  const { stats, statsError } = useLotteryStats(projectId, open);

  const params = useLotteryParams();
  const {
    type,
    setType,
    mode,
    setMode,
    participantOverrides,
    setParticipantOverrides,
    weightInputs,
    setWeightInputs,
    capInputs,
    setCapInputs,
    label,
    setLabel,
    setPreviewState,
  } = params;

  const {
    isComparacao,
    participantCount,
    eligibleCount,
    blockedMessage,
    canSubmit,
    preview,
    estimatedPerParticipant,
    previewing,
    loading,
    handlePreview,
    handleRandomize,
  } = useLotteryRun({
    projectId,
    members,
    stats,
    params,
    onLotteryDone: () => setOpen(false),
  });

  const summary: LotterySummary = blockedMessage
    ? { kind: "blocked", message: blockedMessage }
    : stats === null
      ? statsError
        ? { kind: "error" }
        : { kind: "loading" }
      : {
          kind: "ready",
          eligibleCount: eligibleCount ?? 0,
          participantCount,
          estimatedPerParticipant,
        };

  const memberName = (userId: string) =>
    members.find((m) => m.userId === userId)?.name ?? userId.slice(0, 8);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setPreviewState(null);
      }}
    >
      <DialogTrigger asChild>
        <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">
          Sortear
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Sortear {isComparacao ? "Comparações" : "Atribuições"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Tipo do sorteio */}
          <div>
            <Label>Tipo</Label>
            <RadioGroup
              value={type}
              onValueChange={(v) => setType(v as "codificacao" | "comparacao")}
              className="mt-2 flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="codificacao" id="type-cod" />
                <Label htmlFor="type-cod" className="font-normal">
                  Codificação
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="comparacao" id="type-comp" />
                <Label htmlFor="type-comp" className="font-normal">
                  Comparação
                </Label>
              </div>
            </RadioGroup>
            {isComparacao && (
              <p className="mt-2 text-xs text-muted-foreground">
                {stats?.automationMode === "compare_llm"
                  ? "Elegíveis: documentos com ao menos 1 codificação humana e 1 resposta do LLM."
                  : `Elegíveis: documentos com ao menos ${stats?.minResponsesForComparison ?? 2} codificações humanas.`}
              </p>
            )}
          </div>

          <Separator />

          {/* Label */}
          <div>
            <Label htmlFor="batch-label">Rótulo (opcional)</Label>
            <Input
              id="batch-label"
              placeholder="Ex: Lote 1"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1"
            />
          </div>

          <Separator />

          <LotteryEligibilitySection
            params={params}
            stats={stats}
            isComparacao={isComparacao}
          />

          <Separator />

          {/* Section: Pending assignments mode (US2) */}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Atribuições pendentes</h4>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as LotteryMode)}
              className="space-y-1"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="append" id="mode-append" />
                <Label htmlFor="mode-append" className="font-normal">
                  Acrescentar ao existente
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="replace" id="mode-replace" />
                <Label htmlFor="mode-replace" className="font-normal">
                  Substituir pendentes
                </Label>
              </div>
            </RadioGroup>
            <p className="text-xs text-muted-foreground">
              {mode === "append"
                ? "As atribuições pendentes existentes são preservadas; o sorteio só adiciona novas."
                : `As atribuições pendentes de ${isComparacao ? "comparação" : "codificação"} são descartadas e redistribuídas. Em andamento e concluídas nunca são tocadas.`}
            </p>
          </div>

          <Separator />

          <LotteryDistributionSection
            params={params}
            membersCount={members.length}
            isComparacao={isComparacao}
            summary={summary}
          />

          {members.length > 0 && (
            <>
              <Separator />

              {/* Section: Participants (US3) */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold">Participantes</h4>
                <p className="text-xs text-muted-foreground">
                  Quem está ligado entra no sorteio. Pesquisadores começam
                  ligados; coordenadores, desligados. O <strong>peso</strong>{" "}
                  ajusta a carga relativa (0,5 = metade dos demais); o{" "}
                  <strong>limite</strong> (opcional) é o teto de docs novos da
                  pessoa neste sorteio. Os valores ficam salvos para o próximo.
                </p>
                {members.map((m) => (
                  <div key={m.userId} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label
                        htmlFor={`member-${m.userId}`}
                        className="font-normal"
                      >
                        {m.name}
                        {m.role === "coordenador" && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            coordenador
                          </span>
                        )}
                        {m.pending && (
                          <Badge
                            variant="secondary"
                            className="ml-1.5"
                            title="Pré-registrado: ainda não criou conta."
                          >
                            Pendente
                          </Badge>
                        )}
                      </Label>
                      <Switch
                        id={`member-${m.userId}`}
                        checked={isParticipant(m, participantOverrides)}
                        onCheckedChange={(checked) =>
                          setParticipantOverrides((prev) => ({
                            ...prev,
                            [m.userId]: checked,
                          }))
                        }
                      />
                    </div>
                    {isParticipant(m, participantOverrides) && (
                      <div className="flex items-center gap-4 pl-1 text-xs text-muted-foreground">
                        <label
                          htmlFor={`weight-${m.userId}`}
                          className="flex items-center gap-1.5"
                        >
                          peso
                          <Input
                            id={`weight-${m.userId}`}
                            type="number"
                            min={0.5}
                            step={0.5}
                            value={weightValue(m, weightInputs)}
                            onChange={(e) =>
                              setWeightInputs((prev) => ({
                                ...prev,
                                [m.userId]: e.target.value,
                              }))
                            }
                            className="h-7 w-16"
                            aria-label={`Peso de ${m.name}`}
                          />
                        </label>
                        <label
                          htmlFor={`cap-${m.userId}`}
                          className="flex items-center gap-1.5"
                        >
                          limite
                          <Input
                            id={`cap-${m.userId}`}
                            type="number"
                            min={1}
                            placeholder="—"
                            value={capValue(m, capInputs)}
                            onChange={(e) =>
                              setCapInputs((prev) => ({
                                ...prev,
                                [m.userId]: e.target.value,
                              }))
                            }
                            className="h-7 w-16"
                            aria-label={`Limite de docs de ${m.name}`}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <Separator />

          {/* Section 3: Preview + Confirm */}
          <div className="space-y-3">
            <Button
              variant="outline"
              onClick={handlePreview}
              disabled={previewing || !canSubmit}
              className="w-full"
            >              {previewing ? "Calculando..." : "Visualizar prévia"}
            </Button>

            {preview && (
              <div className="rounded-lg border p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {preview.totalNew} novas atribuições ·{" "}
                  {preview.totalPreserved} preservadas
                </p>
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="pb-1">Participante</th>
                        <th className="pb-1 text-center">Existentes</th>
                        <th className="pb-1 text-center">Novos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.participants.map((r) => (
                        <tr key={r.userId} className="border-b last:border-0">
                          <td className="py-1">{memberName(r.userId)}</td>
                          <td className="py-1 text-center">{r.existing}</td>
                          <td className="py-1 text-center">{r.newDocs}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <Button
              onClick={handleRandomize}
              disabled={loading || !canSubmit}
              className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
            >
              {loading ? "Sorteando..." : "Sortear"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
