"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { MessageSquare, AlertTriangle, Bot, TrendingDown } from "lucide-react";

interface TopErrorField {
  name: string;
  description: string;
  rate: number;
  errors: number;
  total: number;
}

interface StatsOverviewProps {
  coded: number;
  totalCoding: number;
  agreement: number;
  reviews: number;
  totalReviews: number;
  openComments: number;
  openDifficulties: number;
  hasLlm: boolean;
  llmErrorRate: number;
  topErrorFields: TopErrorField[];
}

export function StatsOverview({
  coded,
  totalCoding,
  agreement,
  reviews,
  totalReviews,
  openComments,
  openDifficulties,
  hasLlm,
  llmErrorRate,
  topErrorFields,
}: StatsOverviewProps) {
  const params = useParams();
  const projectId = params.id as string;
  const base = `/projects/${projectId}/stats`;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground">Progresso</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold tabular-nums">
              {coded}/{totalCoding}
            </p>
            <p className="text-sm text-muted-foreground">Docs codificados</p>
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
            <p className="text-3xl font-bold tabular-nums">
              {reviews}/{totalReviews}
            </p>
            <p className="text-sm text-muted-foreground">Campos revisados</p>
          </CardContent>
        </Card>
      </div>

      <h3 className="text-sm font-medium text-muted-foreground">Pendências</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link href={`${base}/comments`}>
          <Card className="transition-colors hover:bg-accent/50">
            <CardContent className="flex items-center gap-3 pt-6">
              <MessageSquare className="h-5 w-5 text-amber-600" />
              <div>
                <p className="text-2xl font-bold tabular-nums">
                  {openComments}
                </p>
                <p className="text-sm text-muted-foreground">
                  Comentários abertos
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`${base}/llm-insights`}>
          <Card className="transition-colors hover:bg-accent/50">
            <CardContent className="flex items-center gap-3 pt-6">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              <div>
                <p className="text-2xl font-bold tabular-nums">
                  {openDifficulties}
                </p>
                <p className="text-sm text-muted-foreground">
                  Dificuldades LLM abertas
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {hasLlm && (
        <>
          <h3 className="text-sm font-medium text-muted-foreground">
            Qualidade LLM
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Link href={`${base}/llm-insights`}>
              <Card className="transition-colors hover:bg-accent/50">
                <CardContent className="flex items-center gap-3 pt-6">
                  <Bot className="h-5 w-5 text-brand" />
                  <div>
                    <p className="text-2xl font-bold tabular-nums">
                      {llmErrorRate}%
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Taxa de erro global
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
            {topErrorFields.length > 0 && (
              <Link href={`${base}/llm-insights`}>
                <Card className="transition-colors hover:bg-accent/50">
                  <CardContent className="pt-6">
                    <div className="mb-1 flex items-center gap-2">
                      <TrendingDown className="h-4 w-4 text-red-500" />
                      <p className="text-sm font-medium">
                        Campos mais problemáticos
                      </p>
                    </div>
                    <ul className="space-y-1">
                      {topErrorFields.map((f) => (
                        <li
                          key={f.name}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="truncate text-muted-foreground">
                            {f.description}
                          </span>
                          <span className="ml-2 shrink-0 font-medium tabular-nums text-red-600">
                            {f.rate}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
