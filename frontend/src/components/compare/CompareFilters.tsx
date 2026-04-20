"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { SlidersHorizontal, X } from "lucide-react";

export interface CompareFiltersValue {
  version: string; // "all" | "latest_major" | "X.Y.Z"
  minHumans: number;
  minTotal: number;
  minAssignedPct: number;
  since: string; // yyyy-mm-dd or ""
  respondent: string; // "all" or name
}

export const DEFAULT_COMPARE_FILTERS: CompareFiltersValue = {
  version: "latest_major",
  minHumans: 2,
  minTotal: 2,
  minAssignedPct: 50,
  since: "",
  respondent: "all",
};

export function readCompareFilters(
  params: URLSearchParams | Record<string, string | undefined>,
): CompareFiltersValue {
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    return params[k];
  };
  const toInt = (v: string | undefined, fallback: number) => {
    if (v === undefined) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    version: get("version") ?? DEFAULT_COMPARE_FILTERS.version,
    minHumans: toInt(get("min_humans"), DEFAULT_COMPARE_FILTERS.minHumans),
    minTotal: toInt(get("min_total"), DEFAULT_COMPARE_FILTERS.minTotal),
    minAssignedPct: toInt(
      get("min_assigned_pct"),
      DEFAULT_COMPARE_FILTERS.minAssignedPct,
    ),
    since: get("since") ?? DEFAULT_COMPARE_FILTERS.since,
    respondent: get("respondent") ?? DEFAULT_COMPARE_FILTERS.respondent,
  };
}

interface CompareFiltersProps {
  respondentNames: string[];
  availableVersions: string[]; // ["X.Y.Z", ...] ordered desc
  latestMajorLabel: string | null; // "1.0.0" ou null
}

export function CompareFilters({
  respondentNames,
  availableVersions,
  latestMajorLabel,
}: CompareFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const current = readCompareFilters(searchParams);

  const update = useCallback(
    (patch: Partial<CompareFiltersValue>) => {
      const sp = new URLSearchParams(searchParams.toString());
      const apply = { ...current, ...patch };
      const map: Record<keyof CompareFiltersValue, string> = {
        version: "version",
        minHumans: "min_humans",
        minTotal: "min_total",
        minAssignedPct: "min_assigned_pct",
        since: "since",
        respondent: "respondent",
      };
      for (const key of Object.keys(map) as (keyof CompareFiltersValue)[]) {
        const urlKey = map[key];
        const value = apply[key];
        const def = DEFAULT_COMPARE_FILTERS[key];
        if (value === def || value === "" || value === null) {
          sp.delete(urlKey);
        } else {
          sp.set(urlKey, String(value));
        }
      }
      router.push(`${pathname}?${sp.toString()}`);
    },
    [current, pathname, router, searchParams],
  );

  const reset = useCallback(() => {
    router.push(pathname);
  }, [pathname, router]);

  const activeCount = [
    current.version !== DEFAULT_COMPARE_FILTERS.version,
    current.minHumans !== DEFAULT_COMPARE_FILTERS.minHumans,
    current.minTotal !== DEFAULT_COMPARE_FILTERS.minTotal,
    current.minAssignedPct !== DEFAULT_COMPARE_FILTERS.minAssignedPct,
    current.since !== DEFAULT_COMPARE_FILTERS.since,
    current.respondent !== DEFAULT_COMPARE_FILTERS.respondent,
  ].filter(Boolean).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          title="Filtros da fila de comparação"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filtros
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-0.5 h-4 px-1 text-[10px]">
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">Filtros da fila</h4>
            {activeCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={reset}
              >
                <X className="h-3 w-3" />
                Limpar
              </Button>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Desde a versão</Label>
            <Select
              value={current.version}
              onValueChange={(v) => update({ version: v })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as versões</SelectItem>
                {latestMajorLabel && (
                  <SelectItem value="latest_major">
                    Última MAJOR ({latestMajorLabel})
                  </SelectItem>
                )}
                {availableVersions.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Respostas anteriores continuam salvas mas não entram na fila.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Mín. humanos</Label>
              <Select
                value={String(current.minHumans)}
                onValueChange={(v) =>
                  update({ minHumans: Number.parseInt(v, 10) })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0</SelectItem>
                  <SelectItem value="1">1</SelectItem>
                  <SelectItem value="2">2</SelectItem>
                  <SelectItem value="3">3+</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Mín. respostas</Label>
              <Select
                value={String(current.minTotal)}
                onValueChange={(v) =>
                  update({ minTotal: Number.parseInt(v, 10) })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0</SelectItem>
                  <SelectItem value="1">1</SelectItem>
                  <SelectItem value="2">2</SelectItem>
                  <SelectItem value="3">3+</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">% atribuídos que responderam</Label>
            <Select
              value={String(current.minAssignedPct)}
              onValueChange={(v) =>
                update({ minAssignedPct: Number.parseInt(v, 10) })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Qualquer</SelectItem>
                <SelectItem value="50">≥ 50%</SelectItem>
                <SelectItem value="80">≥ 80%</SelectItem>
                <SelectItem value="100">100%</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Desde a data</Label>
            <Input
              type="date"
              value={current.since}
              onChange={(e) => update({ since: e.target.value })}
              className="h-8 text-xs"
            />
          </div>

          {respondentNames.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Respondente</Label>
              <Select
                value={current.respondent}
                onValueChange={(v) => update({ respondent: v })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {respondentNames.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
