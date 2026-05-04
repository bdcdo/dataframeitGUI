"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { History, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { SchemaChangeGroup } from "./SchemaChangeGroup";
import {
  groupChangesByCommit,
  type ChangeGroup,
} from "@/lib/schema-change-utils";
import type { SchemaChangeEntry, SchemaChangeType } from "@/lib/types";

interface SchemaHistoryViewProps {
  entries: SchemaChangeEntry[];
  fieldOptions: { name: string; description: string }[];
  truncated?: boolean;
  limit?: number;
}

type TypeFilter = "all" | SchemaChangeType;

const TYPE_BUTTONS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "major", label: "Major" },
  { value: "minor", label: "Minor" },
  { value: "patch", label: "Patch" },
  { value: "initial", label: "Initial" },
];

export function SchemaHistoryView({
  entries,
  fieldOptions,
  truncated = false,
  limit = 200,
}: SchemaHistoryViewProps) {
  const [search, setSearch] = useState("");
  const [fieldFilter, setFieldFilter] = useState("all");
  const [authorFilter, setAuthorFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.changedBy) set.add(e.changedBy);
    }
    return Array.from(set).sort();
  }, [entries]);

  const fieldDescriptionMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of fieldOptions) m.set(f.name, f.description || f.name);
    return m;
  }, [fieldOptions]);

  const filtered: SchemaChangeEntry[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (fieldFilter !== "all" && e.fieldName !== fieldFilter) return false;
      if (authorFilter !== "all" && e.changedBy !== authorFilter) return false;
      if (typeFilter !== "all" && e.changeType !== typeFilter) return false;
      if (!q) return true;
      const haystackParts = [
        e.fieldName,
        e.changeSummary,
        fieldDescriptionMap.get(e.fieldName) ?? "",
        JSON.stringify(e.beforeValue ?? {}),
        JSON.stringify(e.afterValue ?? {}),
        e.changedBy,
      ];
      return haystackParts.join(" ").toLowerCase().includes(q);
    });
  }, [entries, search, fieldFilter, authorFilter, typeFilter, fieldDescriptionMap]);

  const groups: ChangeGroup[] = useMemo(
    () => groupChangesByCommit(filtered),
    [filtered],
  );

  const totalEntries = entries.length;
  const filteredEntries = filtered.length;
  const activeFilters =
    search.trim() !== "" ||
    fieldFilter !== "all" ||
    authorFilter !== "all" ||
    typeFilter !== "all";

  if (totalEntries === 0) {
    return <EmptyState reason="empty" />;
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 space-y-2 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Buscar por campo, autor ou conteúdo..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-64"
          />
          <Select value={fieldFilter} onValueChange={setFieldFilter}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="Campo" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os campos</SelectItem>
              {fieldOptions.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.description || f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={authorFilter} onValueChange={setAuthorFilter}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="Autor" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os autores</SelectItem>
              {authors.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5">
            {TYPE_BUTTONS.map((b) => (
              <Button
                key={b.value}
                variant="ghost"
                size="sm"
                onClick={() => setTypeFilter(b.value)}
                className={cn(
                  "h-7 px-2 text-xs",
                  typeFilter === b.value && "bg-background shadow-sm",
                )}
              >
                {b.label}
              </Button>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted-foreground">
            {filteredEntries} {filteredEntries === 1 ? "mudança" : "mudanças"}
            {" em "}
            {groups.length} {groups.length === 1 ? "commit" : "commits"}
            {activeFilters && filteredEntries !== totalEntries
              ? ` (de ${totalEntries})`
              : ""}
          </span>
        </div>
        {truncated && (
          <div className="flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span>
              Mostrando as últimas {limit} mudanças. Use os filtros (campo, autor, tipo) para
              localizar entradas mais antigas.
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4">
        {groups.length === 0 ? (
          <EmptyState reason={activeFilters ? "filtered" : "empty"} />
        ) : (
          <div className="mx-auto max-w-3xl">
            {groups.map((g) => (
              <SchemaChangeGroup key={g.key} group={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ reason }: { reason: "empty" | "filtered" }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <History className="h-6 w-6 text-muted-foreground" />
      </div>
      {reason === "empty" ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">Nenhuma mudança registrada ainda</p>
          <p className="text-xs text-muted-foreground">
            Edite o schema para começar a versionar.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-sm font-medium">Nenhum commit encontrado</p>
          <p className="text-xs text-muted-foreground">
            Tente ajustar os filtros ou a busca.
          </p>
        </div>
      )}
    </div>
  );
}
