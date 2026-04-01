"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  FileText,
} from "lucide-react";
import { LlmErrorCard } from "./LlmErrorCard";
import {
  resolveDifficulty,
  reopenDifficulty,
  resolveError,
  reopenError,
} from "@/actions/stats";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface LlmError {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  llmAnswer: string;
  llmJustification: string | null;
  chosenVerdict: string;
  reviewerComment: string | null;
  resolvedAt: string | null;
}

interface LlmDifficulty {
  responseId: string;
  documentId: string;
  documentTitle: string;
  modelName: string;
  text: string;
  resolvedAt: string | null;
}

interface LlmInsightsViewProps {
  projectId: string;
  errors: LlmError[];
  difficulties: LlmDifficulty[];
  fields: { name: string; description: string }[];
  summary: {
    totalLlmDocs: number;
    totalErrors: number;
    errorRate: number;
  };
}

export function LlmInsightsView({
  projectId,
  errors,
  difficulties,
  fields,
  summary,
}: LlmInsightsViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Error filters
  const [errorFieldFilter, setErrorFieldFilter] = useState("all");
  const [errorSearchQuery, setErrorSearchQuery] = useState("");
  const [errorStatusFilter, setErrorStatusFilter] = useState("open");

  // Difficulty filters
  const [diffStatusFilter, setDiffStatusFilter] = useState("open");
  const [diffSearchQuery, setDiffSearchQuery] = useState("");

  const filteredErrors = useMemo(() => {
    return errors.filter((e) => {
      if (errorStatusFilter === "open" && e.resolvedAt) return false;
      if (errorStatusFilter === "resolved" && !e.resolvedAt) return false;
      if (errorFieldFilter !== "all" && e.fieldName !== errorFieldFilter)
        return false;
      if (
        errorSearchQuery &&
        !e.documentTitle
          .toLowerCase()
          .includes(errorSearchQuery.toLowerCase())
      )
        return false;
      return true;
    });
  }, [errors, errorFieldFilter, errorSearchQuery, errorStatusFilter]);

  const filteredDifficulties = useMemo(() => {
    return difficulties.filter((d) => {
      if (diffStatusFilter === "open" && d.resolvedAt) return false;
      if (diffStatusFilter === "resolved" && !d.resolvedAt) return false;
      if (
        diffSearchQuery &&
        !d.documentTitle
          .toLowerCase()
          .includes(diffSearchQuery.toLowerCase()) &&
        !d.text.toLowerCase().includes(diffSearchQuery.toLowerCase())
      )
        return false;
      return true;
    });
  }, [difficulties, diffStatusFilter, diffSearchQuery]);

  const openErrorCount = errors.filter((e) => !e.resolvedAt).length;
  const openDiffCount = difficulties.filter((d) => !d.resolvedAt).length;

  // Error handlers
  const handleResolveError = (documentId: string, fieldName: string) => {
    startTransition(async () => {
      const result = await resolveError(projectId, documentId, fieldName);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Erro resolvido");
        router.refresh();
      }
    });
  };

  const handleReopenError = (documentId: string, fieldName: string) => {
    startTransition(async () => {
      const result = await reopenError(projectId, documentId, fieldName);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Erro reaberto");
        router.refresh();
      }
    });
  };

  // Difficulty handlers
  const handleResolveDifficulty = (
    responseId: string,
    documentId: string,
  ) => {
    startTransition(async () => {
      const result = await resolveDifficulty(projectId, responseId, documentId);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Dificuldade resolvida");
        router.refresh();
      }
    });
  };

  const handleReopenDifficulty = (responseId: string) => {
    startTransition(async () => {
      const result = await reopenDifficulty(projectId, responseId);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Dificuldade reaberta");
        router.refresh();
      }
    });
  };

  return (
    <Tabs defaultValue="errors">
      <TabsList>
        <TabsTrigger value="errors">
          Erros do LLM
          {openErrorCount > 0 && (
            <Badge variant="destructive" className="ml-1.5">
              {openErrorCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="difficulties">
          Dificuldades
          {openDiffCount > 0 && (
            <Badge variant="secondary" className="ml-1.5">
              {openDiffCount}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="errors" className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <Bot className="h-5 w-5 text-brand" />
              <div>
                <p className="text-2xl font-bold tabular-nums">
                  {summary.totalLlmDocs}
                </p>
                <p className="text-xs text-muted-foreground">
                  Docs com LLM
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-2xl font-bold tabular-nums">
                  {summary.totalErrors}
                </p>
                <p className="text-xs text-muted-foreground">
                  Campos incorretos
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-2xl font-bold tabular-nums">
                {summary.errorRate}%
              </p>
              <p className="text-xs text-muted-foreground">Taxa de erro</p>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Buscar documento..."
            value={errorSearchQuery}
            onChange={(e) => setErrorSearchQuery(e.target.value)}
            className="w-56"
          />
          <Select value={errorFieldFilter} onValueChange={setErrorFieldFilter}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Campo" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os campos</SelectItem>
              {fields.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.description || f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={errorStatusFilter} onValueChange={setErrorStatusFilter}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Abertos</SelectItem>
              <SelectItem value="resolved">Resolvidos</SelectItem>
              <SelectItem value="all">Todos</SelectItem>
            </SelectContent>
          </Select>
          <span className="ml-auto text-sm text-muted-foreground">
            {filteredErrors.length} erro{filteredErrors.length !== 1 ? "s" : ""}
          </span>
        </div>

        {filteredErrors.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {errors.length === 0
              ? "Nenhum erro do LLM encontrado."
              : "Nenhum erro corresponde aos filtros."}
          </p>
        ) : (
          <div className="space-y-3">
            {filteredErrors.map((e, i) => (
              <LlmErrorCard
                key={`${e.documentId}-${e.fieldName}-${i}`}
                error={e}
                projectId={projectId}
                isPending={isPending}
                onResolve={() => handleResolveError(e.documentId, e.fieldName)}
                onReopen={() => handleReopenError(e.documentId, e.fieldName)}
              />
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="difficulties" className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Buscar documento ou texto..."
            value={diffSearchQuery}
            onChange={(e) => setDiffSearchQuery(e.target.value)}
            className="w-56"
          />
          <Select value={diffStatusFilter} onValueChange={setDiffStatusFilter}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Abertas</SelectItem>
              <SelectItem value="resolved">Resolvidas</SelectItem>
              <SelectItem value="all">Todas</SelectItem>
            </SelectContent>
          </Select>
          <span className="ml-auto text-sm text-muted-foreground">
            {filteredDifficulties.length} dificuldade
            {filteredDifficulties.length !== 1 ? "s" : ""}
          </span>
        </div>

        {filteredDifficulties.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {difficulties.length === 0
              ? "Nenhuma dificuldade reportada pelo LLM."
              : "Nenhuma dificuldade corresponde aos filtros."}
          </p>
        ) : (
          <div className="space-y-3">
            {filteredDifficulties.map((d) => (
              <Card
                key={d.responseId}
                className={cn(d.resolvedAt && "opacity-60")}
              >
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {d.documentTitle}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Modelo: {d.modelName}
                      </p>
                    </div>
                    {d.resolvedAt && (
                      <Badge variant="secondary">Resolvida</Badge>
                    )}
                  </div>
                  <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap">
                    {d.text}
                  </blockquote>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" asChild title="Ver documento">
                      <Link href={`/projects/${projectId}/code?doc=${d.documentId}`}>
                        <FileText className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                    {d.resolvedAt ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isPending}
                        onClick={() => handleReopenDifficulty(d.responseId)}
                        title="Reabrir"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isPending}
                        onClick={() =>
                          handleResolveDifficulty(d.responseId, d.documentId)
                        }
                        title="Resolver"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
