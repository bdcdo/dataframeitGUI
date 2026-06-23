"use client";

import { Suspense, useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "@/components/coding/DocumentReader";
import { Loader2 } from "lucide-react";
import { acknowledgeVerdict } from "@/actions/verdicts";
import { toast } from "sonner";
import { useDocumentText } from "@/hooks/useDocumentText";
import { useUrlState } from "@/hooks/useUrlState";
import {
  VerdictsHeader,
  type FilterValue,
  type RespondentOption,
} from "@/components/reviews/VerdictsHeader";
import { VerdictsList } from "@/components/reviews/VerdictsList";
import type { VerdictItem } from "@/app/(app)/projects/[id]/reviews/my-verdicts/page";
import type { PydanticField } from "@/lib/types";

/** Sort priority: incorrect+pending first, then incorrect+questioned, then incorrect+accepted, then correct */
function verdictSortKey(item: VerdictItem): number {
  if (!item.isCorrect) {
    if (!item.acknowledgmentStatus || item.acknowledgmentStatus === "pending") return 0;
    if (item.acknowledgmentStatus === "questioned") return 1;
    return 2; // accepted
  }
  return 3; // correct
}

const EMPTY_RESPONDENTS: RespondentOption[] = [];

interface MyVerdictsViewProps {
  projectId: string;
  items: VerdictItem[];
  fields: PydanticField[];
  userName: string;
  isCoordinator?: boolean;
  respondents?: RespondentOption[];
  currentViewUserId?: string;
}

export function MyVerdictsView(props: MyVerdictsViewProps) {
  // useSearchParams precisa de boundary de Suspense (react-doctor
  // nextjs-no-use-search-params-without-suspense).
  return (
    <Suspense fallback={null}>
      <MyVerdictsViewInner {...props} />
    </Suspense>
  );
}

function MyVerdictsViewInner({
  projectId,
  items,
  fields,
  userName,
  isCoordinator,
  respondents = EMPTY_RESPONDENTS,
  currentViewUserId,
}: MyVerdictsViewProps) {
  const { refresh } = useRouter();
  const { set: setUrlState } = useUrlState();
  const [isPending, startTransition] = useTransition();
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

  // Selected document tracked by identity; index is derived (molde:
  // AutoReviewPage). Quando o filtro tira o doc do grupo, findIndex → -1 e o
  // índice cai para 0 naturalmente — sem effect de reset.
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const docIndex = useMemo(() => {
    if (docGroups.length === 0) return 0;
    if (selectedDocId) {
      const i = docGroups.findIndex((g) => g.docId === selectedDocId);
      if (i >= 0) return i;
    }
    return 0;
  }, [docGroups, selectedDocId]);

  const currentGroup = docGroups[docIndex];
  const currentDocId = currentGroup?.docId;
  const { text: currentText, loading: loadingText } = useDocumentText(
    projectId,
    currentDocId,
  );

  const goToIndex = (i: number) => {
    const g = docGroups[i];
    if (g) setSelectedDocId(g.docId);
  };

  // Resolve true on success so the caller (VerdictsList) can clear its local
  // comment input only when the acknowledgment actually went through.
  const handleAcknowledge = (
    reviewId: string,
    status: "accepted" | "questioned",
    comment?: string,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      startTransition(async () => {
        try {
          const result = await acknowledgeVerdict(reviewId, projectId, status, comment);
          if (result.error) {
            toast.error(result.error);
            resolve(false);
          } else {
            toast.success(status === "accepted" ? "Correção aceita" : "Dúvida enviada");
            refresh();
            resolve(true);
          }
        } catch {
          // Server action rejeitou (rede/auth) — sem catch, a Promise nunca
          // resolveria e o input de dúvida ficaria pendente para sempre.
          toast.error("Não foi possível registrar. Tente novamente.");
          resolve(false);
        }
      });
    });

  const selectRespondent = (userId: string | null) =>
    startTransition(() => {
      setUrlState({ viewAsUser: userId }, { method: "push" });
    });

  if (totalItems === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhum veredito encontrado para suas respostas.
      </p>
    );
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col">
      <VerdictsHeader
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        filter={filter}
        onFilterChange={setFilter}
        totals={{
          items: totalItems,
          incorrect: totalIncorrect,
          pending: totalPending,
          questioned: totalQuestioned,
        }}
        isCoordinator={isCoordinator}
        respondents={respondents}
        currentViewUserId={currentViewUserId}
        onSelectRespondent={selectRespondent}
        isPending={isPending}
        docCount={docGroups.length}
        docIndex={docIndex}
        onPrev={() => goToIndex(docIndex - 1)}
        onNext={() => goToIndex(docIndex + 1)}
      />

      {docGroups.length === 0 || !currentGroup ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nenhum resultado para este filtro.
        </p>
      ) : (
        <ResizablePanelGroup className="flex-1">
          <ResizablePanel defaultSize={55} minSize={25}>
            {loadingText || !currentText ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <DocumentReader text={currentText} />
            )}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={45} minSize={25}>
            <VerdictsList
              group={currentGroup}
              fields={fields}
              fieldFilter={fieldFilter}
              onFieldFilterChange={setFieldFilter}
              projectId={projectId}
              userName={userName}
              isPending={isPending}
              onAcknowledge={handleAcknowledge}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
