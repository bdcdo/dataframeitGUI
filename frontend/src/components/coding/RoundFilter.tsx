"use client";

import { useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Round, RoundStrategy } from "@/lib/types";

interface RoundFilterProps {
  strategy: RoundStrategy;
  /** Identificador da rodada atual (UUID se manual, "X.Y.Z" se schema_version). */
  currentRoundKey: string;
  currentRoundLabel: string;
  rounds: Round[];
  /** Conjunto de versões (X.Y.Z) anteriores presentes em responses do user. */
  previousVersions: string[];
  /** Valor atualmente selecionado em ?round= ("current" | "all" | id | versão). */
  selected: string;
}

export function RoundFilter({
  strategy,
  currentRoundKey,
  currentRoundLabel,
  rounds,
  previousVersions,
  selected,
}: RoundFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const handleChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "current") {
      params.delete("round");
    } else {
      params.set("round", value);
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    });
  };

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b text-xs">
      <span className="text-muted-foreground">Rodada:</span>
      <Select value={selected || "current"} onValueChange={handleChange} disabled={isPending}>
        <SelectTrigger size="sm" className="h-7 w-auto min-w-[180px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="current">
            Atual ({currentRoundLabel}) — pendentes
          </SelectItem>
          <SelectItem value="all">Todas as rodadas</SelectItem>
          {strategy === "manual"
            ? rounds
                .filter((r) => r.id !== currentRoundKey)
                .map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))
            : previousVersions.map((v) => (
                <SelectItem key={v} value={v}>
                  Versão {v}
                </SelectItem>
              ))}
        </SelectContent>
      </Select>
    </div>
  );
}
