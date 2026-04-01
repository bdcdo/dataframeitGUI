"use client";

import { useState, useEffect, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "@/components/coding/DocumentReader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getDocumentText } from "@/actions/documents";
import { acknowledgeVerdict } from "@/actions/verdicts";
import { toast } from "sonner";
import type { VerdictItem } from "@/app/(app)/projects/[id]/reviews/my-verdicts/page";
import type { PydanticField } from "@/lib/types";

function formatAnswer(answer: unknown): string {
  if (answer == null) return "(sem resposta)";
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer)) return answer.join(", ");
  if (typeof answer === "object") {
    return Object.entries(answer as Record<string, unknown>)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
  }
  return String(answer);
}

function formatVerdictDisplay(verdict: string): string {
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

interface MyVerdictsViewProps {
  projectId: string;
  items: VerdictItem[];
  fields: PydanticField[];
  userName: string;
}

export function MyVerdictsView({
  projectId,
  items,
  fields,
  userName,
}: MyVerdictsViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [filter, setFilter] = useState("all");
  const [commentingReviewId, setCommentingReviewId] = useState<string | null>(null);
  const [questionComment, setQuestionComment] = useState("");

  // Group by document
  const docGroups = useMemo(() => {
    let filtered = items;
    if (filter === "incorrect") filtered = items.filter((i) => !i.isCorrect);
    if (filter === "pending") filtered = items.filter((i) => !i.acknowledgmentStatus || i.acknowledgmentStatus === "pending");
    if (filter === "questioned") filtered = items.filter((i) => i.acknowledgmentStatus === "questioned");

    const map = new Map<string, { title: string; items: VerdictItem[] }>();
    for (const item of filtered) {
      if (!map.has(item.documentId)) {
        map.set(item.documentId, { title: item.documentTitle, items: [] });
      }
      map.get(item.documentId)!.items.push(item);
    }
    return [...map.entries()].map(([docId, data]) => ({ docId, ...data }));
  }, [items, filter]);

  const [docIndex, setDocIndex] = useState(0);
  const [docTextCache, setDocTextCache] = useState<Record<string, string>>({});
  const [loadingText, setLoadingText] = useState(false);

  const currentGroup = docGroups[docIndex];
  const currentDocId = currentGroup?.docId;
  const currentText = currentDocId ? docTextCache[currentDocId] : undefined;

  // Reset doc index when filter changes
  useEffect(() => {
    setDocIndex(0);
  }, [filter]);

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
    return () => { cancelled = true; };
  }, [currentDocId, projectId, docTextCache]);

  const handleAcknowledge = (reviewId: string, status: "accepted" | "questioned", comment?: string) => {
    startTransition(async () => {
      const result = await acknowledgeVerdict(reviewId, projectId, status, comment);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(status === "accepted" ? "Correção aceita" : "Dúvida enviada");
        setCommentingReviewId(null);
        setQuestionComment("");
        router.refresh();
      }
    });
  };

  const totalIncorrect = items.filter((i) => !i.isCorrect).length;
  const totalItems = items.length;

  if (totalItems === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhum veredito encontrado para suas respostas.
      </p>
    );
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos ({totalItems})</SelectItem>
              <SelectItem value="incorrect">Incorretos ({totalIncorrect})</SelectItem>
              <SelectItem value="pending">Pendentes</SelectItem>
              <SelectItem value="questioned">Com dúvida</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {totalItems - totalIncorrect}/{totalItems} corretos
          </span>
        </div>
        {docGroups.length > 0 && (
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
        )}
      </div>

      {docGroups.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nenhum resultado para este filtro.
        </p>
      ) : (
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
              <p className="text-xs font-medium text-muted-foreground">
                {currentGroup.title}
              </p>
              {currentGroup.items.map((item) => (
                <div
                  key={item.reviewId}
                  className={cn(
                    "space-y-2 rounded-lg border p-3",
                    item.isCorrect
                      ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20"
                      : "border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20",
                  )}
                >
                  {/* Field name + correct/incorrect */}
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-xs font-mono text-muted-foreground/70">
                      {item.fieldName}
                    </code>
                    {item.isCorrect ? (
                      <Badge className="bg-green-500/10 text-green-700 text-xs">
                        <Check className="mr-1 h-3 w-3" /> Correta
                      </Badge>
                    ) : (
                      <Badge className="bg-red-500/10 text-red-700 text-xs">
                        <X className="mr-1 h-3 w-3" /> Incorreta
                      </Badge>
                    )}
                  </div>

                  {/* All responses from snapshot */}
                  {item.responseSnapshot && item.responseSnapshot.length > 0 && (
                    <div className="space-y-0.5 rounded-md bg-background/80 p-2">
                      {item.responseSnapshot.map((r, i) => {
                        const isMe = r.respondent_name === userName || r.respondent_type === "humano";
                        return (
                          <div
                            key={i}
                            className={cn(
                              "flex items-start gap-2 rounded px-2 py-1 text-xs",
                              isMe && r.respondent_name === userName && "bg-brand/5 font-medium",
                            )}
                          >
                            <div className="min-w-0">
                              {r.respondent_name === userName && (
                                <span className="mr-1 text-brand">★</span>
                              )}
                              <span className={r.respondent_name === userName ? "font-medium" : ""}>
                                {r.respondent_name === userName ? "Você" : r.respondent_name}
                              </span>
                              <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0">
                                {r.respondent_type === "humano" ? "Humano" : "LLM"}
                              </Badge>
                              <span className="ml-2 text-muted-foreground">
                                {formatAnswer(r.answer)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Verdict */}
                  <div className="text-xs">
                    <span className="text-muted-foreground">Gabarito: </span>
                    <span className="font-medium">{formatVerdictDisplay(item.verdict)}</span>
                  </div>

                  {/* Coordinator comment */}
                  {item.coordinatorComment && (
                    <blockquote className="border-l-2 pl-3 text-xs text-muted-foreground">
                      {item.coordinatorComment}
                    </blockquote>
                  )}

                  {/* Acknowledgment actions */}
                  {!item.isCorrect && (
                    <div className="flex items-center gap-2">
                      {(!item.acknowledgmentStatus || item.acknowledgmentStatus === "pending") && (
                        <>
                          <Button
                            variant="default"
                            size="sm"
                            className="h-6 text-xs"
                            disabled={isPending}
                            onClick={() => handleAcknowledge(item.reviewId, "accepted")}
                          >
                            <Check className="mr-1 h-3 w-3" />
                            Aceitar correção
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs"
                            disabled={isPending}
                            onClick={() => setCommentingReviewId(
                              commentingReviewId === item.reviewId ? null : item.reviewId,
                            )}
                          >
                            <MessageSquare className="mr-1 h-3 w-3" />
                            Comentar dúvida
                          </Button>
                        </>
                      )}
                      {item.acknowledgmentStatus === "accepted" && (
                        <Badge className="text-xs bg-green-500/10 text-green-700">Aceita</Badge>
                      )}
                      {item.acknowledgmentStatus === "questioned" && (
                        <Badge className="text-xs bg-amber-500/10 text-amber-700">Dúvida enviada</Badge>
                      )}
                    </div>
                  )}

                  {/* Comment input */}
                  {commentingReviewId === item.reviewId && (
                    <div className="flex gap-2">
                      <Input
                        value={questionComment}
                        onChange={(e) => setQuestionComment(e.target.value)}
                        placeholder="Qual a sua dúvida?"
                        className="text-xs h-7"
                      />
                      <Button
                        size="sm"
                        className="h-7 text-xs shrink-0"
                        disabled={isPending || !questionComment.trim()}
                        onClick={() =>
                          handleAcknowledge(item.reviewId, "questioned", questionComment)
                        }
                      >
                        Enviar
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
