"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface NextDeliveriesProps {
  deadlines: { date: string; pending: number; completed: number }[];
}

export function NextDeliveries({ deadlines }: NextDeliveriesProps) {
  if (deadlines.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Próximas Entregas</h3>
        <p className="text-sm text-muted-foreground">Nenhum prazo definido.</p>
      </div>
    );
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Próximas Entregas</h3>
      <div className="space-y-2">
        {deadlines.map((dl) => {
          const d = new Date(dl.date + "T00:00:00");
          const isOverdue = d < today && dl.pending > 0;
          const formatted = d.toLocaleDateString("pt-BR", {
            day: "numeric",
            month: "short",
            year: "numeric",
          });

          return (
            <div
              key={dl.date}
              className={cn(
                "flex items-center justify-between rounded-lg border p-3",
                isOverdue && "border-destructive/50 bg-destructive/5"
              )}
            >
              <div>
                <p
                  className={cn(
                    "text-sm font-medium",
                    isOverdue && "text-destructive"
                  )}
                >
                  {formatted}
                </p>
                <p className="text-xs text-muted-foreground">
                  {dl.completed} concluídos · {dl.pending} pendentes
                </p>
              </div>
              {isOverdue && (
                <Badge variant="destructive" className="text-xs">
                  Atrasado
                </Badge>
              )}
              {!isOverdue && dl.pending === 0 && (
                <Badge
                  variant="secondary"
                  className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 text-xs"
                >
                  Completo
                </Badge>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
