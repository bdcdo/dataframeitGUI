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
import { useReviewQueueNavigation } from "@/hooks/useReviewQueueNavigation";

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
  queueUserId: string;
  /** lista de pesquisadores do projeto, para o seletor do coordenador */
  reviewers: AutoReviewQueueOwner[];
  /** membro canônico dono da fila própria */
  ownQueueUserId: string;
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
  queueUserId,
  reviewers,
  ownQueueUserId,
}: AutoReviewPageProps) {
  const { push } = useRouter();
  const searchParams = useSearchParams();

  const isOwnQueue = queueUserId === ownQueueUserId;
  const readOnly = !isOwnQueue;

  // Seleção persistida em sessionStorage (restore + limpeza de órfão quando um
  // doc resolvido sai da fila) e estado da lista vivem no hook compartilhado.
  const { docIndex, listCollapsed, navigate, toggleList } =
    useReviewQueueNavigation(
      `${STORAGE_KEY_PREFIX}${projectId}:${queueUserId}`,
      docs,
    );
  // Estado compartilhado entre a contagem de pendentes da sidebar
  // (docListEntries) e a interação de campo (AutoReviewPageContent); por isso
  // vive aqui, no pai, e não no Content. A chave é fieldReviewId, portanto um
  // ciclo novo nunca herda o rascunho mantido para o snapshot anterior.
  const [choices, setChoices] = useState<Record<string, SelfVerdict>>({});
  const [justifications, setJustifications] = useState<Record<string, string>>(
    {},
  );

  function handleViewAsChange(newUserId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (newUserId === ownQueueUserId) {
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
          const k = choiceKey(f.fieldReviewId);
          return !isAutoReviewFieldDecided(
            false,
            choices[k],
            justifications[k],
          );
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
        queueUserId={queueUserId}
        ownQueueUserId={ownQueueUserId}
        onViewAsChange={handleViewAsChange}
      />
    );
  }

  const doc = docs[docIndex];
  const currentReviewer = reviewers.find((r) => r.userId === queueUserId);
  const reviewerLabel =
    currentReviewer?.name ?? currentReviewer?.email ?? queueUserId.slice(0, 8);

  return (
    <div className="flex h-[calc(100vh-96px)] flex-col">
      <AutoReviewPageHeader
        readOnly={readOnly}
        reviewerLabel={reviewerLabel}
        isCoordinator={isCoordinator}
        reviewers={reviewers}
        queueUserId={queueUserId}
        ownQueueUserId={ownQueueUserId}
        onViewAsChange={handleViewAsChange}
        docsCount={docs.length}
        docIndex={docIndex}
        onNavigate={navigate}
      />

      <div className="flex flex-1 overflow-hidden">
        <AutoReviewDocList
          docs={docListEntries}
          currentIndex={docIndex}
          onSelect={navigate}
          collapsed={listCollapsed}
          onToggle={toggleList}
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
