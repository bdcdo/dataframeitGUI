"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface SuggestionDiffProps {
  changes: {
    description?: string;
    help_text?: string | null;
    options?: string[] | null;
  };
  current: {
    description: string;
    help_text: string | null;
    options: string[] | null;
  };
}

function emptyMark(value: string) {
  return value.length > 0 ? value : "(vazio)";
}

export function SuggestionDiff({ changes, current }: SuggestionDiffProps) {
  const hasDescription = changes.description !== undefined;
  const hasHelpText = changes.help_text !== undefined;
  const hasOptions = changes.options !== undefined;

  if (!hasDescription && !hasHelpText && !hasOptions) return null;

  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs space-y-2">
      {hasDescription && (
        <div className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Descrição
          </span>
          <div className="leading-relaxed break-words">
            <del className="text-muted-foreground">
              {emptyMark(current.description)}
            </del>
            <span className="mx-1.5 text-muted-foreground">→</span>
            <ins className="font-medium text-foreground no-underline">
              {emptyMark(changes.description ?? "")}
            </ins>
          </div>
        </div>
      )}

      {hasHelpText && (
        <div className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Instruções complementares
          </span>
          <div className="grid gap-1">
            <div className="rounded border border-dashed bg-background/40 px-2 py-1">
              <span className="text-[10px] font-medium text-muted-foreground">
                Atual
              </span>
              <del className="block whitespace-pre-wrap break-words text-muted-foreground">
                {emptyMark(current.help_text ?? "")}
              </del>
            </div>
            <div className="rounded border border-dashed border-brand/40 bg-brand/5 px-2 py-1">
              <span className="text-[10px] font-medium text-brand">
                Proposto
              </span>
              <ins className="block whitespace-pre-wrap break-words font-medium text-foreground no-underline">
                {emptyMark(changes.help_text ?? "")}
              </ins>
            </div>
          </div>
        </div>
      )}

      {hasOptions && (
        <div className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Opções
          </span>
          <OptionsDiff
            current={current.options ?? []}
            proposed={changes.options ?? null}
          />
        </div>
      )}
    </div>
  );
}

function OptionsDiff({
  current,
  proposed,
}: {
  current: string[];
  proposed: string[] | null;
}) {
  const isClear = proposed === null || proposed.length === 0;
  const proposedSet = new Set(proposed ?? []);
  const currentSet = new Set(current);

  const removed = current.filter((o) => !proposedSet.has(o));
  const added = (proposed ?? []).filter((o) => !currentSet.has(o));
  const kept = current.filter((o) => proposedSet.has(o));

  if (isClear && current.length === 0) {
    return (
      <p className="text-muted-foreground italic">
        Sem opções (sem alteração visível).
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {isClear && (
        <Badge
          aria-label="Todas as opções serão removidas"
          className={cn(
            "text-[10px] px-1.5 py-0 font-normal",
            "bg-red-500/10 text-red-700",
          )}
        >
          Limpar opções
        </Badge>
      )}
      {kept.map((o) => (
        <Badge
          key={`kept-${o}`}
          variant="outline"
          className="text-[10px] px-1.5 py-0 font-normal break-all"
        >
          {o}
        </Badge>
      ))}
      {removed.map((o) => (
        <Badge
          key={`rem-${o}`}
          aria-label={`Opção removida: ${o}`}
          className={cn(
            "text-[10px] px-1.5 py-0 font-normal break-all",
            "bg-red-500/10 text-red-700",
          )}
        >
          <del>{o}</del>
        </Badge>
      ))}
      {added.map((o) => (
        <Badge
          key={`add-${o}`}
          aria-label={`Opção adicionada: ${o}`}
          className={cn(
            "text-[10px] px-1.5 py-0 font-normal break-all",
            "bg-green-500/10 text-green-700",
          )}
        >
          <ins className="no-underline">+ {o}</ins>
        </Badge>
      ))}
    </div>
  );
}
