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
import { Button } from "@/components/ui/button";
import { PanelLeftClose } from "lucide-react";
import { CommentCard, type ReviewComment } from "./CommentCard";
import { CommentsSplitView } from "./CommentsSplitView";
import { EditFieldDialog, type PendingSuggestion } from "./EditFieldDialog";
import { SuggestFieldDialog } from "./SuggestFieldDialog";
import { AddNoteButton } from "@/components/shared/AddNoteButton";
import {
  resolveReviewComment,
  reopenReviewComment,
  resolveDifficulty,
  reopenDifficulty,
  resolveNote,
  reopenNote,
  resolveDuvida,
  reopenDuvida,
} from "@/actions/stats";
import {
  resolveProjectComment,
  reopenProjectComment,
} from "@/actions/project-comments";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

interface ReviewCommentsViewProps {
  projectId: string;
  comments: ReviewComment[];
  fields: PydanticField[];
  isCoordinator: boolean;
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
  const [pendingSuggestion, setPendingSuggestion] =
    useState<PendingSuggestion | null>(null);
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
    // Sugestão: abre EditFieldDialog pré-preenchido com a proposta.
    // Ao salvar o dialog, a sugestão é marcada como aprovada.
    if (comment.source === "sugestao" && comment.suggestionId) {
      setPendingSuggestion({
        id: comment.suggestionId,
        changes: comment.suggestionChanges ?? {},
      });
      setEditingField(comment.fieldName);
      return;
    }
    startTransition(async () => {
      let result: { success?: boolean; error?: string };
      if (comment.source === "anotacao") {
        result = await resolveProjectComment(comment.id.slice("anotacao-".length), projectId);
      } else if (comment.source === "nota") {
        result = await resolveNote(projectId, comment.id.slice("nota-".length));
      } else if (comment.source === "duvida" && comment.duvidaReviewId && comment.duvidaRespondentId) {
        result = await resolveDuvida(projectId, comment.duvidaReviewId, comment.duvidaRespondentId);
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
      let result: { success?: boolean; error?: string };
      if (comment.source === "anotacao") {
        result = await reopenProjectComment(comment.id.slice("anotacao-".length), projectId);
      } else if (comment.source === "nota") {
        result = await reopenNote(projectId, comment.id.slice("nota-".length));
      } else if (comment.source === "duvida" && comment.duvidaReviewId && comment.duvidaRespondentId) {
        result = await reopenDuvida(projectId, comment.duvidaReviewId, comment.duvidaRespondentId);
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
          pendingSuggestion={pendingSuggestion}
          onOpenChange={(open) => {
            if (!open) {
              setEditingField(null);
              setPendingSuggestion(null);
            }
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
