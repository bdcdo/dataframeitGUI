"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

interface DailyPaceChartProps {
  dailyCompletions: { date: string; count: number }[];
  requiredPace: number | null;
}

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

  const data = dailyCompletions.map((d) => ({
    date: new Date(d.date + "T00:00:00").toLocaleDateString("pt-BR", {
      day: "numeric",
      month: "short",
    }),
    count: d.count,
  }));

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Ritmo Diário</h3>
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
          {requiredPace !== null && requiredPace > 0 && (
            <ReferenceLine
              y={requiredPace}
              stroke="hsl(var(--destructive))"
              strokeDasharray="5 5"
              label={{
                value: `Meta: ${requiredPace}/dia`,
                position: "insideTopRight",
                fontSize: 11,
                fill: "hsl(var(--destructive))",
              }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
