"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { FieldChangeDiff } from "./FieldChangeDiff";
import {
  formatRelativeDate,
  formatVersion,
  type ChangeGroup,
} from "@/lib/schema-change-utils";
import type { SchemaChangeType } from "@/lib/types";

interface SchemaChangeGroupProps {
  group: ChangeGroup;
}

const TYPE_BADGE: Record<SchemaChangeType, string> = {
  major: "bg-brand/15 text-brand border-brand/30",
  minor: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  patch: "bg-muted text-muted-foreground border-muted-foreground/20",
  initial: "bg-violet-500/10 text-violet-700 border-violet-500/30",
};

const TYPE_LABEL: Record<SchemaChangeType, string> = {
  major: "MAJOR",
  minor: "MINOR",
  patch: "PATCH",
  initial: "INITIAL",
};

const DOT_COLOR: Record<SchemaChangeType, string> = {
  major: "bg-brand",
  minor: "bg-blue-500",
  patch: "bg-muted-foreground/40",
  initial: "bg-violet-500",
};

export function SchemaChangeGroup({ group }: SchemaChangeGroupProps) {
  const fieldCount = group.entries.length;
  const { changeType } = group;

  // Expandir por padrão se commit pequeno
  const defaultExpanded = fieldCount <= 3;

  return (
    <div className="relative pl-6">
      {/* Linha + dot da timeline */}
      <span
        className="absolute left-[7px] top-0 bottom-0 w-px bg-border"
        aria-hidden
      />
      <span
        className={cn(
          "absolute left-0 top-[6px] h-3.5 w-3.5 rounded-full ring-4 ring-background",
          changeType ? DOT_COLOR[changeType] : "bg-muted-foreground/30",
        )}
        aria-hidden
      />

      <div className="flex flex-wrap items-center gap-2 pb-1">
        <Badge
          variant="outline"
          className="h-5 px-1.5 py-0 font-mono text-[11px]"
          title={
            group.version
              ? `${formatVersion(group.version)} após esta mudança`
              : "Sem versão"
          }
        >
          {formatVersion(group.version)}
        </Badge>
        {changeType && (
          <Badge
            className={cn(
              "h-5 border px-1.5 py-0 text-[10px] font-medium",
              TYPE_BADGE[changeType],
            )}
          >
            {TYPE_LABEL[changeType]}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{group.changedBy}</span>
          <span className="mx-1.5">·</span>
          <span title={new Date(group.createdAt).toLocaleString("pt-BR")}>
            {formatRelativeDate(group.createdAt)}
          </span>
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {fieldCount} {fieldCount === 1 ? "campo" : "campos"}
        </span>
      </div>

      <div className="space-y-1 pb-6">
        {group.entries.map((entry) => (
          <FieldChangeDiff
            key={entry.id}
            entry={entry}
            defaultExpanded={defaultExpanded}
          />
        ))}
      </div>
    </div>
  );
}
