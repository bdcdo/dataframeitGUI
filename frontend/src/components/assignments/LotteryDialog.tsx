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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { smartRandomize, previewLottery } from "@/actions/assignments";
import type { LotteryParams, LotteryPreview } from "@/actions/assignments";
import { toast } from "sonner";
import { CalendarIcon, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ptBR } from "date-fns/locale";
import { format } from "date-fns";

interface LotteryDialogProps {
  projectId: string;
  totalDocs: number;
  totalResearchers: number;
}

export function LotteryDialog({
  projectId,
  totalDocs,
  totalResearchers,
}: LotteryDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Distribution
  const [researchersPerDoc, setResearchersPerDoc] = useState(2);
  const [docsPerResearcherEnabled, setDocsPerResearcherEnabled] =
    useState(false);
  const [docsPerResearcher, setDocsPerResearcher] = useState(10);
  const [docSubsetEnabled, setDocSubsetEnabled] = useState(false);
  const [docSubsetSize, setDocSubsetSize] = useState(
    Math.min(50, totalDocs)
  );

  // Deadline
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const [deadlineMode, setDeadlineMode] = useState<
    "none" | "batch" | "recurring"
  >("none");
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>();
  const [recurringCount, setRecurringCount] = useState(10);
  const [recurringStart, setRecurringStart] = useState<Date | undefined>();

  // Label
  const [label, setLabel] = useState("");

  // Preview
  const [preview, setPreview] = useState<LotteryPreview | null>(null);

  const buildParams = (): LotteryParams => ({
    projectId,
    researchersPerDoc,
    docsPerResearcher: docsPerResearcherEnabled
      ? docsPerResearcher
      : undefined,
    docSubsetSize: docSubsetEnabled ? docSubsetSize : undefined,
    deadlineMode,
    deadlineDate: deadlineDate?.toISOString().split("T")[0],
    recurringCount:
      deadlineMode === "recurring" ? recurringCount : undefined,
    recurringStart:
      deadlineMode === "recurring" && recurringStart
        ? recurringStart.toISOString().split("T")[0]
        : undefined,
    label: label || undefined,
  });

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const result = await previewLottery(buildParams());
      setPreview(result);
    } catch (e: any) {
      toast.error(e.message);
    }
    setPreviewing(false);
  };

  const handleRandomize = async () => {
    setLoading(true);
    try {
      const result = await smartRandomize(buildParams());
      toast.success(
        `${result.count} novas atribuições criadas! (${result.preserved} preservadas)`
      );
      setOpen(false);
      setPreview(null);
    } catch (e: any) {
      toast.error(e.message);
    }
    setLoading(false);
  };

  const formatDate = (date: Date | undefined) => {
    if (!date) return "Selecionar data";
    return format(date, "dd/MM/yyyy", { locale: ptBR });
  };

  const estimatedPerResearcher =
    totalResearchers > 0
      ? Math.ceil(
          ((docSubsetEnabled ? docSubsetSize : totalDocs) *
            researchersPerDoc) /
            totalResearchers
        )
      : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setPreview(null);
      }}
    >
      <DialogTrigger asChild>
        <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">
          Sortear
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sortear Atribuições</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
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

          {/* Section 1: Distribution */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold">Distribuição</h4>

            <div>
              <Label htmlFor="per-doc">Pesquisadores por documento</Label>
              <Input
                id="per-doc"
                type="number"
                min={1}
                max={Math.min(10, totalResearchers)}
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
                max={totalDocs}
                value={docSubsetSize}
                onChange={(e) =>
                  setDocSubsetSize(parseInt(e.target.value) || 1)
                }
                className="w-24"
              />
            )}

            <p className="text-xs text-muted-foreground">
              {totalDocs} documentos disponíveis, {totalResearchers}{" "}
              pesquisadores. Estimativa: ~{estimatedPerResearcher} docs por
              pesquisador.
            </p>
          </div>

          <Separator />

          {/* Section 2: Deadline */}
          <Collapsible open={deadlineOpen} onOpenChange={setDeadlineOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-between text-sm font-semibold">
              Prazo
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  deadlineOpen && "rotate-180"
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-4">
              <RadioGroup
                value={deadlineMode}
                onValueChange={(v) =>
                  setDeadlineMode(v as "none" | "batch" | "recurring")
                }
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="none" id="dl-none" />
                  <Label htmlFor="dl-none">Sem prazo</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="batch" id="dl-batch" />
                  <Label htmlFor="dl-batch">Prazo único</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="recurring" id="dl-recurring" />
                  <Label htmlFor="dl-recurring">Recorrente</Label>
                </div>
              </RadioGroup>

              {deadlineMode === "batch" && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !deadlineDate && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formatDate(deadlineDate)}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={deadlineDate}
                      onSelect={setDeadlineDate}
                      locale={ptBR}
                      disabled={(date) => date < new Date()}
                    />
                  </PopoverContent>
                </Popover>
              )}

              {deadlineMode === "recurring" && (
                <div className="space-y-3">
                  <div>
                    <Label>Documentos por semana</Label>
                    <Input
                      type="number"
                      min={1}
                      value={recurringCount}
                      onChange={(e) =>
                        setRecurringCount(parseInt(e.target.value) || 1)
                      }
                      className="mt-1 w-24"
                    />
                  </div>
                  <div>
                    <Label>Data de início</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className={cn(
                            "mt-1 w-full justify-start text-left font-normal",
                            !recurringStart && "text-muted-foreground"
                          )}
                        >
                          <CalendarIcon className="mr-2 h-4 w-4" />
                          {formatDate(recurringStart)}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-auto p-0"
                        align="start"
                      >
                        <Calendar
                          mode="single"
                          selected={recurringStart}
                          onSelect={setRecurringStart}
                          locale={ptBR}
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>

          <Separator />

          {/* Section 3: Preview + Confirm */}
          <div className="space-y-3">
            <Button
              variant="outline"
              onClick={handlePreview}
              disabled={previewing}
              className="w-full"
            >
              {previewing ? "Calculando..." : "Visualizar prévia"}
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
                        <th className="pb-1">Pesquisador</th>
                        <th className="pb-1 text-center">Existentes</th>
                        <th className="pb-1 text-center">Novos</th>
                        <th className="pb-1 text-right">Prazo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.researchers.map((r) => (
                        <tr key={r.userId} className="border-b last:border-0">
                          <td className="py-1 font-mono">
                            {r.userId.slice(0, 8)}
                          </td>
                          <td className="py-1 text-center">{r.existing}</td>
                          <td className="py-1 text-center">{r.newDocs}</td>
                          <td className="py-1 text-right text-muted-foreground">
                            {r.deadline || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <Button
              onClick={handleRandomize}
              disabled={loading}
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
