"use client";

import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Check,
  X,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Bot,
  FileText,
  ChevronLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { AddNoteButton } from "@/components/shared/AddNoteButton";
import type { PydanticField } from "@/lib/types";
import type { ReviewedDocument } from "@/lib/reviews/types";

const PAGE_SIZE = 10;

interface GabaritoByDocumentProps {
  reviewedDocuments: ReviewedDocument[];
  fields: PydanticField[];
  projectId: string;
}

export function GabaritoByDocument({
  reviewedDocuments,
  fields,
  projectId,
}: GabaritoByDocumentProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [includeStale, setIncludeStale] = useState(true);
  const [fieldFilter, setFieldFilter] = useState("all");
  const [respondentFilter, setRespondentFilter] = useState("all");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [page, setPage] = useState(0);

  const allRespondents = useMemo(() => {
    const map = new Map<string, { name: string; type: "humano" | "llm" }>();
    reviewedDocuments.forEach((doc) =>
      doc.fields.forEach((f) =>
        f.respondentAnswers.forEach((ra) => {
          if (!map.has(ra.respondentKey)) {
            map.set(ra.respondentKey, {
              name: ra.respondentName,
              type: ra.respondentType,
            });
          }
        }),
      ),
    );
    return [...map.entries()].map(([key, v]) => ({ key, ...v }));
  }, [reviewedDocuments]);

  const filtered = useMemo(() => {
    return reviewedDocuments
      .map((doc) => {
        let docFields = doc.fields;

        if (fieldFilter !== "all") {
          docFields = docFields.filter((f) => f.fieldName === fieldFilter);
        }

        docFields = docFields.map((f) => {
          let answers = f.respondentAnswers;
          if (!includeStale) {
            answers = answers.filter((a) => !a.isStale);
          }
          if (respondentFilter !== "all") {
            answers = answers.filter(
              (a) => a.respondentKey === respondentFilter,
            );
          }
          return { ...f, respondentAnswers: answers };
        });

        if (onlyErrors) {
          docFields = docFields.filter((f) =>
            f.respondentAnswers.some(
              (a) => !a.isCorrect && f.verdict !== "ambiguo" && f.verdict !== "pular",
            ),
          );
        }

        return { ...doc, fields: docFields };
      })
      .filter((doc) => {
        if (doc.fields.length === 0) return false;
        if (
          searchQuery &&
          !doc.documentTitle
            .toLowerCase()
            .includes(searchQuery.toLowerCase())
        )
          return false;
        return true;
      });
  }, [
    reviewedDocuments,
    searchQuery,
    fieldFilter,
    respondentFilter,
    onlyErrors,
    includeStale,
  ]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleFilterChange = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(0);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Buscar documento..."
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setPage(0);
          }}
          className="w-56"
        />
        <Select value={fieldFilter} onValueChange={handleFilterChange(setFieldFilter)}>
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
        <Select
          value={respondentFilter}
          onValueChange={handleFilterChange(setRespondentFilter)}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Respondente" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {allRespondents.map((r) => (
              <SelectItem key={r.key} value={r.key}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Switch
            id="include-stale"
            checked={includeStale}
            onCheckedChange={setIncludeStale}
          />
          <Label htmlFor="include-stale" className="text-sm">
            Incluir desatualizadas
          </Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Switch
            id="only-errors"
            checked={onlyErrors}
            onCheckedChange={(v) => {
              setOnlyErrors(v);
              setPage(0);
            }}
          />
          <Label htmlFor="only-errors" className="text-sm">
            Apenas erros
          </Label>
        </div>
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} documento{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {paginated.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nenhum documento corresponde aos filtros.
        </p>
      ) : (
        <div className="space-y-4">
          {paginated.map((doc) => (
            <DocumentCard key={doc.documentId} doc={doc} projectId={projectId} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── Document Card ── */

function DocumentCard({
  doc,
  projectId,
}: {
  doc: ReviewedDocument;
  projectId: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{doc.documentTitle}</h3>
          <Button variant="ghost" size="sm" asChild title="Ver documento">
            <Link href={`/projects/${projectId}/analyze/compare?doc=${doc.documentId}`}>
              <FileText className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>

        <div className="space-y-2">
          {doc.fields.map((field) => (
            <FieldRow
              key={field.fieldName}
              field={field}
              projectId={projectId}
              documentId={doc.documentId}
              documentTitle={doc.documentTitle}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Field Row ── */

function FieldRow({
  field,
  projectId,
  documentId,
  documentTitle,
}: {
  field: ReviewedDocument["fields"][number];
  projectId: string;
  documentId: string;
  documentTitle: string;
}) {
  const isSpecialVerdict =
    field.verdict === "ambiguo" || field.verdict === "pular";

  const verdictDisplay = isSpecialVerdict
    ? field.verdict === "ambiguo"
      ? "Ambíguo"
      : "Pular"
    : formatVerdictDisplay(field.verdict, field.fieldType);

  return (
    <div className="rounded-md border p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {field.fieldDescription}
        </p>
        <AddNoteButton
          projectId={projectId}
          documentId={documentId}
          documentTitle={documentTitle}
          fieldName={field.fieldName}
        />
      </div>

      <div
        className={cn(
          "flex items-center gap-2 rounded px-2 py-1 text-sm",
          isSpecialVerdict
            ? "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
            : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
        )}
      >
        <span className="text-xs font-medium">Gabarito:</span>
        <span className="font-medium">{verdictDisplay}</span>
      </div>

      {field.respondentAnswers.map((ra) => (
        <RespondentRow key={ra.respondentKey} ra={ra} isSpecialVerdict={isSpecialVerdict} />
      ))}
    </div>
  );
}

/* ── Respondent Row ── */

function RespondentRow({
  ra,
  isSpecialVerdict,
}: {
  ra: ReviewedDocument["fields"][number]["respondentAnswers"][number];
  isSpecialVerdict: boolean;
}) {
  const [showJustification, setShowJustification] = useState(false);
  const answerDisplay = formatAnswerDisplay(ra.answer);

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-sm">
        {!isSpecialVerdict && (
          ra.isCorrect ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          ) : (
            <X className="h-3.5 w-3.5 shrink-0 text-red-500" />
          )
        )}
        <span
          className={cn(
            "min-w-0 truncate",
            !isSpecialVerdict && !ra.isCorrect && "text-red-600 dark:text-red-400",
          )}
        >
          {answerDisplay || <span className="italic text-muted-foreground">sem resposta</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {ra.respondentType === "llm" && (
            <Bot className="h-3 w-3" />
          )}
          {ra.respondentName}
          {ra.isStale && (
            <span className="inline-flex items-center gap-0.5 text-amber-600">
              <AlertTriangle className="h-3 w-3" />
            </span>
          )}
        </span>
        {ra.justification && (
          <button
            onClick={() => setShowJustification(!showJustification)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {showJustification ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      {showJustification && ra.justification && (
        <blockquote className="ml-6 border-l-2 pl-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {ra.justification}
        </blockquote>
      )}
    </div>
  );
}

/* ── Helpers ── */

function formatVerdictDisplay(verdict: string, fieldType: string): string {
  if (fieldType === "multi") {
    try {
      const map = JSON.parse(verdict) as Record<string, boolean>;
      return Object.entries(map)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join("; ");
    } catch {
      return verdict;
    }
  }
  return verdict;
}

function formatAnswerDisplay(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.join("; ");
  return String(val);
}
