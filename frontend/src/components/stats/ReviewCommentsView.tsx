"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { History, ChevronDown, PanelLeftClose } from "lucide-react";
import { CommentCard, type ReviewComment } from "./CommentCard";
import { CommentsSplitView } from "./CommentsSplitView";
import { EditFieldDialog } from "./EditFieldDialog";
import { SuggestFieldDialog } from "./SuggestFieldDialog";
import { AddNoteButton } from "@/components/shared/AddNoteButton";
import {
  resolveReviewComment,
  reopenReviewComment,
  resolveDifficulty,
  reopenDifficulty,
} from "@/actions/stats";
import {
  resolveProjectComment,
  reopenProjectComment,
} from "@/actions/project-comments";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { PydanticField } from "@/lib/types";

export interface SchemaChangeEntry {
  id: string;
  fieldName: string;
  changeSummary: string;
  beforeValue: Record<string, unknown>;
  afterValue: Record<string, unknown>;
  changedBy: string;
  createdAt: string;
}

interface ReviewCommentsViewProps {
  projectId: string;
  comments: ReviewComment[];
  fields: PydanticField[];
  isCoordinator: boolean;
  schemaLog?: SchemaChangeEntry[];
  totalLlmDocs?: number;
  llmDocsWithoutAmbiguities?: number;
}

function verdictType(verdict: string): "answer" | "ambiguo" | "pular" | "nota" | "sugestao" | "dificuldade" | "anotacao" | "duvida" {
  if (verdict === "nota") return "nota";
  if (verdict === "anotacao") return "anotacao";
  if (verdict === "dificuldade") return "dificuldade";
  if (verdict === "sugestao") return "sugestao";
  if (verdict === "duvida") return "duvida";
  if (verdict === "ambiguo") return "ambiguo";
  if (verdict === "pular") return "pular";
  return "answer";
}

export function ReviewCommentsView({
  projectId,
  comments,
  fields,
  isCoordinator,
  schemaLog = [],
  totalLlmDocs = 0,
  llmDocsWithoutAmbiguities = 0,
}: ReviewCommentsViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fieldFilter, setFieldFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [verdictFilter, setVerdictFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [editingField, setEditingField] = useState<string | null>(null);
  const [suggestingField, setSuggestingField] = useState<string | null>(null);
  const [splitDocId, setSplitDocId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return comments.filter((c) => {
      if (fieldFilter !== "all" && c.fieldName !== fieldFilter) return false;
      if (statusFilter === "open" && c.resolvedAt) return false;
      if (statusFilter === "resolved" && !c.resolvedAt) return false;
      if (verdictFilter !== "all" && verdictType(c.verdict) !== verdictFilter)
        return false;
      if (
        searchQuery &&
        !c.documentTitle.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !c.comment.toLowerCase().includes(searchQuery.toLowerCase())
      )
        return false;
      return true;
    });
  }, [comments, fieldFilter, statusFilter, verdictFilter, searchQuery]);

  const handleResolve = (comment: ReviewComment) => {
    startTransition(async () => {
      let result;
      if (comment.source === "anotacao") {
        result = await resolveProjectComment(comment.id.slice("anotacao-".length), projectId);
      } else if (comment.source === "dificuldade" && comment.difficultyResponseId) {
        result = await resolveDifficulty(
          projectId,
          comment.difficultyResponseId,
          comment.difficultyDocumentId!,
        );
      } else {
        result = await resolveReviewComment(comment.id, projectId);
      }
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Comentário resolvido");
        router.refresh();
      }
    });
  };

  const handleReopen = (comment: ReviewComment) => {
    startTransition(async () => {
      let result;
      if (comment.source === "anotacao") {
        result = await reopenProjectComment(comment.id.slice("anotacao-".length), projectId);
      } else if (comment.source === "dificuldade" && comment.difficultyResponseId) {
        result = await reopenDifficulty(projectId, comment.difficultyResponseId);
      } else {
        result = await reopenReviewComment(comment.id, projectId);
      }
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Comentário reaberto");
        router.refresh();
      }
    });
  };

  const [logOpen, setLogOpen] = useState(false);

  // Count unique documents with review/difficulty comments (for split view button)
  const splitSources = new Set(["review", "dificuldade"]);
  const reviewDocCount = useMemo(() => {
    const docs = new Set<string>();
    for (const c of comments) {
      if (splitSources.has(c.source) && c.documentId) docs.add(c.documentId);
    }
    return docs.size;
  }, [comments]);

  if (splitDocId) {
    const reviewComments = comments.filter((c) => splitSources.has(c.source) && c.documentId);
    return (
      <CommentsSplitView
        projectId={projectId}
        comments={reviewComments}
        initialDocId={splitDocId}
        onBack={() => setSplitDocId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <AddNoteButton
          projectId={projectId}
          fields={fields}
          variant="outline"
          size="sm"
          label="Nova nota"
        />
        {reviewDocCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => {
              const first = comments.find((c) => splitSources.has(c.source) && c.documentId);
              if (first) setSplitDocId(first.documentId);
            }}
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
            Revisar por documento
          </Button>
        )}
        <Collapsible open={logOpen} onOpenChange={setLogOpen} className="ml-auto">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs">
              <History className="h-3.5 w-3.5" />
              Histórico de mudanças no schema{schemaLog.length > 0 && ` (${schemaLog.length})`}
              <ChevronDown className={cn("h-3 w-3 transition-transform", logOpen && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
          <div className="mt-2 divide-y rounded-md border">
            {schemaLog.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">
                Nenhuma mudança registrada ainda.
              </p>
            ) : schemaLog.map((entry) => {
                const changes: { label: string; before: string; after: string }[] = [];
                if (entry.beforeValue.description !== undefined) {
                  changes.push({
                    label: "descrição",
                    before: String(entry.beforeValue.description) || "(vazio)",
                    after: String(entry.afterValue.description) || "(vazio)",
                  });
                }
                if (entry.beforeValue.help_text !== undefined) {
                  changes.push({
                    label: "instruções",
                    before: String(entry.beforeValue.help_text ?? "") || "(vazio)",
                    after: String(entry.afterValue.help_text ?? "") || "(vazio)",
                  });
                }
                if (entry.beforeValue.options !== undefined) {
                  changes.push({
                    label: "opções",
                    before: Array.isArray(entry.beforeValue.options)
                      ? (entry.beforeValue.options as string[]).join(", ") || "(vazio)"
                      : "(vazio)",
                    after: Array.isArray(entry.afterValue.options)
                      ? (entry.afterValue.options as string[]).join(", ") || "(vazio)"
                      : "(vazio)",
                  });
                }
                return (
                  <div key={entry.id} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
                    <code className="shrink-0 font-mono text-muted-foreground/70">{entry.fieldName}</code>
                    <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0">
                      {entry.changeSummary}
                    </Badge>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {changes.map((c, i) => (
                        <span key={c.label}>
                          {i > 0 && " · "}
                          <span className="line-through">{c.before}</span>
                          {" → "}
                          <span className="font-medium text-foreground">{c.after}</span>
                        </span>
                      ))}
                    </span>
                    <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground">
                      {entry.changedBy} · {new Date(entry.createdAt).toLocaleDateString("pt-BR")}
                    </span>
                  </div>
                );
              })}
          </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Buscar documento ou comentário..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-56"
        />
        <Select value={fieldFilter} onValueChange={setFieldFilter}>
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
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Abertos</SelectItem>
            <SelectItem value="resolved">Resolvidos</SelectItem>
            <SelectItem value="all">Todos</SelectItem>
          </SelectContent>
        </Select>
        <Select value={verdictFilter} onValueChange={setVerdictFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os tipos</SelectItem>
            <SelectItem value="answer">Resposta escolhida</SelectItem>
            <SelectItem value="ambiguo">Ambíguo</SelectItem>
            <SelectItem value="pular">Pular</SelectItem>
            <SelectItem value="nota">Notas</SelectItem>
            <SelectItem value="sugestao">Sugestões</SelectItem>
            <SelectItem value="dificuldade">Dificuldade LLM</SelectItem>
            <SelectItem value="duvida">Dúvidas do gabarito</SelectItem>
            <SelectItem value="anotacao">Anotações</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} comentário{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            Nenhum comentário encontrado.
          </p>
          {verdictFilter === "dificuldade" && totalLlmDocs > 0 && llmDocsWithoutAmbiguities > 0 && (
            <p className="text-xs text-muted-foreground">
              {llmDocsWithoutAmbiguities === totalLlmDocs
                ? `${totalLlmDocs} documento${totalLlmDocs !== 1 ? "s" : ""} com respostas LLM, mas o campo de ambiguidades não estava habilitado durante o processamento.`
                : `${llmDocsWithoutAmbiguities} de ${totalLlmDocs} documentos LLM não têm o campo de ambiguidades.`}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              projectId={projectId}
              isPending={isPending}
              isCoordinator={isCoordinator}
              onResolve={() => handleResolve(c)}
              onReopen={() => handleReopen(c)}
              onEditField={() => setEditingField(c.fieldName)}
              onSuggestField={() => setSuggestingField(c.fieldName)}
              onOpenDocument={c.documentId ? (docId) => setSplitDocId(docId) : undefined}
            />
          ))}
        </div>
      )}

      {isCoordinator && editingField && (
        <EditFieldDialog
          projectId={projectId}
          fieldName={editingField}
          allFields={fields}
          open={!!editingField}
          onOpenChange={(open) => {
            if (!open) setEditingField(null);
          }}
        />
      )}

      {!isCoordinator && suggestingField && (
        <SuggestFieldDialog
          projectId={projectId}
          fieldName={suggestingField}
          allFields={fields}
          open={!!suggestingField}
          onOpenChange={(open) => {
            if (!open) setSuggestingField(null);
          }}
        />
      )}
    </div>
  );
}
