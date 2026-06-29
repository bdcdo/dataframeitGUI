"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { DocumentReader } from "@/components/coding/DocumentReader";
import {
  AutoReviewDocList,
  type AutoReviewDocListEntry,
} from "./AutoReviewDocList";
import type { AutoReviewField } from "./AutoReviewFieldPanel";
import { AutoReviewEmptyState } from "./AutoReviewEmptyState";
import { AutoReviewPageHeader } from "./AutoReviewPageHeader";
import { AutoReviewPageContent } from "./AutoReviewPageContent";
import type { PydanticField, SelfVerdict } from "@/lib/types";
import { choiceKey, isAutoReviewFieldDecided } from "@/lib/auto-review-decided";
import { usePinnedDoc } from "@/hooks/usePinnedDoc";

export interface AutoReviewDoc {
  docId: string;
  title: string | null;
  externalId: string | null;
  text: string;
  fields: AutoReviewField[];
}

export interface AutoReviewQueueOwner {
  userId: string;
  email: string | null;
  name: string | null;
}

export interface AutoReviewPageProps {
  projectId: string;
  fields: PydanticField[];
  docs: AutoReviewDoc[];
  isCoordinator?: boolean;
  /** quando coordenador, vê a fila deste pesquisador (default = ele mesmo) */
  viewAsUserId: string;
  /** lista de pesquisadores do projeto, para o seletor do coordenador */
  reviewers: AutoReviewQueueOwner[];
  /** id do usuário logado (não muda quando coord visualiza outra fila) */
  currentUserId: string;
}

const STORAGE_KEY_PREFIX = "autoReview:docId:";

export function AutoReviewPage(props: AutoReviewPageProps) {
  // useSearchParams precisa de boundary de Suspense (react-doctor
  // nextjs-no-use-search-params-without-suspense).
  return (
    <Suspense fallback={null}>
      <AutoReviewPageInner {...props} />
    </Suspense>
  );
}

function AutoReviewPageInner({
  projectId,
  docs,
  isCoordinator = false,
  viewAsUserId,
  reviewers,
  currentUserId,
}: AutoReviewPageProps) {
  const { push } = useRouter();
  const searchParams = useSearchParams();

  const isOwnQueue = viewAsUserId === currentUserId;
  const readOnly = !isOwnQueue;

  const storageKey = `${STORAGE_KEY_PREFIX}${projectId}:${viewAsUserId}`;
  // Seleção persistida em sessionStorage (restore + limpeza de órfão quando um
  // doc resolvido sai da fila) encapsulada em usePinnedDoc — ver hook.
  const validDocIds = useMemo(() => docs.map((d) => d.docId), [docs]);
  const [pinnedDocId, setPinnedDocId] = usePinnedDoc(storageKey, {
    validIds: validDocIds,
  });

  const docIndex = useMemo(() => {
    if (docs.length === 0) return 0;
    if (pinnedDocId) {
      const i = docs.findIndex((d) => d.docId === pinnedDocId);
      if (i >= 0) return i;
    }
    return 0;
  }, [docs, pinnedDocId]);

  const [listCollapsed, setListCollapsed] = useState(false);
  // Estado compartilhado entre a contagem de pendentes da sidebar
  // (docListEntries) e a interação de campo (AutoReviewPageContent); por isso
  // vive aqui, no pai, e não no Content. Keyed por `${docId}::${fieldName}` —
  // o composto isola escolha/justificativa por (documento, campo).
  const [choices, setChoices] = useState<Record<string, SelfVerdict>>({});
  const [justifications, setJustifications] = useState<Record<string, string>>(
    {},
  );

  function handleDocNavigate(newIndex: number) {
    const clamped = Math.max(0, Math.min(newIndex, docs.length - 1));
    const target = docs[clamped];
    if (target) {
      setPinnedDocId(target.docId);
    }
  }

  function handleViewAsChange(newUserId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (newUserId === currentUserId) {
      params.delete("viewAs");
    } else {
      params.set("viewAs", newUserId);
    }
    push(`?${params.toString()}`);
  }

  const docListEntries: AutoReviewDocListEntry[] = useMemo(
    () =>
      docs.map((d) => {
        const total = d.fields.length;
        // Pendente = ainda não enviado e ainda não pronto pra enviar (um
        // contesta_llm sem justificativa conta como pendente).
        const pending = d.fields.filter((f) => {
          if (f.alreadyAnswered) return false;
          const k = choiceKey(d.docId, f.fieldName);
          return !isAutoReviewFieldDecided(false, choices[k], justifications[k]);
        }).length;
        return {
          id: d.docId,
          title: d.title,
          externalId: d.externalId,
          totalFields: total,
          pendingFields: pending,
        };
      }),
    [docs, choices, justifications],
  );

  if (docs.length === 0) {
    return (
      <AutoReviewEmptyState
        readOnly={readOnly}
        isCoordinator={isCoordinator}
        reviewers={reviewers}
        viewAsUserId={viewAsUserId}
        currentUserId={currentUserId}
        onViewAsChange={handleViewAsChange}
      />
    );
  }

  const doc = docs[docIndex];
  const currentReviewer = reviewers.find((r) => r.userId === viewAsUserId);
  const reviewerLabel =
    currentReviewer?.name ?? currentReviewer?.email ?? viewAsUserId.slice(0, 8);

  return (
    <div className="flex h-[calc(100vh-96px)] flex-col">
      <AutoReviewPageHeader
        readOnly={readOnly}
        reviewerLabel={reviewerLabel}
        isCoordinator={isCoordinator}
        reviewers={reviewers}
        viewAsUserId={viewAsUserId}
        currentUserId={currentUserId}
        onViewAsChange={handleViewAsChange}
        docsCount={docs.length}
        docIndex={docIndex}
        onNavigate={handleDocNavigate}
      />

      <div className="flex flex-1 overflow-hidden">
        <AutoReviewDocList
          docs={docListEntries}
          currentIndex={docIndex}
          onSelect={handleDocNavigate}
          collapsed={listCollapsed}
          onToggle={() => setListCollapsed((v) => !v)}
        />
        <ResizablePanelGroup className="flex-1">
          <ResizablePanel defaultSize={50} minSize={25}>
            <DocumentReader text={doc.text} />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={50} minSize={25}>
            {/* key={doc.docId}: remonta ao trocar de doc, resetando fieldIndex
                sem effect; o split (ResizablePanelGroup) fica fora e preserva
                o tamanho manual entre navegacoes. */}
            <AutoReviewPageContent
              key={doc.docId}
              doc={doc}
              projectId={projectId}
              readOnly={readOnly}
              choices={choices}
              justifications={justifications}
              setChoices={setChoices}
              setJustifications={setJustifications}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
