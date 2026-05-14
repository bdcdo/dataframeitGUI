"use client";

import { useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Shuffle,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CopyLinkButton } from "@/components/ui/CopyLinkButton";
import { RunLlmButton } from "@/components/shared/RunLlmButton";
import { SuggestExclusionDialog } from "./SuggestExclusionDialog";
import { CURRENT_FILTER_VALUE, isCurrentFilter } from "@/lib/rounds";
import type { RoundFilterData, CodingSortMode } from "./CodingPage";

type DocSection =
  | {
      variant: "assigned";
      title: string;
      index: number;
      total: number;
      onNavigate: (index: number) => void;
      parecerUrl?: string;
      projectId: string;
      documentId: string;
    }
  | {
      variant: "browse";
      title: string;
      responseCount: number;
      onBack: () => void;
      onRandom: () => void;
      parecerUrl?: string;
      projectId: string;
      documentId: string;
    };

interface CodingHeaderProps {
  mode: "assigned" | "browse";
  onModeChange: (mode: "assigned" | "browse") => void;
  assignedCount: number;
  sortMode: CodingSortMode;
  onSortChange: (mode: CodingSortMode) => void;
  roundFilter?: RoundFilterData;
  doc?: DocSection;
  onToggleFullscreen: () => void;
}

export function CodingHeader({
  mode,
  onModeChange,
  assignedCount,
  sortMode,
  onSortChange,
  roundFilter,
  doc,
  onToggleFullscreen,
}: CodingHeaderProps) {
  const showRound = mode === "assigned" && roundFilter !== undefined;

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
      <Tabs
        value={mode}
        onValueChange={(v) => onModeChange(v as "assigned" | "browse")}
      >
        <TabsList className="h-7">
          <TabsTrigger value="assigned" className="h-6 text-xs">
            Atribuídos ({assignedCount})
          </TabsTrigger>
          <TabsTrigger value="browse" className="h-6 text-xs">
            Explorar
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "assigned" && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <SortSelect value={sortMode} onChange={onSortChange} />
        </>
      )}

      {showRound && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <RoundSelect data={roundFilter!} />
        </>
      )}

      {doc && (
        <>
          <Separator orientation="vertical" className="h-4" />
          {doc.variant === "assigned" ? (
            <AssignedDocSection
              doc={doc}
              onToggleFullscreen={onToggleFullscreen}
            />
          ) : (
            <BrowseDocSection
              doc={doc}
              onToggleFullscreen={onToggleFullscreen}
            />
          )}
        </>
      )}
    </div>
  );
}

function SortSelect({
  value,
  onChange,
}: {
  value: CodingSortMode;
  onChange: (mode: CodingSortMode) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-xs text-muted-foreground">Ordenar:</span>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as CodingSortMode)}
      >
        <SelectTrigger size="sm" className="h-6 w-auto min-w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Padrão</SelectItem>
          <SelectItem value="recent">Codificados recentemente</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function RoundSelect({ data }: { data: RoundFilterData }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const normalizedSelected = isCurrentFilter(data.selected)
    ? CURRENT_FILTER_VALUE
    : data.selected;

  const handleChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (isCurrentFilter(value)) {
      params.delete("round");
    } else {
      params.set("round", value);
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    });
  };

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-xs text-muted-foreground">Rodada:</span>
      <Select
        value={normalizedSelected}
        onValueChange={handleChange}
        disabled={isPending}
      >
        <SelectTrigger size="sm" className="h-6 w-auto min-w-[140px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CURRENT_FILTER_VALUE}>
            Atual ({data.currentRoundLabel}) — pendentes
          </SelectItem>
          <SelectItem value="all">Todas as rodadas</SelectItem>
          {data.strategy === "manual"
            ? data.rounds
                .filter((r) => r.id !== data.currentRoundKey)
                .map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))
            : data.previousVersions.map((v) => (
                <SelectItem key={v} value={v}>
                  Versão {v}
                </SelectItem>
              ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AssignedDocSection({
  doc,
  onToggleFullscreen,
}: {
  doc: Extract<DocSection, { variant: "assigned" }>;
  onToggleFullscreen: () => void;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className="truncate font-medium">{doc.title}</span>
        {doc.parecerUrl && <CopyLinkButton url={doc.parecerUrl} />}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 disabled:opacity-50"
          onClick={() => doc.onNavigate(doc.index - 1)}
          disabled={doc.index === 0}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="tabular-nums text-muted-foreground text-xs">
          {doc.index + 1}/{doc.total}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 disabled:opacity-50"
          onClick={() => doc.onNavigate(doc.index + 1)}
          disabled={doc.index === doc.total - 1}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <SuggestExclusionDialog
          projectId={doc.projectId}
          documentId={doc.documentId}
          documentTitle={doc.title}
          iconOnly
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 ml-1"
          onClick={onToggleFullscreen}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </>
  );
}

function BrowseDocSection({
  doc,
  onToggleFullscreen,
}: {
  doc: Extract<DocSection, { variant: "browse" }>;
  onToggleFullscreen: () => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        onClick={doc.onBack}
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className="truncate font-medium">{doc.title}</span>
        {doc.parecerUrl && <CopyLinkButton url={doc.parecerUrl} />}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Badge variant="secondary" className="text-xs">
          {doc.responseCount}{" "}
          {doc.responseCount === 1 ? "resposta" : "respostas"}
        </Badge>
        <RunLlmButton
          projectId={doc.projectId}
          documentId={doc.documentId}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={doc.onRandom}
        >
          <Shuffle className="h-4 w-4" />
        </Button>
        <SuggestExclusionDialog
          projectId={doc.projectId}
          documentId={doc.documentId}
          documentTitle={doc.title}
          iconOnly
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onToggleFullscreen}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </>
  );
}
