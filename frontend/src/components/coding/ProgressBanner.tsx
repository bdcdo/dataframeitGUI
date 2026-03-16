"use client";

import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Flame, CalendarClock, TrendingUp } from "lucide-react";

export interface ProgressBannerData {
  completed: number;
  total: number;
  nextDeadline: string | null;
  daysUntilDeadline: number | null;
  requiredPace: number | null;
  streak: number;
}

export function ProgressBanner({ data }: { data: ProgressBannerData }) {
  if (data.total === 0) return null;

  const pct = Math.round((data.completed / data.total) * 100);
  const isOverdue =
    data.daysUntilDeadline !== null && data.daysUntilDeadline < 0;
  const isUrgent =
    data.daysUntilDeadline !== null &&
    data.daysUntilDeadline >= 0 &&
    data.daysUntilDeadline <= 2;

  const formatDeadline = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("pt-BR", { day: "numeric", month: "short" });
  };

  return (
    <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-2 text-sm shrink-0">
      {/* Progress bar */}
      <div className="flex items-center gap-2 min-w-0">
        <Progress value={pct} className="h-2 w-24" />
        <span className="font-medium tabular-nums whitespace-nowrap">
          {data.completed}/{data.total}
        </span>
      </div>

      {/* Deadline */}
      {data.nextDeadline && (
        <div
          className={cn(
            "flex items-center gap-1 whitespace-nowrap",
            isOverdue && "text-destructive font-medium",
            isUrgent && "text-orange-600 dark:text-orange-400"
          )}
        >
          <CalendarClock className="h-3.5 w-3.5" />
          <span>
            {formatDeadline(data.nextDeadline)}
            {data.daysUntilDeadline !== null && (
              <span className="text-muted-foreground ml-1">
                ({isOverdue ? "atrasado" : `${data.daysUntilDeadline}d`})
              </span>
            )}
          </span>
        </div>
      )}

      {/* Required pace */}
      {data.requiredPace !== null && data.requiredPace > 0 && (
        <div className="flex items-center gap-1 text-muted-foreground whitespace-nowrap">
          <TrendingUp className="h-3.5 w-3.5" />
          <span>{data.requiredPace}/dia</span>
        </div>
      )}

      {/* Streak */}
      {data.streak > 0 && (
        <Badge variant="secondary" className="gap-1 shrink-0">
          <Flame className="h-3 w-3 text-orange-500" />
          {data.streak}d
        </Badge>
      )}
    </div>
  );
}
