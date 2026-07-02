"use client";

import { useMemo, useState } from "react";
import { usePinnedDoc, pinnedDocIndex } from "@/hooks/usePinnedDoc";
import { useArbitrationDoc } from "@/hooks/useArbitrationDoc";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";
import { type ArbitrationDocListEntry } from "./ArbitrationDocList";
import { ArbitrationEmptyState } from "./ArbitrationEmptyState";
import { ArbitrationPageHeader } from "./ArbitrationPageHeader";
import { ArbitrationPageContent } from "./ArbitrationPageContent";

export interface ArbitrationField {
  fieldReviewId: string;
  fieldName: string;
  aAnswer: unknown;
  bAnswer: unknown;
  blindVerdict: ArbitrationVerdict | null;
  reveal: {
    aSide: ArbitrationVerdict;
    bSide: ArbitrationVerdict;
    humanName: string | null;
    llmName: string | null;
    llmJustification: string | null;
    selfJustification: string | null;
  } | null;
}

export interface ArbitrationDoc {
  docId: string;
  title: string | null;
  externalId: string | null;
  text: string;
  fields: ArbitrationField[];
}

export interface ArbitrationPageProps {
  projectId: string;
  projectName: string;
  fields: PydanticField[];
  docs: ArbitrationDoc[];
  arbitrationBlind: boolean;
}

const STORAGE_KEY_PREFIX = "arbitration:docId:";

export function ArbitrationPage({
  projectId,
  fields,
  docs,
  arbitrationBlind,
}: ArbitrationPageProps) {
  const storageKey = `${STORAGE_KEY_PREFIX}${projectId}`;
  const validDocIds = useMemo(() => docs.map((d) => d.docId), [docs]);
  // Seleção persistida em sessionStorage (restore + limpeza de órfão) encapsulada
  // em usePinnedDoc — o hook lê via useSyncExternalStore (sem effect de restore).
  const [pinnedDocId, setPinnedDocId] = usePinnedDoc(storageKey, {
    validIds: validDocIds,
  });

  const docIndex = useMemo(
    () => pinnedDocIndex(validDocIds, pinnedDocId),
    [validDocIds, pinnedDocId],
  );

  const [listCollapsed, setListCollapsed] = useState(false);

  const fieldMeta = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );

  function handleDocNavigate(newIndex: number) {
    const clamped = Math.max(0, Math.min(newIndex, docs.length - 1));
    const target = docs[clamped];
    if (target) setPinnedDocId(target.docId);
  }

  const doc = docs[docIndex];
  const arb = useArbitrationDoc({
    doc,
    docIndex,
    docsLength: docs.length,
    projectId,
    onNavigate: handleDocNavigate,
  });

  const docListEntries: ArbitrationDocListEntry[] = useMemo(
    () =>
      docs.map((d) => ({
        id: d.docId,
        title: d.title,
        externalId: d.externalId,
        totalFields: d.fields.length,
        blindDecided: d.fields.filter((f) => f.blindVerdict !== null).length,
        // finalDecided deriva de effectiveFinalChoices: para o doc atual inclui
        // o piso do verdict cego (fase reveal); para os demais, só os overrides
        // já feitos. Os campos vêm do server com final_verdict=NULL.
        finalDecided: d.fields.filter(
          (f) => arb.effectiveFinalChoices[f.fieldReviewId] != null,
        ).length,
      })),
    [docs, arb.effectiveFinalChoices],
  );

  if (docs.length === 0) {
    return <ArbitrationEmptyState />;
  }

  return (
    <div className="flex h-[calc(100vh-96px)] flex-col">
      <ArbitrationPageHeader
        phase={arb.phase}
        docIndex={docIndex}
        docsLength={docs.length}
        submitting={arb.submitting}
        allBlindChosen={arb.allBlindChosen}
        allFinalChosen={arb.allFinalChosen}
        onNavigate={handleDocNavigate}
        onBackToBlind={arb.onBackToBlind}
        onBlindSubmit={arb.handleBlindSubmit}
        onFinalSubmit={arb.handleFinalSubmit}
      />
      <ArbitrationPageContent
        doc={doc}
        fieldMeta={fieldMeta}
        phase={arb.phase}
        arbitrationBlind={arbitrationBlind}
        docListEntries={docListEntries}
        docIndex={docIndex}
        listCollapsed={listCollapsed}
        onSelectDoc={handleDocNavigate}
        onToggleList={() => setListCollapsed((v) => !v)}
        blindChoices={arb.blindChoices}
        finalChoices={arb.effectiveFinalChoices}
        suggestions={arb.suggestions}
        comments={arb.comments}
        onChooseBlind={arb.onChooseBlind}
        onChooseFinal={arb.onChooseFinal}
        onSuggestion={arb.onSuggestion}
        onComment={arb.onComment}
      />
    </div>
  );
}
