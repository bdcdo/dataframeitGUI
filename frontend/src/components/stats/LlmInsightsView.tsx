"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  AlertTriangle,
} from "lucide-react";
import { LlmErrorCard } from "./LlmErrorCard";
import { EditFieldDialog } from "./EditFieldDialog";
import {
  resolveError,
  reopenError,
} from "@/actions/stats";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

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

interface LlmInsightsViewProps {
  projectId: string;
  errors: LlmError[];
  fields: { name: string; description: string }[];
  allFields?: PydanticField[];
  isCoordinator?: boolean;
  summary: {
    totalLlmDocs: number;
    totalErrors: number;
    errorRate: number;
  };
}

export function LlmInsightsView({
  projectId,
  errors,
  fields,
  allFields,
  isCoordinator,
  summary,
}: LlmInsightsViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editingField, setEditingField] = useState<string | null>(null);

  // Error filters
  const [errorFieldFilter, setErrorFieldFilter] = useState("all");
  const [errorSearchQuery, setErrorSearchQuery] = useState("");
  const [errorStatusFilter, setErrorStatusFilter] = useState("open");

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

  const openErrorCount = errors.filter((e) => !e.resolvedAt).length;

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

  return (
    <>
    <div className="space-y-4">
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
          {openErrorCount > 0 && (
            <Badge variant="destructive" className="ml-1.5">
              {openErrorCount} aberto{openErrorCount !== 1 ? "s" : ""}
            </Badge>
          )}
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
              isCoordinator={isCoordinator}
              onResolve={() => handleResolveError(e.documentId, e.fieldName)}
              onReopen={() => handleReopenError(e.documentId, e.fieldName)}
              onEditField={() => setEditingField(e.fieldName)}
            />
          ))}
        </div>
      )}
    </div>

    {isCoordinator && editingField && allFields && (
      <EditFieldDialog
        projectId={projectId}
        fieldName={editingField}
        allFields={allFields}
        open={!!editingField}
        onOpenChange={(open) => {
          if (!open) setEditingField(null);
        }}
      />
    )}
    </>
  );
}
