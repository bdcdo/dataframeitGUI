"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { LotteryDocStats } from "@/lib/lottery-utils";
import { toggleInSet } from "@/lib/utils";

interface DocumentPickerListProps {
  docs: LotteryDocStats[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}

/**
 * Lista pesquisável para seleção manual de documentos do sorteio (US5).
 * Busca client-side sobre as stats já carregadas; sem virtualização —
 * max-h + scroll basta para a escala-alvo (research D6).
 */
export function DocumentPickerList({
  docs,
  selected,
  onChange,
}: DocumentPickerListProps) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) =>
        d.title?.toLowerCase().includes(q) ||
        d.externalId?.toLowerCase().includes(q)
    );
  }, [docs, query]);

  const toggle = (docId: string, checked: boolean) => {
    onChange(toggleInSet(selected, docId, checked));
  };

  return (
    <div className="space-y-2">
      <Input
        placeholder="Buscar por título ou identificador..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Buscar documentos"
      />
      <p className="text-xs text-muted-foreground">
        {selected.size} selecionados
      </p>
      <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border p-2">
        {visible.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            Nenhum documento encontrado.
          </p>
        ) : (
          visible.map((d) => (
            <div key={d.id} className="flex items-center gap-2">
              <Checkbox
                id={`pick-${d.id}`}
                checked={selected.has(d.id)}
                onCheckedChange={(checked) => toggle(d.id, checked === true)}
              />
              <Label
                htmlFor={`pick-${d.id}`}
                className="truncate font-normal"
                title={d.title || d.externalId || d.id}
              >
                {d.title || d.externalId || d.id.slice(0, 8)}
                {d.title && d.externalId && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {d.externalId}
                  </span>
                )}
              </Label>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
