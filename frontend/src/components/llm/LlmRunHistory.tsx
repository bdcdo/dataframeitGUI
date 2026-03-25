"use client";

import { formatModelLabel } from "@/lib/model-registry";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight, History } from "lucide-react";
import type { LlmRunHistoryItem } from "@/actions/llm";

interface LlmRunHistoryProps {
  history: LlmRunHistoryItem[];
}

export function LlmRunHistory({ history }: LlmRunHistoryProps) {
  if (history.length === 0) return null;

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors group">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
        <History className="h-3.5 w-3.5" />
        Histórico de execuções ({history.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Modelo</th>
                <th className="px-3 py-2 font-medium text-right">Docs</th>
                <th className="px-3 py-2 font-medium text-right">Última execução</th>
              </tr>
            </thead>
            <tbody>
              {history.map((item) => (
                <tr key={item.respondent_name} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    {formatModelLabel(item.respondent_name)}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {item.docCount}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {new Date(item.latestAt).toLocaleDateString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
