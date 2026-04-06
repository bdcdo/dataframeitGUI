"use client";

import { useState, useEffect, useMemo, useTransition, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
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
  ChevronDown,
  Check,
  X,
  Loader2,
  MessageSquare,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isAnswerCorrect } from "@/lib/reviews/queries";
import { getDocumentText } from "@/actions/documents";
import { acknowledgeVerdict } from "@/actions/verdicts";
import { toast } from "sonner";
import type { VerdictItem } from "@/app/(app)/projects/[id]/reviews/my-verdicts/page";
import type { PydanticField } from "@/lib/types";
import { AddNoteButton } from "@/components/shared/AddNoteButton";

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

function formatVerdictDisplay(verdict: string, fieldType?: string): string {
  if (verdict === "ambiguo") return "Ambíguo";
  if (verdict === "pular") return "Pular";
  if (fieldType === "multi" || verdict.startsWith("{")) {
    try {
      const parsed = JSON.parse(verdict) as Record<string, boolean>;
      const selected = Object.entries(parsed)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return selected.length > 0 ? selected.join("; ") : "(nenhuma)";
    } catch {
      // fallback
    }
  }
  return verdict;
}

/** Sort priority: incorrect+pending first, then incorrect+questioned, then incorrect+accepted, then correct */
function verdictSortKey(item: VerdictItem): number {
  if (!item.isCorrect) {
    if (!item.acknowledgmentStatus || item.acknowledgmentStatus === "pending") return 0;
    if (item.acknowledgmentStatus === "questioned") return 1;
    return 2; // accepted
  }
  return 3; // correct
}

export interface RespondentOption {
  id: string;
  name: string;
}

interface MyVerdictsViewProps {
  projectId: string;
  items: VerdictItem[];
  fields: PydanticField[];
  userName: string;
  isCoordinator?: boolean;
  respondents?: RespondentOption[];
  currentViewUserId?: string;
}

type FilterValue = "pending" | "incorrect" | "questioned" | "all";

export function MyVerdictsView({
  projectId,
  items,
  fields,
  userName,
  isCoordinator,
  respondents = [],
  currentViewUserId,
}: MyVerdictsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [commentingReviewId, setCommentingReviewId] = useState<string | null>(null);
  const [questionComment, setQuestionComment] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [fieldFilter, setFieldFilter] = useState("all");

  // Determine default filter: if there are pending items, start with "pending"
  const hasPendingItems = useMemo(
    () => items.some((i) => !i.isCorrect && (!i.acknowledgmentStatus || i.acknowledgmentStatus === "pending")),
    [items],
  );
  const [filter, setFilter] = useState<FilterValue>(hasPendingItems ? "pending" : "all");

  const totalIncorrect = useMemo(() => items.filter((i) => !i.isCorrect).length, [items]);
  const totalPending = useMemo(
    () => items.filter((i) => !i.isCorrect && (!i.acknowledgmentStatus || i.acknowledgmentStatus === "pending")).length,
    [items],
  );
  const totalQuestioned = useMemo(
    () => items.filter((i) => i.acknowledgmentStatus === "questioned").length,
    [items],
  );
  const totalItems = items.length;

  // If filter is "pending" but there are no pending items, fall back to "all"
  const effectiveFilter: FilterValue =
    filter === "pending" && totalPending === 0 ? "all" : filter;

  // Group by document with filters, search, sort
  const docGroups = useMemo(() => {
    let filtered = items;

    // Status filter
    if (effectiveFilter === "incorrect") filtered = filtered.filter((i) => !i.isCorrect);
    if (effectiveFilter === "pending")
      filtered = filtered.filter(
        (i) => !i.isCorrect && (!i.acknowledgmentStatus || i.acknowledgmentStatus === "pending"),
      );
    if (effectiveFilter === "questioned")
      filtered = filtered.filter((i) => i.acknowledgmentStatus === "questioned");

    // Field filter
    if (fieldFilter !== "all") filtered = filtered.filter((i) => i.fieldName === fieldFilter);

    // Search by document title
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((i) => i.documentTitle.toLowerCase().includes(q));
    }

    // Group by document
    const map = new Map<string, { title: string; items: VerdictItem[] }>();
    for (const item of filtered) {
      if (!map.has(item.documentId)) {
        map.set(item.documentId, { title: item.documentTitle, items: [] });
      }
      map.get(item.documentId)!.items.push(item);
    }

    // Sort items within each document by priority
    const groups = [...map.entries()].map(([docId, data]) => {
      data.items.sort((a, b) => verdictSortKey(a) - verdictSortKey(b));
      return { docId, ...data };
    });

    // Sort documents: those with pending items first
    groups.sort((a, b) => {
      const aMin = Math.min(...a.items.map(verdictSortKey));
      const bMin = Math.min(...b.items.map(verdictSortKey));
      return aMin - bMin;
    });

    return groups;
  }, [items, effectiveFilter, fieldFilter, searchQuery]);

  const [docIndex, setDocIndex] = useState(0);
  const [docTextCache, setDocTextCache] = useState<Record<string, string>>({});
  const [loadingText, setLoadingText] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentGroup = docGroups[docIndex];
  const currentDocId = currentGroup?.docId;
  const currentText = currentDocId ? docTextCache[currentDocId] : undefined;

  // Reset doc index when filters change
  useEffect(() => {
    setDocIndex(0);
  }, [filter, fieldFilter, searchQuery]);

  // Scroll to top when document changes
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [docIndex]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDocId, projectId]);

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

  const selectRespondent = (userId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (userId) {
      params.set("viewAsUser", userId);
    } else {
      params.delete("viewAsUser");
    }
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ""}`);
  };

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
      <div className="border-b px-4 py-2 space-y-1.5">
        {/* Row 1: main filters + navigation */}
        <div className="flex items-center gap-2">
          <Input
            placeholder="Buscar documento..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-44 h-8 text-xs"
          />
          <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
            <SelectTrigger className="w-48 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos ({totalItems})</SelectItem>
              <SelectItem value="incorrect">Incorretos ({totalIncorrect})</SelectItem>
              <SelectItem value="pending">Aguardando feedback ({totalPending})</SelectItem>
              <SelectItem value="questioned">Com dúvida ({totalQuestioned})</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {totalItems - totalIncorrect}/{totalItems} corretos
          </span>
          <div className="ml-auto flex items-center gap-1">
            {isCoordinator && respondents.length > 0 && (
              <Select
                value={currentViewUserId || "_self"}
                onValueChange={(v) => selectRespondent(v === "_self" ? null : v)}
              >
                <SelectTrigger className="w-40 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_self">Minhas respostas</SelectItem>
                  {respondents.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {docGroups.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={docIndex === 0}
                  onClick={() => setDocIndex(docIndex - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">
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
              </>
            )}
          </div>
        </div>
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
            <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                  {currentGroup.title}
                </p>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Select value={fieldFilter} onValueChange={setFieldFilter}>
                    <SelectTrigger className="w-36 h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-w-[min(24rem,calc(100vw-3rem))]">
                      <SelectItem value="all">Todos os campos</SelectItem>
                      {fields.map((f) => (
                        <SelectItem key={f.name} value={f.name}>
                          <div className="flex flex-col items-start gap-0.5">
                            <code className="text-xs font-mono">{f.name}</code>
                            {f.description && f.description !== f.name && (
                              <span className="text-[11px] text-muted-foreground line-clamp-2">
                                {f.description}
                              </span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <AddNoteButton
                    projectId={projectId}
                    documentId={currentGroup.docId}
                    documentTitle={currentGroup.title}
                    fields={fields}
                  />
                </div>
              </div>
              {currentGroup.items.map((item) => (
                <VerdictCard
                  key={item.reviewId}
                  item={item}
                  userName={userName}
                  isPending={isPending}
                  commentingReviewId={commentingReviewId}
                  questionComment={questionComment}
                  onSetCommentingReviewId={setCommentingReviewId}
                  onSetQuestionComment={setQuestionComment}
                  onAcknowledge={handleAcknowledge}
                />
              ))}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}

/* ── Verdict Card ── */

function VerdictCard({
  item,
  userName,
  isPending,
  commentingReviewId,
  questionComment,
  onSetCommentingReviewId,
  onSetQuestionComment,
  onAcknowledge,
}: {
  item: VerdictItem;
  userName: string;
  isPending: boolean;
  commentingReviewId: string | null;
  questionComment: string;
  onSetCommentingReviewId: (id: string | null) => void;
  onSetQuestionComment: (v: string) => void;
  onAcknowledge: (reviewId: string, status: "accepted" | "questioned", comment?: string) => void;
}) {
  const isSpecialVerdict = item.verdict === "ambiguo" || item.verdict === "pular";

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        item.isCorrect
          ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20"
          : "border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20",
      )}
    >
      {/* Field description + correct/incorrect */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium leading-tight">
            {item.fieldDescription}
          </p>
          <code className="text-[10px] font-mono text-muted-foreground/60">
            {item.fieldName}
          </code>
        </div>
        {item.isCorrect ? (
          <Badge className="shrink-0 bg-green-500/10 text-green-700 text-xs">
            <Check className="mr-1 h-3 w-3" /> Correta
          </Badge>
        ) : (
          <Badge className="shrink-0 bg-red-500/10 text-red-700 text-xs">
            <X className="mr-1 h-3 w-3" /> Incorreta
          </Badge>
        )}
      </div>

      {/* Verdict with colored background */}
      <div
        className={cn(
          "flex items-center gap-2 rounded px-2 py-1 text-xs",
          isSpecialVerdict
            ? "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
            : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
        )}
      >
        <span className="font-medium">Gabarito:</span>
        <span className="font-medium">{formatVerdictDisplay(item.verdict, item.fieldType)}</span>
      </div>

      {/* All responses from snapshot with correctness */}
      {item.responseSnapshot && item.responseSnapshot.length > 0 && (
        <div className="space-y-0.5 rounded-md bg-background/80 p-2">
          {item.responseSnapshot.map((r) => (
            <RespondentRow
              key={r.id}
              respondent={r}
              isMe={r.respondent_name === userName}
              isSpecialVerdict={isSpecialVerdict}
              verdict={item.verdict}
              fieldType={item.fieldType}
            />
          ))}
        </div>
      )}

      {/* Coordinator comment */}
      {item.coordinatorComment && (
        <blockquote className="border-l-2 pl-3 text-xs text-muted-foreground">
          {item.coordinatorComment}
        </blockquote>
      )}

      {/* Acknowledgment actions — incorretos: aceitar + comentar; ambíguos: só comentar */}
      {(!item.isCorrect || isSpecialVerdict) && (
        <div className="flex items-center gap-2">
          {(!item.acknowledgmentStatus || item.acknowledgmentStatus === "pending") && (
            <>
              {!item.isCorrect && (
                <Button
                  variant="default"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={isPending}
                  onClick={() => onAcknowledge(item.reviewId, "accepted")}
                >
                  <Check className="mr-1 h-3 w-3" />
                  Aceitar correção
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                disabled={isPending}
                onClick={() =>
                  onSetCommentingReviewId(
                    commentingReviewId === item.reviewId ? null : item.reviewId,
                  )
                }
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
            onChange={(e) => onSetQuestionComment(e.target.value)}
            placeholder="Qual a sua dúvida?"
            className="text-xs h-7"
          />
          <Button
            size="sm"
            className="h-7 text-xs shrink-0"
            disabled={isPending || !questionComment.trim()}
            onClick={() =>
              onAcknowledge(item.reviewId, "questioned", questionComment)
            }
          >
            Enviar
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── Respondent Row ── */

function RespondentRow({
  respondent,
  isMe,
  isSpecialVerdict,
  verdict,
  fieldType,
}: {
  respondent: NonNullable<VerdictItem["responseSnapshot"]>[number];
  isMe: boolean;
  isSpecialVerdict: boolean;
  verdict: string;
  fieldType: VerdictItem["fieldType"];
}) {
  const [showJustification, setShowJustification] = useState(false);
  const correct = isSpecialVerdict || isAnswerCorrect(respondent.answer, verdict, fieldType);

  return (
    <div className="space-y-0.5">
      <div
        className={cn(
          "flex items-center gap-2 rounded px-2 py-1 text-xs",
          isMe && "bg-brand/5 font-medium",
        )}
      >
        {/* Correctness icon */}
        {!isSpecialVerdict && (
          correct ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          ) : (
            <X className="h-3.5 w-3.5 shrink-0 text-red-500" />
          )
        )}

        {/* Answer */}
        <span
          className={cn(
            "min-w-0 truncate",
            !isSpecialVerdict && !correct && "text-red-600 dark:text-red-400",
          )}
        >
          {formatAnswer(respondent.answer) || (
            <span className="italic text-muted-foreground">sem resposta</span>
          )}
        </span>

        {/* Respondent info */}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {respondent.respondent_type === "llm" && (
            <Bot className="h-3 w-3" />
          )}
          {isMe ? (
            <>
              <span className="text-brand">★</span>
              <span className="font-medium">Você</span>
            </>
          ) : (
            respondent.respondent_name
          )}
        </span>

        {/* Justification toggle */}
        {respondent.justification && (
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

      {/* Expandable justification */}
      {showJustification && respondent.justification && (
        <blockquote className="ml-6 border-l-2 pl-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {respondent.justification}
        </blockquote>
      )}
    </div>
  );
}
