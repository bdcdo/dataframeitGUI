"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ActivityCalendarProps {
  activityMap: { date: string; count: number }[];
}

export function ActivityCalendar({ activityMap }: ActivityCalendarProps) {
  // Group by week (columns) and day of week (rows)
  const weeks: { date: string; count: number }[][] = [];
  let currentWeek: { date: string; count: number }[] = [];

  for (let i = 0; i < activityMap.length; i++) {
    const entry = activityMap[i];
    const dayOfWeek = new Date(entry.date + "T00:00:00").getDay();

    // Start new week on Sunday
    if (dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }

    currentWeek.push(entry);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  // Pad first week
  if (weeks.length > 0) {
    const firstDay = new Date(weeks[0][0].date + "T00:00:00").getDay();
    const padding = Array.from({ length: firstDay }, () => ({
      date: "",
      count: -1,
    }));
    weeks[0] = [...padding, ...weeks[0]];
  }

  const maxCount = Math.max(...activityMap.map((d) => d.count), 1);

  const getIntensity = (count: number) => {
    if (count === 0) return "bg-muted";
    const ratio = count / maxCount;
    if (ratio <= 0.25) return "bg-brand/25";
    if (ratio <= 0.5) return "bg-brand/50";
    if (ratio <= 0.75) return "bg-brand/75";
    return "bg-brand";
  };

  const dayLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Atividade</h3>
      <TooltipProvider delayDuration={100}>
        <div className="flex gap-0.5 overflow-x-auto pb-2">
          {/* Day labels */}
          <div className="flex flex-col gap-0.5 pr-1">
            {dayLabels.map((label, i) => (
              <div
                key={label}
                className={cn(
                  "h-3 text-[9px] leading-3 text-muted-foreground",
                  i % 2 === 0 ? "opacity-100" : "opacity-0"
                )}
              >
                {label}
              </div>
            ))}
          </div>
          {/* Weeks */}
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-0.5">
              {Array.from({ length: 7 }, (_, di) => {
                const entry = week[di];
                if (!entry || entry.count === -1) {
                  return <div key={di} className="h-3 w-3" />;
                }
                const d = new Date(entry.date + "T00:00:00");
                const formatted = d.toLocaleDateString("pt-BR", {
                  day: "numeric",
                  month: "short",
                });
                return (
                  <Tooltip key={di}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "h-3 w-3 rounded-[2px]",
                          getIntensity(entry.count)
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      {entry.count} documento{entry.count !== 1 ? "s" : ""} em{" "}
                      {formatted}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
      </TooltipProvider>
      {/* Legend */}
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>Menos</span>
        <div className="h-3 w-3 rounded-[2px] bg-muted" />
        <div className="h-3 w-3 rounded-[2px] bg-brand/25" />
        <div className="h-3 w-3 rounded-[2px] bg-brand/50" />
        <div className="h-3 w-3 rounded-[2px] bg-brand/75" />
        <div className="h-3 w-3 rounded-[2px] bg-brand" />
        <span>Mais</span>
      </div>
    </div>
  );
}
