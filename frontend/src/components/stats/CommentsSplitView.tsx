"use client";

import { useState, useEffect, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "@/components/coding/DocumentReader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  RotateCcw,
  Loader2,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getDocumentText } from "@/actions/documents";
import {
  resolveReviewComment,
  reopenReviewComment,
  resolveDifficulty,
  reopenDifficulty,
} from "@/actions/stats";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import type { ReviewComment, ResponseSnapshotEntry } from "./CommentCard";

function formatAnswer(answer: unknown): string {
  if (answer === null || answer === undefined) return "(sem resposta)";
  if (Array.isArray(answer)) return answer.join(", ");
  return String(answer);
}

function verdictVariant(verdict: string): "default" | "secondary" | "outline" {
  if (verdict === "ambiguo") return "secondary";
  if (verdict === "pular") return "outline";
  return "default";
}

function formatVerdictLabel(verdict: string): string {
  if (verdict === "ambiguo") return "Ambíguo";
  if (verdict === "pular") return "Pular";
  if (verdict.startsWith("{")) {
    try {
      const parsed = JSON.parse(verdict) as Record<string, boolean>;
      const selected = Object.entries(parsed)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return selected.length > 0 ? selected.join(", ") : "(nenhuma)";
    } catch {
      // fallback
    }
  }
  return verdict;
}

interface CommentsSplitViewProps {
  projectId: string;
  comments: ReviewComment[];
  initialDocId: string;
  onBack: () => void;
}

export function CommentsSplitView({
  projectId,
  comments,
  initialDocId,
  onBack,
}: CommentsSplitViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showResolved, setShowResolved] = useState(false);

  // Group comments by document, preserving order of first occurrence
  const docGroups = useMemo(() => {
    const map = new Map<string, { title: string; comments: ReviewComment[] }>();
    for (const c of comments) {
      if (!map.has(c.documentId)) {
        map.set(c.documentId, { title: c.documentTitle, comments: [] });
      }
      map.get(c.documentId)!.comments.push(c);
    }
    return [...map.entries()].map(([docId, data]) => ({
      docId,
      ...data,
    }));
  }, [comments]);

  const initialIdx = Math.max(
    docGroups.findIndex((g) => g.docId === initialDocId),
    0,
  );
  const [docIndex, setDocIndex] = useState(initialIdx);
  const [docTextCache, setDocTextCache] = useState<
    Record<string, string>
  >({});
  const [loadingText, setLoadingText] = useState(false);

  const currentGroup = docGroups[docIndex];
  const currentDocId = currentGroup?.docId;
  const currentText = currentDocId ? docTextCache[currentDocId] : undefined;

  // Lazy-load document text
  useEffect(() => {
    if (!currentDocId || docTextCache[currentDocId]) return;
    let cancelled = false;
    setLoadingText(true);
    getDocumentText(projectId, currentDocId).then((result) => {
      if (cancelled) return;
      setDocTextCache((prev) => ({
        ...prev,
        [currentDocId]: result?.text ?? "(Documento não encontrado)",
      }));
      setLoadingText(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentDocId, projectId, docTextCache]);

  const handleResolve = (comment: ReviewComment) => {
    startTransition(async () => {
      let result;
      if (comment.source === "dificuldade" && comment.difficultyResponseId) {
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
      if (comment.source === "dificuldade" && comment.difficultyResponseId) {
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

  if (!currentGroup) return null;

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col">
      {/* Navigation bar */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
            <ArrowLeft className="h-3.5 w-3.5" />
            Voltar à lista
          </Button>
          <span className="text-sm text-muted-foreground">
            {currentGroup.title}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={docIndex === 0}
            onClick={() => setDocIndex(docIndex - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {docIndex + 1}/{docGroups.length}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={docIndex === docGroups.length - 1}
            onClick={() => setDocIndex(docIndex + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Split panels */}
      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={55} minSize={25}>
          {loadingText || !currentText ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <DocumentReader text={currentText} />
          )}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={45} minSize={25}>
          <div className="h-full overflow-y-auto px-4 py-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                {(() => {
                  const visible = showResolved
                    ? currentGroup.comments
                    : currentGroup.comments.filter((c) => !c.resolvedAt);
                  const hidden = currentGroup.comments.length - visible.length;
                  return (
                    <>
                      {visible.length} comentário{visible.length !== 1 && "s"}
                      {!showResolved && hidden > 0 && (
                        <span className="ml-1 text-muted-foreground/60">
                          ({hidden} resolvido{hidden !== 1 ? "s" : ""} oculto{hidden !== 1 ? "s" : ""})
                        </span>
                      )}
                    </>
                  );
                })()}
              </p>
              <div className="flex items-center gap-1.5">
                <Switch
                  checked={showResolved}
                  onCheckedChange={setShowResolved}
                  className="scale-75"
                />
                <span className="text-xs text-muted-foreground">Mostrar resolvidos</span>
              </div>
            </div>
            {(showResolved
              ? currentGroup.comments
              : currentGroup.comments.filter((c) => !c.resolvedAt)
            ).map((comment) => {
              const isResolved = !!comment.resolvedAt;
              const snapshot = comment.responseSnapshot;

              return (
                <div
                  key={comment.id}
                  className={cn(
                    "space-y-2 rounded-lg border p-3",
                    isResolved && "opacity-60",
                  )}
                >
                  {/* Field name + verdict */}
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-xs font-mono text-muted-foreground/70">
                      {comment.fieldName}
                    </code>
                    <Badge
                      variant={verdictVariant(comment.verdict)}
                      className="shrink-0 text-xs"
                    >
                      {formatVerdictLabel(comment.verdict)}
                    </Badge>
                  </div>

                  {/* Responses (inline, from snapshot) */}
                  {snapshot && snapshot.length > 0 && (
                    <div className="space-y-0.5 rounded-md bg-muted/50 p-2">
                      {snapshot.map((r: ResponseSnapshotEntry, i: number) => (
                        <div
                          key={i}
                          className={cn(
                            "flex items-start gap-2 rounded px-2 py-1 text-xs",
                            r.id === comment.chosenResponseId && "bg-brand/5",
                          )}
                        >
                          {r.id === comment.chosenResponseId && (
                            <Check className="mt-0.5 h-3 w-3 shrink-0 text-brand" />
                          )}
                          <div className="min-w-0">
                            <span className="font-medium">
                              {r.respondent_name}
                            </span>
                            <Badge
                              variant="outline"
                              className="ml-1.5 text-[10px] px-1 py-0"
                            >
                              {r.respondent_type === "humano" ? "Humano" : "LLM"}
                            </Badge>
                            <span className="ml-2 text-muted-foreground">
                              {formatAnswer(r.answer)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Comment text */}
                  <blockquote className="border-l-2 pl-3 text-sm text-foreground">
                    {comment.comment}
                  </blockquote>

                  {/* Footer */}
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {comment.reviewerName} &middot;{" "}
                      {new Date(comment.createdAt).toLocaleDateString("pt-BR")}
                      {isResolved && (
                        <span className="ml-2 text-green-600">
                          (resolvido em{" "}
                          {new Date(comment.resolvedAt!).toLocaleDateString(
                            "pt-BR",
                          )}
                          )
                        </span>
                      )}
                    </p>
                    {isResolved ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isPending}
                        onClick={() => handleReopen(comment)}
                        title="Reabrir"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isPending}
                        onClick={() => handleResolve(comment)}
                        title="Resolver"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
