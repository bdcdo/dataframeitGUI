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
import { CommentCard, type ReviewComment } from "./CommentCard";
import { EditFieldDialog } from "./EditFieldDialog";
import {
  resolveReviewComment,
  reopenReviewComment,
} from "@/actions/stats";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

interface ReviewCommentsViewProps {
  projectId: string;
  comments: ReviewComment[];
  fields: PydanticField[];
  isCoordinator: boolean;
}

function verdictType(verdict: string): "answer" | "ambiguo" | "pular" | "nota" {
  if (verdict === "nota") return "nota";
  if (verdict === "ambiguo") return "ambiguo";
  if (verdict === "pular") return "pular";
  return "answer";
}

export function ReviewCommentsView({
  projectId,
  comments,
  fields,
  isCoordinator,
}: ReviewCommentsViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fieldFilter, setFieldFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [verdictFilter, setVerdictFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [editingField, setEditingField] = useState<string | null>(null);

  const commentCountByField = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of comments) {
      map.set(c.fieldName, (map.get(c.fieldName) || 0) + 1);
    }
    return map;
  }, [comments]);

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

  const handleResolve = (reviewId: string) => {
    startTransition(async () => {
      const result = await resolveReviewComment(reviewId, projectId);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Comentário resolvido");
        router.refresh();
      }
    });
  };

  const handleReopen = (reviewId: string) => {
    startTransition(async () => {
      const result = await reopenReviewComment(reviewId, projectId);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Comentário reaberto");
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-4">
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
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} comentário{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nenhum comentário encontrado.
        </p>
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              projectId={projectId}
              isPending={isPending}
              isCoordinator={isCoordinator}
              onResolve={() => handleResolve(c.id)}
              onReopen={() => handleReopen(c.id)}
              onEditField={() => setEditingField(c.fieldName)}
            />
          ))}
        </div>
      )}

      {isCoordinator && editingField && (
        <EditFieldDialog
          projectId={projectId}
          fieldName={editingField}
          allFields={fields}
          commentCount={commentCountByField.get(editingField) || 0}
          open={!!editingField}
          onOpenChange={(open) => {
            if (!open) setEditingField(null);
          }}
        />
      )}
    </div>
  );
}
