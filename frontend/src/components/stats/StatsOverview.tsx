"use client";

import { Card, CardContent } from "@/components/ui/card";

interface StatsOverviewProps {
  coded: number;
  totalCoding: number;
  agreement: number;
  reviews: number;
  totalReviews: number;
}

export function StatsOverview({ coded, totalCoding, agreement, reviews, totalReviews }: StatsOverviewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Card>
        <CardContent className="pt-6 text-center">
          <p className="text-3xl font-bold tabular-nums">{coded}/{totalCoding}</p>
          <p className="text-sm text-muted-foreground">Codificadas</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6 text-center">
          <p className="text-3xl font-bold tabular-nums">{agreement}%</p>
          <p className="text-sm text-muted-foreground">Concordância</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6 text-center">
          <p className="text-3xl font-bold tabular-nums">{reviews}/{totalReviews}</p>
          <p className="text-sm text-muted-foreground">Revisões</p>
        </CardContent>
      </Card>
    </div>
  );
}
