"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, Flame, BarChart3, TrendingUp } from "lucide-react";

interface ProgressCardsProps {
  completed: number;
  total: number;
  streak: number;
  dailyAverage: number;
  requiredPace: number | null;
}

export function ProgressCards({
  completed,
  total,
  streak,
  dailyAverage,
  requiredPace,
}: ProgressCardsProps) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const cards = [
    {
      title: "Concluídos",
      value: `${completed}/${total}`,
      sub: `${pct}%`,
      icon: CheckCircle,
      color: "text-brand",
    },
    {
      title: "Sequência",
      value: `${streak}`,
      sub: streak === 1 ? "dia" : "dias",
      icon: Flame,
      color: "text-muted-foreground",
    },
    {
      title: "Média Diária",
      value: `${dailyAverage}`,
      sub: "docs/dia",
      icon: BarChart3,
      color: "text-muted-foreground",
    },
    {
      title: "Ritmo Necessário",
      value: requiredPace !== null ? `${requiredPace}` : "—",
      sub: requiredPace !== null ? "docs/dia" : "sem prazo",
      icon: TrendingUp,
      color: "text-muted-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {card.title}
            </CardTitle>
            <card.icon className={`h-4 w-4 ${card.color}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{card.value}</div>
            <p className="text-xs text-muted-foreground">{card.sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
