"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface VerdictChartProps {
  data: { field: string; agreed: number; divergent: number; reviewed: number }[];
}

export function VerdictChart({ data }: VerdictChartProps) {
  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="field" tick={{ fontSize: 11 }} />
          <YAxis />
          <Tooltip />
          <Bar dataKey="agreed" fill="oklch(0.44 0.08 185)" name="Concordaram" />
          <Bar dataKey="divergent" fill="oklch(0.7 0.15 30)" name="Divergentes" />
          <Bar dataKey="reviewed" fill="oklch(0.6 0.1 250)" name="Revisados" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
