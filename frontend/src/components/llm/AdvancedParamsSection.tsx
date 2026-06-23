"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";

interface AdvancedParamsSectionProps {
  kwargs: Record<string, unknown>;
  onChangeKwarg: (key: string, value: number) => void;
}

export function AdvancedParamsSection({
  kwargs,
  onChangeKwarg,
}: AdvancedParamsSectionProps) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        Parâmetros avançados
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-2 gap-4 pt-3">
          <div className="space-y-1.5">
            <Label className="text-sm">Requisições paralelas</Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={(kwargs.parallel_requests as number | undefined) ?? 5}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v) && v >= 1) onChangeKwarg("parallel_requests", v);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Documentos processados simultaneamente.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Delay entre requisições (s)</Label>
            <Input
              type="number"
              step={0.1}
              min={0}
              max={10}
              value={(kwargs.rate_limit_delay as number | undefined) ?? 0.5}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v >= 0) onChangeKwarg("rate_limit_delay", v);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Pausa entre requisições para evitar rate limits.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Cobertura mínima por documento (%)</Label>
            <Input
              type="number"
              step={1}
              min={0}
              max={100}
              value={Math.round(
                ((kwargs.partial_coverage_threshold as number | undefined) ??
                  0.5) * 100,
              )}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v) && v >= 0 && v <= 100)
                  onChangeKwarg("partial_coverage_threshold", v / 100);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Abaixo disso, a resposta entra como{" "}
              <code>is_latest=false</code> e aparece marcada como parcial na aba
              Respostas.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Máx. % de docs parciais por rodada</Label>
            <Input
              type="number"
              step={1}
              min={0}
              max={100}
              value={Math.round(
                ((kwargs.run_failure_threshold as number | undefined) ?? 0.3) *
                  100,
              )}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v) && v >= 0 && v <= 100)
                  onChangeKwarg("run_failure_threshold", v / 100);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Se essa fração dos documentos vier parcial, a rodada inteira é
              marcada como erro.
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
