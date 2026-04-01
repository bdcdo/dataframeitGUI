"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CopyLinkButton } from "@/components/ui/CopyLinkButton";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import { CompareFieldFilter } from "./CompareFieldFilter";
import { RespondentFilter } from "./RespondentFilter";
import { RunLlmButton } from "@/components/shared/RunLlmButton";
import type { PydanticField } from "@/lib/types";

interface CompareNavProps {
  title: string;
  docIndex: number;
  totalDocs: number;
  onDocNavigate: (index: number) => void;
  filter: string;
  onFilterChange: (value: string) => void;
  fields: PydanticField[];
  reviewedDocsCount: number;
  onToggleFullscreen: () => void;
  parecerUrl?: string;
  showConcordant: boolean;
  onToggleConcordant: (value: boolean) => void;
  respondentFilter?: string;
  onRespondentFilterChange?: (value: string) => void;
  respondentNames?: string[];
  projectId?: string;
  documentId?: string;
}

export function CompareNav({
  title,
  docIndex,
  totalDocs,
  onDocNavigate,
  filter,
  onFilterChange,
  fields,
  reviewedDocsCount,
  onToggleFullscreen,
  parecerUrl,
  showConcordant,
  onToggleConcordant,
  respondentFilter,
  onRespondentFilterChange,
  respondentNames,
  projectId,
  documentId,
}: CompareNavProps) {
  return (
    <div className="flex h-10 items-center justify-between border-b px-4 text-sm shrink-0">
      <div className="flex items-center gap-1 min-w-0">
        <span className="truncate font-medium">{title}</span>
        {parecerUrl && <CopyLinkButton url={parecerUrl} />}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge variant="secondary" className="text-xs">
          {reviewedDocsCount}/{totalDocs} docs
        </Badge>
        <div className="flex items-center gap-1.5">
          <Switch
            id="show-concordant"
            checked={showConcordant}
            onCheckedChange={onToggleConcordant}
            className="h-4 w-7 [&>span]:h-3 [&>span]:w-3"
          />
          <Label htmlFor="show-concordant" className="cursor-pointer text-xs text-muted-foreground">
            Todos
          </Label>
        </div>
        {respondentNames && onRespondentFilterChange && (
          <RespondentFilter
            value={respondentFilter ?? "all"}
            onChange={onRespondentFilterChange}
            respondentNames={respondentNames}
          />
        )}
        <CompareFieldFilter value={filter} onChange={onFilterChange} fields={fields} />
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onDocNavigate(docIndex - 1)} disabled={docIndex === 0}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">{docIndex + 1}/{totalDocs}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onDocNavigate(docIndex + 1)} disabled={docIndex === totalDocs - 1}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {projectId && documentId && (
          <RunLlmButton projectId={projectId} documentId={documentId} />
        )}
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onToggleFullscreen} title="Tela cheia">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
