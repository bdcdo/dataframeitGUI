"use client";

import { useState, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Bot, User, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PydanticField } from "@/lib/types";
import type { RespondentProfileData } from "@/app/(app)/projects/[id]/stats/reviews/page";

interface RespondentProfileProps {
  respondentProfiles: RespondentProfileData[];
  fields: PydanticField[];
}

type SortKey = "name" | "accuracy";

export function RespondentProfile({
  respondentProfiles,
  fields,
}: RespondentProfileProps) {
  const [sortKey, setSortKey] = useState<SortKey>("accuracy");
  const [sortAsc, setSortAsc] = useState(false);

  const sorted = useMemo(() => {
    const list = [...respondentProfiles];
    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "accuracy") {
        cmp = a.overallAccuracy - b.overallAccuracy;
      } else {
        cmp = a.respondentName.localeCompare(b.respondentName);
      }
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [respondentProfiles, sortKey, sortAsc]);

  // Campos com dados para mostrar barras
  const displayFields = useMemo(() => {
    return fields.filter((f) =>
      respondentProfiles.some((rp) => rp.perField[f.name]?.total > 0),
    );
  }, [fields, respondentProfiles]);

  if (respondentProfiles.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhum respondente com dados de revisão disponíveis.
      </p>
    );
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === "name");
    }
  };

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="px-2 py-2 text-left">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto p-0 text-xs font-medium"
                  onClick={() => toggleSort("name")}
                >
                  Respondente
                  <ArrowUpDown className="ml-1 h-3 w-3" />
                </Button>
              </th>
              <th className="px-2 py-2 text-center text-xs font-medium">
                Tipo
              </th>
              <th className="px-2 py-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto p-0 text-xs font-medium"
                  onClick={() => toggleSort("accuracy")}
                >
                  Acurácia
                  <ArrowUpDown className="ml-1 h-3 w-3" />
                </Button>
              </th>
              {displayFields.map((f) => (
                <th
                  key={f.name}
                  className="max-w-[80px] truncate px-2 py-2 text-center text-xs font-medium"
                  title={f.description}
                >
                  {f.description.length > 12
                    ? f.description.slice(0, 12) + "…"
                    : f.description}
                </th>
              ))}
              <th className="px-2 py-2 text-left text-xs font-medium">
                Mais erros
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((rp) => (
              <tr key={rp.respondentKey} className="border-b last:border-0">
                <td className="px-2 py-2 font-medium">{rp.respondentName}</td>
                <td className="px-2 py-2 text-center">
                  {rp.respondentType === "llm" ? (
                    <Badge variant="secondary" className="gap-1">
                      <Bot className="h-3 w-3" />
                      LLM
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1">
                      <User className="h-3 w-3" />
                      Humano
                    </Badge>
                  )}
                </td>
                <td className="px-2 py-2 text-center">
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className={cn(
                        "text-sm font-bold tabular-nums",
                        rp.overallAccuracy >= 80
                          ? "text-emerald-600"
                          : rp.overallAccuracy >= 50
                            ? "text-amber-600"
                            : "text-red-600",
                      )}
                    >
                      {rp.overallAccuracy}%
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {rp.overallCorrect}/{rp.overallTotal}
                    </span>
                  </div>
                </td>
                {displayFields.map((f) => {
                  const pf = rp.perField[f.name];
                  if (!pf || pf.total === 0) {
                    return (
                      <td
                        key={f.name}
                        className="px-2 py-2 text-center text-xs text-muted-foreground"
                      >
                        —
                      </td>
                    );
                  }
                  return (
                    <td key={f.name} className="px-2 py-2">
                      <div className="flex flex-col items-center gap-0.5">
                        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              pf.accuracy >= 80
                                ? "bg-emerald-500"
                                : pf.accuracy >= 50
                                  ? "bg-amber-500"
                                  : "bg-red-500",
                            )}
                            style={{ width: `${pf.accuracy}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {pf.accuracy}%
                        </span>
                      </div>
                    </td>
                  );
                })}
                <td className="px-2 py-2">
                  <div className="flex flex-wrap gap-1">
                    {rp.mostErroredFields.map((mf) => (
                      <span
                        key={mf.fieldName}
                        className="inline-block max-w-[120px] truncate text-xs text-red-600 dark:text-red-400"
                        title={`${mf.fieldDescription}: ${mf.errorRate}% de erro`}
                      >
                        {mf.fieldDescription.length > 15
                          ? mf.fieldDescription.slice(0, 15) + "…"
                          : mf.fieldDescription}{" "}
                        ({mf.errorRate}%)
                      </span>
                    ))}
                    {rp.mostErroredFields.length === 0 && (
                      <span className="text-xs text-emerald-600">
                        Nenhum erro
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
