"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { DocPager } from "@/components/shared/DocPager";

export interface RespondentOption {
  id: string;
  name: string;
}

export type FilterValue = "pending" | "incorrect" | "questioned" | "all";

interface VerdictsHeaderProps {
  searchQuery: string;
  onSearchChange: (v: string) => void;
  filter: FilterValue;
  onFilterChange: (v: FilterValue) => void;
  totals: {
    items: number;
    incorrect: number;
    pending: number;
    questioned: number;
  };
  isCoordinator?: boolean;
  respondents: RespondentOption[];
  currentViewUserId?: string;
  onSelectRespondent: (userId: string | null) => void;
  isPending: boolean;
  docCount: number;
  docIndex: number;
  onNavigate: (index: number) => void;
}

export function VerdictsHeader({
  searchQuery,
  onSearchChange,
  filter,
  onFilterChange,
  totals,
  isCoordinator,
  respondents,
  currentViewUserId,
  onSelectRespondent,
  isPending,
  docCount,
  docIndex,
  onNavigate,
}: VerdictsHeaderProps) {
  return (
    <div className="border-b px-4 py-2 space-y-1.5">
      {/* Row 1: main filters + navigation */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Buscar documento..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-44 h-8 text-xs"
        />
        <Select value={filter} onValueChange={(v) => onFilterChange(v as FilterValue)}>
          <SelectTrigger className="w-48 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos ({totals.items})</SelectItem>
            <SelectItem value="incorrect">Incorretos ({totals.incorrect})</SelectItem>
            <SelectItem value="pending">Aguardando feedback ({totals.pending})</SelectItem>
            <SelectItem value="questioned">Com dúvida ({totals.questioned})</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {totals.items - totals.incorrect}/{totals.items} corretos
        </span>
        <div className="ml-auto flex items-center gap-1">
          {isCoordinator && respondents.length > 0 && (
            <Select
              value={currentViewUserId || "_self"}
              onValueChange={(v) => onSelectRespondent(v === "_self" ? null : v)}
              disabled={isPending}
            >
              <SelectTrigger className="w-40 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_self">Minhas respostas</SelectItem>
                {respondents.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {docCount > 0 && (
            <DocPager
              index={docIndex}
              total={docCount}
              onNavigate={onNavigate}
              buttonClassName="size-7"
            />
          )}
        </div>
      </div>
    </div>
  );
}
