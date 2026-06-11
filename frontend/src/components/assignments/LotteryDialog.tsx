"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { DocumentPickerList } from "@/components/assignments/DocumentPickerList";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getLotteryDocStats,
  smartRandomize,
  previewLottery,
} from "@/actions/assignments";
import type { LotteryParams, LotteryPreview } from "@/actions/assignments";
import {
  filterEligibleDocs,
  type AssignmentFilter,
  type LotteryBalancing,
  type LotteryDocStats,
  type LotteryFilters,
  type LotteryMode,
} from "@/lib/lottery-utils";
import { toast } from "sonner";
import { ptBR } from "date-fns/locale";
import { format } from "date-fns";

export interface LotteryMember {
  userId: string;
  name: string;
  role: "pesquisador" | "coordenador";
}

interface LotteryDialogProps {
  projectId: string;
  members: LotteryMember[];
}

interface LotteryStats {
  docs: LotteryDocStats[];
  batches: { id: string; label: string | null; createdAt: string }[];
  minResponsesForComparison: number;
}

type CodingsFilterMode = "all" | "none" | "atMost";

export function LotteryDialog({ projectId, members }: LotteryDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Stats de elegibilidade, recarregadas a cada abertura do dialog —
  // um sorteio muda atribuições/lotes, então reabrir com stats da
  // abertura anterior mentiria na contagem de elegíveis
  const [stats, setStats] = useState<LotteryStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getLotteryDocStats(projectId)
      .then((s) => {
        if (!cancelled) {
          setStats(s);
          setStatsError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setStatsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // Tipo do sorteio (codificação ou comparação)
  const [type, setType] = useState<"codificacao" | "comparacao">("codificacao");

  // Distribuição
  const [researchersPerDoc, setResearchersPerDoc] = useState(2);
  const [docsPerResearcherEnabled, setDocsPerResearcherEnabled] =
    useState(false);
  const [docsPerResearcher, setDocsPerResearcher] = useState(10);
  const [docSubsetEnabled, setDocSubsetEnabled] = useState(false);
  const [docSubsetSize, setDocSubsetSize] = useState(50);
  const [balancing, setBalancing] = useState<LotteryBalancing>("round");

  // Atribuições pendentes (modo)
  const [mode, setMode] = useState<LotteryMode>("append");

  // Filtros de elegibilidade
  const [codingsFilterMode, setCodingsFilterMode] =
    useState<CodingsFilterMode>("all");
  const [maxCodingsValue, setMaxCodingsValue] = useState(1);
  const [assignmentFilter, setAssignmentFilter] =
    useState<AssignmentFilter>("any");
  const [batchFilterMode, setBatchFilterMode] = useState<
    "none" | "exclude" | "only"
  >("none");
  const [batchExclude, setBatchExclude] = useState<string[]>([]);
  const [batchOnly, setBatchOnly] = useState<string | null>(null);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [manualDocIds, setManualDocIds] = useState<Set<string>>(new Set());

  // Participantes: pesquisadores ligados por default, coordenadores desligados
  const [participants, setParticipants] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        members.map((m) => [m.userId, m.role === "pesquisador"])
      )
  );

  const participantIds = useMemo(
    () =>
      members
        .map((m) => m.userId)
        .filter((id) => participants[id]),
    [members, participants]
  );

  // Label
  const [label, setLabel] = useState("");

  const isComparacao = type === "comparacao";

  const filters = useMemo<LotteryFilters>(() => {
    const f: LotteryFilters = {};
    if (codingsFilterMode === "none") f.maxHumanCodings = 0;
    else if (codingsFilterMode === "atMost") f.maxHumanCodings = maxCodingsValue;
    if (assignmentFilter !== "any") f.assignmentFilter = assignmentFilter;
    if (batchFilterMode === "only" && batchOnly) {
      f.batchFilter = { only: batchOnly };
    } else if (batchFilterMode === "exclude" && batchExclude.length) {
      f.batchFilter = { exclude: batchExclude };
    }
    if (manualEnabled) f.manualDocIds = Array.from(manualDocIds);
    return f;
  }, [
    codingsFilterMode,
    maxCodingsValue,
    assignmentFilter,
    batchFilterMode,
    batchOnly,
    batchExclude,
    manualEnabled,
    manualDocIds,
  ]);

  // Prévia + semente (research D13): a seed da última prévia é reaproveitada
  // ao sortear; a prévia é guardada junto da configuração que a gerou, então
  // qualquer mudança de configuração a invalida (e à seed) por derivação
  const configKey = JSON.stringify({
    type,
    researchersPerDoc,
    docsPerResearcherEnabled,
    docsPerResearcher,
    docSubsetEnabled,
    docSubsetSize,
    mode,
    balancing,
    filters,
    participantIds,
    label,
  });
  const [previewState, setPreviewState] = useState<{
    key: string;
    preview: LotteryPreview;
  } | null>(null);
  const preview = previewState?.key === configKey ? previewState.preview : null;
  const seed = preview?.seed ?? null;

  // Contagem de elegíveis ao vivo, com a mesma função pura do server
  const eligibleCount = useMemo(() => {
    if (!stats) return null;
    let candidates = stats.docs;
    if (isComparacao) {
      candidates = candidates.filter(
        (d) => d.humanCodingCount >= stats.minResponsesForComparison
      );
    }
    return filterEligibleDocs(candidates, type, filters).length;
  }, [stats, type, isComparacao, filters]);

  const blockedMessage =
    participantIds.length === 0
      ? "Nenhum participante selecionado."
      : eligibleCount === 0
        ? "Nenhum documento passa nos filtros atuais."
        : null;

  const canSubmit = !blockedMessage && stats !== null;

  const buildParams = (withSeed: boolean): LotteryParams => ({
    projectId,
    type,
    mode,
    balancing,
    seed: withSeed && seed !== null ? seed : undefined,
    researchersPerDoc,
    docsPerResearcher: docsPerResearcherEnabled
      ? docsPerResearcher
      : undefined,
    docSubsetSize: docSubsetEnabled ? docSubsetSize : undefined,
    label: label || undefined,
    filters,
    participantIds,
  });

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const result = await previewLottery(buildParams(false));
      setPreviewState({ key: configKey, preview: result });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao calcular a prévia");
    }
    setPreviewing(false);
  };

  const handleRandomize = async () => {
    setLoading(true);
    try {
      const result = await smartRandomize(buildParams(true));
      toast.success(
        `${result.count} novas atribuições criadas! (${result.preserved} preservadas)`
      );
      setOpen(false);
      setPreviewState(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao sortear");
    }
    setLoading(false);
  };

  const docsConsidered =
    eligibleCount === null
      ? null
      : docSubsetEnabled
        ? Math.min(docSubsetSize, eligibleCount)
        : eligibleCount;

  const estimatedPerParticipant =
    docsConsidered !== null && participantIds.length > 0
      ? Math.ceil((docsConsidered * researchersPerDoc) / participantIds.length)
      : 0;

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

          {/* Section: Eligible documents (US1) */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold">Documentos elegíveis</h4>

            <div>
              <Label>Codificações humanas</Label>
              <RadioGroup
                value={codingsFilterMode}
                onValueChange={(v) =>
                  setCodingsFilterMode(v as CodingsFilterMode)
                }
                className="mt-2 space-y-1"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="all" id="cod-all" />
                  <Label htmlFor="cod-all" className="font-normal">
                    Todos os documentos
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="none" id="cod-none" />
                  <Label htmlFor="cod-none" className="font-normal">
                    Sem nenhuma codificação
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="atMost" id="cod-atmost" />
                  <Label htmlFor="cod-atmost" className="font-normal">
                    No máximo
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    value={maxCodingsValue}
                    onChange={(e) =>
                      setMaxCodingsValue(parseInt(e.target.value) || 1)
                    }
                    onFocus={() => setCodingsFilterMode("atMost")}
                    className="h-7 w-16"
                    aria-label="Número máximo de codificações"
                  />
                  <span className="text-sm font-normal">codificações</span>
                </div>
              </RadioGroup>
            </div>

            <div>
              <Label htmlFor="assignment-filter">Status de atribuição</Label>
              <Select
                value={assignmentFilter}
                onValueChange={(v) =>
                  setAssignmentFilter(v as AssignmentFilter)
                }
              >
                <SelectTrigger id="assignment-filter" className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Qualquer</SelectItem>
                  <SelectItem value="noActiveOfType">
                    Sem atribuição ativa de{" "}
                    {isComparacao ? "comparação" : "codificação"}
                  </SelectItem>
                  <SelectItem value="neverAssigned">
                    Nunca atribuído
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {stats !== null && stats.batches.length > 0 && (
              <div>
                <Label htmlFor="batch-filter-mode">Lotes anteriores</Label>
                <Select
                  value={batchFilterMode}
                  onValueChange={(v) =>
                    setBatchFilterMode(v as "none" | "exclude" | "only")
                  }
                >
                  <SelectTrigger id="batch-filter-mode" className="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Todos os lotes</SelectItem>
                    <SelectItem value="exclude">Excluir lotes</SelectItem>
                    <SelectItem value="only">Somente de um lote</SelectItem>
                  </SelectContent>
                </Select>

                {batchFilterMode === "exclude" && (
                  <div className="mt-2 max-h-32 space-y-2 overflow-y-auto rounded-md border p-2">
                    {stats.batches.map((b) => (
                      <div key={b.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`batch-ex-${b.id}`}
                          checked={batchExclude.includes(b.id)}
                          onCheckedChange={(checked) =>
                            setBatchExclude((prev) =>
                              checked
                                ? [...prev, b.id]
                                : prev.filter((id) => id !== b.id)
                            )
                          }
                        />
                        <Label
                          htmlFor={`batch-ex-${b.id}`}
                          className="font-normal"
                        >
                          {b.label || "Sem rótulo"}
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {format(new Date(b.createdAt), "dd/MM/yyyy", {
                              locale: ptBR,
                            })}
                          </span>
                        </Label>
                      </div>
                    ))}
                  </div>
                )}

                {batchFilterMode === "only" && (
                  <RadioGroup
                    value={batchOnly ?? ""}
                    onValueChange={setBatchOnly}
                    className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-md border p-2"
                  >
                    {stats.batches.map((b) => (
                      <div key={b.id} className="flex items-center gap-2">
                        <RadioGroupItem value={b.id} id={`batch-only-${b.id}`} />
                        <Label
                          htmlFor={`batch-only-${b.id}`}
                          className="font-normal"
                        >
                          {b.label || "Sem rótulo"}
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {format(new Date(b.createdAt), "dd/MM/yyyy", {
                              locale: ptBR,
                            })}
                          </span>
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}

                <p className="mt-1 text-xs text-muted-foreground">
                  O vínculo com o lote vem das atribuições existentes dos
                  documentos.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between">
              <Label htmlFor="manual-switch">
                Selecionar documentos manualmente
              </Label>
              <Switch
                id="manual-switch"
                checked={manualEnabled}
                onCheckedChange={setManualEnabled}
              />
            </div>
            {manualEnabled && stats !== null && (
              <DocumentPickerList
                docs={stats.docs}
                selected={manualDocIds}
                onChange={setManualDocIds}
              />
            )}
          </div>

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

          {/* Section 1: Distribution */}
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
                max={Math.max(1, Math.min(10, members.length))}
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

            {blockedMessage ? (
              <p className="text-xs text-destructive">{blockedMessage}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {stats === null
                  ? statsError
                    ? "Não foi possível carregar os documentos."
                    : "Carregando documentos..."
                  : `${eligibleCount} documentos elegíveis, ${participantIds.length} participantes. ${
                      balancing === "round"
                        ? `Estimativa: ~${estimatedPerParticipant} docs por participante.`
                        : `Média: ~${estimatedPerParticipant} docs por participante — quem tem menos carga recebe mais.`
                    }`}
              </p>
            )}
          </div>

          {members.length > 0 && (
            <>
              <Separator />

              {/* Section: Participants (US3) */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold">Participantes</h4>
                <p className="text-xs text-muted-foreground">
                  Quem está ligado entra no sorteio. Pesquisadores começam
                  ligados; coordenadores, desligados.
                </p>
                {members.map((m) => (
                  <div key={m.userId} className="flex items-center justify-between">
                    <Label htmlFor={`member-${m.userId}`} className="font-normal">
                      {m.name}
                      {m.role === "coordenador" && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          coordenador
                        </span>
                      )}
                    </Label>
                    <Switch
                      id={`member-${m.userId}`}
                      checked={!!participants[m.userId]}
                      onCheckedChange={(checked) =>
                        setParticipants((prev) => ({
                          ...prev,
                          [m.userId]: checked,
                        }))
                      }
                    />
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
