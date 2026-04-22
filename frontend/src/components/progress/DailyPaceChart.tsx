"use client";

import dynamic from "next/dynamic";

interface DailyPaceChartProps {
  dailyCompletions: { date: string; count: number }[];
  requiredPace: number | null;
}

const DailyPaceChartInner = dynamic(
  () =>
    import("recharts").then((mod) => {
      const {
        LineChart,
        Line,
        XAxis,
        YAxis,
        CartesianGrid,
        Tooltip,
        ReferenceLine,
        ResponsiveContainer,
      } = mod;

      function Chart({ dailyCompletions, requiredPace }: DailyPaceChartProps) {
        const data = dailyCompletions.map((d) => ({
          date: new Date(d.date + "T00:00:00").toLocaleDateString("pt-BR", {
            day: "numeric",
            month: "short",
          }),
          count: d.count,
        }));

        return (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                className="fill-muted-foreground"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11 }}
                className="fill-muted-foreground"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value) => [String(value), "Documentos"]}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="oklch(0.44 0.08 185)"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
              <ReferenceLine
                y={requiredPace !== null && requiredPace > 0 ? requiredPace : 0}
                stroke={
                  requiredPace !== null && requiredPace > 0
                    ? "hsl(var(--destructive))"
                    : "transparent"
                }
                strokeDasharray="5 5"
                label={
                  requiredPace !== null && requiredPace > 0
                    ? {
                        value: `Meta: ${requiredPace}/dia`,
                        position: "insideTopRight",
                        fontSize: 11,
                        fill: "hsl(var(--destructive))",
                      }
                    : undefined
                }
              />
            </LineChart>
          </ResponsiveContainer>
        );
      }

      return Chart;
    }),
  {
    ssr: false,
    loading: () => (
      <div className="h-[200px] w-full animate-pulse rounded bg-muted" />
    ),
  }
);

export function DailyPaceChart({
  dailyCompletions,
  requiredPace,
}: DailyPaceChartProps) {
  if (dailyCompletions.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Ritmo Diário</h3>
        <p className="text-sm text-muted-foreground">
          Nenhuma atividade registrada ainda.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Ritmo Diário</h3>
      <DailyPaceChartInner
        dailyCompletions={dailyCompletions}
        requiredPace={requiredPace}
      />
    </div>
  );
}
