"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, Plus, Minus, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  detectFieldChangeKind,
  diffPydanticField,
  formatCondition,
  formatTarget,
  formatType,
  propertyLabel,
  type FieldChangeKind,
  type FieldPropertyDiff,
} from "@/lib/schema-change-utils";
import type { SchemaChangeEntry, FieldCondition, SubfieldDef } from "@/lib/types";

interface FieldChangeDiffProps {
  entry: SchemaChangeEntry;
  defaultExpanded?: boolean;
}

export function FieldChangeDiff({ entry, defaultExpanded = true }: FieldChangeDiffProps) {
  const kind = detectFieldChangeKind(entry);
  const diffs = diffPydanticField(entry.beforeValue, entry.afterValue);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const beforeName =
    (entry.beforeValue?.name as string | undefined) ?? entry.fieldName;
  const afterName =
    (entry.afterValue?.name as string | undefined) ?? entry.fieldName;

  const displayName =
    kind === "renamed" ? (
      <span className="font-mono text-xs">
        <span className="text-muted-foreground line-through">{beforeName}</span>
        <ArrowRight className="mx-1 inline h-3 w-3 text-muted-foreground" />
        <span className="font-medium text-foreground">{afterName}</span>
      </span>
    ) : (
      <span className="font-mono text-xs font-medium text-foreground">
        {kind === "added" ? afterName : beforeName}
      </span>
    );

  const bodyVisible = expanded && (diffs.length > 0 || kind === "added" || kind === "removed");

  return (
    <div className="group">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted/40"
      >
        <KindIcon kind={kind} />
        {displayName}
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {diffs.map((d) => (
            <Badge
              key={d.property}
              variant="outline"
              className="h-4 px-1.5 py-0 text-[10px] font-normal"
            >
              {propertyLabel(d.property)}
            </Badge>
          ))}
          {kind === "added" && diffs.length === 0 && (
            <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px] font-normal">
              novo campo
            </Badge>
          )}
          {kind === "removed" && diffs.length === 0 && (
            <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px] font-normal">
              removido
            </Badge>
          )}
        </div>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {bodyVisible && (
        <div className="ml-6 mt-1 space-y-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
          {kind === "added" && (
            <FieldSnapshot data={entry.afterValue} variant="added" />
          )}
          {kind === "removed" && (
            <FieldSnapshot data={entry.beforeValue} variant="removed" />
          )}
          {diffs.map((d) => (
            <PropertyDiff key={d.property} diff={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function KindIcon({ kind }: { kind: FieldChangeKind }) {
  if (kind === "added") {
    return (
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
          "bg-green-500/15 text-green-700",
        )}
        aria-label="Campo novo"
      >
        <Plus className="h-3 w-3" />
      </span>
    );
  }
  if (kind === "removed") {
    return (
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
          "bg-red-500/15 text-red-700",
        )}
        aria-label="Campo removido"
      >
        <Minus className="h-3 w-3" />
      </span>
    );
  }
  if (kind === "renamed") {
    return (
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
          "bg-blue-500/15 text-blue-700",
        )}
        aria-label="Campo renomeado"
      >
        <ArrowRight className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
      aria-label="Campo modificado"
    >
      •
    </span>
  );
}

function PropertyDiff({ diff }: { diff: FieldPropertyDiff }) {
  const label = propertyLabel(diff.property);

  if (diff.property === "options") {
    return (
      <DiffSection label={label}>
        <OptionsListDiff
          before={diff.before as string[] | null}
          after={diff.after as string[] | null}
        />
      </DiffSection>
    );
  }
  if (diff.property === "subfields") {
    return (
      <DiffSection label={label}>
        <SubfieldsDiff
          before={diff.before as SubfieldDef[] | null}
          after={diff.after as SubfieldDef[] | null}
        />
      </DiffSection>
    );
  }
  if (
    diff.property === "help_text" ||
    diff.property === "justification_prompt"
  ) {
    return (
      <DiffSection label={label}>
        <HelpTextDiff
          before={(diff.before as string | null) ?? ""}
          after={(diff.after as string | null) ?? ""}
        />
      </DiffSection>
    );
  }
  if (diff.property === "condition") {
    return (
      <DiffSection label={label}>
        <InlineDiff
          before={formatCondition(diff.before as FieldCondition | null)}
          after={formatCondition(diff.after as FieldCondition | null)}
        />
      </DiffSection>
    );
  }
  if (diff.property === "type") {
    return (
      <DiffSection label={label}>
        <PillDiff before={formatType(diff.before)} after={formatType(diff.after)} />
      </DiffSection>
    );
  }
  if (diff.property === "target") {
    return (
      <DiffSection label={label}>
        <PillDiff before={formatTarget(diff.before)} after={formatTarget(diff.after)} />
      </DiffSection>
    );
  }
  if (diff.property === "required" || diff.property === "allow_other") {
    return (
      <DiffSection label={label}>
        <PillDiff
          before={diff.before ? "Sim" : "Não"}
          after={diff.after ? "Sim" : "Não"}
        />
      </DiffSection>
    );
  }
  if (diff.property === "subfield_rule") {
    const map: Record<string, string> = {
      all: "Todos obrigatórios",
      at_least_one: "Pelo menos um",
    };
    return (
      <DiffSection label={label}>
        <PillDiff
          before={map[diff.before as string] ?? "—"}
          after={map[diff.after as string] ?? "—"}
        />
      </DiffSection>
    );
  }
  // name, description (texto curto)
  return (
    <DiffSection label={label}>
      <InlineDiff
        before={String(diff.before ?? "")}
        after={String(diff.after ?? "")}
      />
    </DiffSection>
  );
}

function DiffSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}

function emptyMark(value: string): string {
  return value.length > 0 ? value : "(vazio)";
}

function InlineDiff({ before, after }: { before: string; after: string }) {
  return (
    <div className="leading-relaxed break-words">
      <del className="text-muted-foreground">{emptyMark(before)}</del>
      <span className="mx-1.5 text-muted-foreground">→</span>
      <ins className="font-medium text-foreground no-underline">
        {emptyMark(after)}
      </ins>
    </div>
  );
}

function HelpTextDiff({ before, after }: { before: string; after: string }) {
  return (
    <div className="grid gap-1">
      <div className="rounded border border-dashed bg-background/40 px-2 py-1">
        <span className="text-[10px] font-medium text-muted-foreground">Antes</span>
        <del className="block whitespace-pre-wrap break-words text-muted-foreground">
          {emptyMark(before)}
        </del>
      </div>
      <div className="rounded border border-dashed border-brand/40 bg-brand/5 px-2 py-1">
        <span className="text-[10px] font-medium text-brand">Depois</span>
        <ins className="block whitespace-pre-wrap break-words font-medium text-foreground no-underline">
          {emptyMark(after)}
        </ins>
      </div>
    </div>
  );
}

function PillDiff({ before, after }: { before: string; after: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Badge
        variant="outline"
        className="h-5 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
      >
        <del className="no-underline">{before}</del>
      </Badge>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <Badge className="h-5 bg-brand/10 px-1.5 py-0 text-[10px] font-medium text-brand hover:bg-brand/10">
        {after}
      </Badge>
    </div>
  );
}

function OptionsListDiff({
  before,
  after,
}: {
  before: string[] | null;
  after: string[] | null;
}) {
  const beforeArr = before ?? [];
  const afterArr = after ?? [];
  const afterSet = new Set(afterArr);
  const beforeSet = new Set(beforeArr);
  const removed = beforeArr.filter((o) => !afterSet.has(o));
  const added = afterArr.filter((o) => !beforeSet.has(o));
  const kept = beforeArr.filter((o) => afterSet.has(o));

  if (removed.length === 0 && added.length === 0 && kept.length === 0) {
    return <span className="italic text-muted-foreground">(sem opções)</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {kept.map((o) => (
        <Badge
          key={`kept-${o}`}
          variant="outline"
          className="text-[10px] px-1.5 py-0 font-normal break-words"
        >
          {o}
        </Badge>
      ))}
      {removed.map((o) => (
        <Badge
          key={`rem-${o}`}
          aria-label={`Opção removida: ${o}`}
          className={cn(
            "text-[10px] px-1.5 py-0 font-normal break-words",
            "bg-red-500/10 text-red-700 hover:bg-red-500/10",
          )}
        >
          <del className="no-underline">− {o}</del>
        </Badge>
      ))}
      {added.map((o) => (
        <Badge
          key={`add-${o}`}
          aria-label={`Opção adicionada: ${o}`}
          className={cn(
            "text-[10px] px-1.5 py-0 font-normal break-words",
            "bg-green-500/10 text-green-700 hover:bg-green-500/10",
          )}
        >
          <ins className="no-underline">+ {o}</ins>
        </Badge>
      ))}
    </div>
  );
}

function SubfieldsDiff({
  before,
  after,
}: {
  before: SubfieldDef[] | null;
  after: SubfieldDef[] | null;
}) {
  const beforeArr = before ?? [];
  const afterArr = after ?? [];
  const afterMap = new Map(afterArr.map((s) => [s.key, s]));
  const beforeMap = new Map(beforeArr.map((s) => [s.key, s]));
  const removed = beforeArr.filter((s) => !afterMap.has(s.key));
  const added = afterArr.filter((s) => !beforeMap.has(s.key));
  const kept = beforeArr.filter((s) => afterMap.has(s.key));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {kept.map((s) => (
        <Badge
          key={`kept-${s.key}`}
          variant="outline"
          className="text-[10px] px-1.5 py-0 font-normal break-words"
        >
          {s.label || s.key}
        </Badge>
      ))}
      {removed.map((s) => (
        <Badge
          key={`rem-${s.key}`}
          className={cn(
            "text-[10px] px-1.5 py-0 font-normal break-words",
            "bg-red-500/10 text-red-700 hover:bg-red-500/10",
          )}
        >
          <del className="no-underline">− {s.label || s.key}</del>
        </Badge>
      ))}
      {added.map((s) => (
        <Badge
          key={`add-${s.key}`}
          className={cn(
            "text-[10px] px-1.5 py-0 font-normal break-words",
            "bg-green-500/10 text-green-700 hover:bg-green-500/10",
          )}
        >
          <ins className="no-underline">+ {s.label || s.key}</ins>
        </Badge>
      ))}
    </div>
  );
}

function FieldSnapshot({
  data,
  variant,
}: {
  data: Record<string, unknown>;
  variant: "added" | "removed";
}) {
  const tone =
    variant === "added"
      ? "border-green-500/30 bg-green-500/5"
      : "border-red-500/30 bg-red-500/5";

  const rows: { label: string; value: string }[] = [];
  if (data.description)
    rows.push({ label: "descrição", value: String(data.description) });
  if (data.type) rows.push({ label: "tipo", value: formatType(data.type) });
  if (data.target) rows.push({ label: "alvo", value: formatTarget(data.target) });
  if (typeof data.required === "boolean")
    rows.push({ label: "obrigatório", value: data.required ? "Sim" : "Não" });
  if (data.help_text)
    rows.push({ label: "instruções", value: String(data.help_text) });
  if (Array.isArray(data.options) && (data.options as string[]).length > 0)
    rows.push({
      label: "opções",
      value: (data.options as string[]).join(", "),
    });
  if (data.condition)
    rows.push({
      label: "condição",
      value: formatCondition(data.condition as FieldCondition),
    });
  if (data.justification_prompt)
    rows.push({
      label: "prompt de justificativa",
      value: String(data.justification_prompt),
    });

  if (rows.length === 0) return null;

  return (
    <div className={cn("space-y-0.5 rounded border px-2 py-1.5", tone)}>
      {rows.map((r) => (
        <div key={r.label} className="flex gap-2 text-[11px] leading-snug">
          <span className="shrink-0 text-muted-foreground">{r.label}:</span>
          <span className="break-words text-foreground">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
