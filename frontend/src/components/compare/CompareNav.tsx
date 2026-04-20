"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyLinkButton } from "@/components/ui/CopyLinkButton";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import { CompareFieldFilter } from "./CompareFieldFilter";
import { CompareFilters } from "./CompareFilters";
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
  respondentNames: string[];
  availableVersions: string[];
  latestMajorLabel: string | null;
  currentProjectVersion: string;
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
  respondentNames,
  availableVersions,
  latestMajorLabel,
  currentProjectVersion,
  projectId,
  documentId,
}: CompareNavProps) {
  return (
    <div className="flex h-10 items-center justify-between border-b px-4 text-sm shrink-0">
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate font-medium">{title}</span>
        {parecerUrl && <CopyLinkButton url={parecerUrl} />}
        <Badge
          variant="outline"
          className="ml-2 h-5 shrink-0 px-1.5 text-[10px] font-mono"
          title="Versão atual do schema do projeto"
        >
          v{currentProjectVersion}
        </Badge>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className="text-xs">
          {reviewedDocsCount}/{totalDocs} docs
        </Badge>
        <CompareFilters
          respondentNames={respondentNames}
          availableVersions={availableVersions}
          latestMajorLabel={latestMajorLabel}
        />
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
