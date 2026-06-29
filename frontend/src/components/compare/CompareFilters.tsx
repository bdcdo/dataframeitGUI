"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Suspense, useCallback, useMemo, useTransition } from "react";
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
import { Loader2, SlidersHorizontal, X } from "lucide-react";
import {
  DEFAULT_COMPARE_FILTERS,
  readCompareFilters,
  type CompareFiltersValue,
} from "@/lib/compare-filters";
import {
  VERSION_FILTER_ALL,
  VERSION_FILTER_LATEST_MAJOR,
} from "@/lib/compare-version";

interface CompareFiltersProps {
  respondentNames: string[];
  // Piso default de "mín. humanos" derivado do automation_mode do projeto
  // (compareDefaultsForMode). Mantém o controle coerente com o filtro aplicado
  // no servidor — em compare_llm o default é 1, não o global 2.
  defaultMinHumans: number;
  // Default VIVO de versão da fila (compareDefaultsForMode → COMPARE_DEFAULT_
  // VERSION, "latest_major"). Sem ele o seletor usaria DEFAULT_COMPARE_FILTERS.
  // version ("all") e divergiria do servidor: exibiria "Todas as versões"
  // enquanto a fila já está em latest_major, e "Todas as versões" ficaria
  // inalcançável (o `update` apagaria o param por coincidir com o default). #247
  defaultVersion: string;
  availableVersions: string[]; // ["X.Y.Z", ...] ordered desc
  latestMajorLabel: string | null; // "1.0.0" ou null
}

export function CompareFilters(props: CompareFiltersProps) {
  // useSearchParams precisa de boundary de Suspense (react-doctor
  // nextjs-no-use-search-params-without-suspense).
  return (
    <Suspense fallback={null}>
      <CompareFiltersInner {...props} />
    </Suspense>
  );
}

function CompareFiltersInner({
  respondentNames,
  defaultMinHumans,
  defaultVersion,
  availableVersions,
  latestMajorLabel,
}: CompareFiltersProps) {
  const { push } = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  // Defaults coerentes com o que o servidor aplica (ambos derivados de
  // compareDefaultsForMode): o piso de humanos e o default de versão. Sem o
  // minHumans o filtro exibiria "2" enquanto a página lista docs de 1 humano em
  // compare_llm; sem a version exibiria "all" enquanto a fila já está em
  // latest_major — e, pior, selecionar "Todas as versões" apagaria o param (por
  // coincidir com o default) e a visão completa ficaria inalcançável (#247).
  const effectiveDefaults = useMemo(
    () => ({
      ...DEFAULT_COMPARE_FILTERS,
      minHumans: defaultMinHumans,
      version: defaultVersion,
    }),
    [defaultMinHumans, defaultVersion],
  );
  const current = readCompareFilters(searchParams, effectiveDefaults);

  const update = useCallback(
    (patch: Partial<CompareFiltersValue>) => {
      const sp = new URLSearchParams(searchParams.toString());
      const apply = { ...readCompareFilters(searchParams, effectiveDefaults), ...patch };
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
        const def = effectiveDefaults[key];
        if (value === def || value === "" || value === null) {
          sp.delete(urlKey);
        } else {
          sp.set(urlKey, String(value));
        }
      }
      startTransition(() => {
        push(`${pathname}?${sp.toString()}`);
      });
    },
    [pathname, push, searchParams, effectiveDefaults],
  );

  const reset = useCallback(() => {
    startTransition(() => {
      push(pathname);
    });
  }, [pathname, push]);

  const activeCount = [
    current.version !== effectiveDefaults.version,
    current.minHumans !== effectiveDefaults.minHumans,
    current.minTotal !== effectiveDefaults.minTotal,
    current.minAssignedPct !== effectiveDefaults.minAssignedPct,
    current.since !== effectiveDefaults.since,
    current.respondent !== effectiveDefaults.respondent,
  ].filter(Boolean).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          title="Filtros da fila de comparação"
          aria-busy={isPending}
        >
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <SlidersHorizontal className="size-3.5" />
          )}
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
                disabled={isPending}
              >
                <X className="size-3" />
                Limpar
              </Button>
            )}
          </div>

          {isPending && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Aplicando filtros…
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Desde a versão</Label>
            <Select
              value={current.version}
              onValueChange={(v) => update({ version: v })}
              disabled={isPending}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={VERSION_FILTER_ALL}>
                  Todas as versões
                </SelectItem>
                {/* Sempre renderizado: "latest_major" é o default VIVO (#247),
                    então precisa ter item correspondente mesmo se o label da
                    versão não vier — senão o Select controlado fica com `value`
                    sem option. O label da MAJOR aparece só quando disponível. */}
                <SelectItem value={VERSION_FILTER_LATEST_MAJOR}>
                  Última MAJOR{latestMajorLabel ? ` (${latestMajorLabel})` : ""}
                </SelectItem>
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
                disabled={isPending}
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
                disabled={isPending}
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
              disabled={isPending}
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
              disabled={isPending}
            />
          </div>

          {respondentNames.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Respondente</Label>
              <Select
                value={current.respondent}
                onValueChange={(v) => update({ respondent: v })}
                disabled={isPending}
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
