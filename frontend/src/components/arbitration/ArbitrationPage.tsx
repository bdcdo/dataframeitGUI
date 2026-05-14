"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { DocumentReader } from "@/components/coding/DocumentReader";
import {
  submitBlindVerdicts,
  submitFinalVerdicts,
  type BlindChoice,
  type FinalChoice,
} from "@/actions/field-reviews";
import {
  ArbitrationDocList,
  type ArbitrationDocListEntry,
} from "./ArbitrationDocList";
import { BlindPhase } from "./BlindPhase";
import { RevealPhase } from "./RevealPhase";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";

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

function computePhaseForDoc(doc: ArbitrationDoc | undefined): "blind" | "reveal" {
  if (!doc || doc.fields.length === 0) return "blind";
  return doc.fields.every((f) => f.blindVerdict !== null) ? "reveal" : "blind";
}

const STORAGE_KEY_PREFIX = "arbitration:docId:";

export function ArbitrationPage({
  projectId,
  fields,
  docs,
  arbitrationBlind,
}: ArbitrationPageProps) {
  const router = useRouter();
  const storageKey = `${STORAGE_KEY_PREFIX}${projectId}`;
  const [pinnedDocId, setPinnedDocId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = window.sessionStorage.getItem(storageKey);
    if (v) setPinnedDocId(v);
  }, [storageKey]);

  const docIndex = useMemo(() => {
    if (docs.length === 0) return 0;
    if (pinnedDocId) {
      const i = docs.findIndex((d) => d.docId === pinnedDocId);
      if (i >= 0) return i;
    }
    return 0;
  }, [docs, pinnedDocId]);

  const [phase, setPhase] = useState<"blind" | "reveal">(() =>
    computePhaseForDoc(docs[0]),
  );
  const [listCollapsed, setListCollapsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [blindChoices, setBlindChoices] = useState<Record<string, "a" | "b">>(
    {},
  );
  const [finalChoices, setFinalChoices] = useState<
    Record<string, ArbitrationVerdict>
  >({});
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});

  const fieldMeta = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );

  useEffect(() => {
    setPhase(computePhaseForDoc(docs[docIndex]));
  }, [docIndex, docs]);

  // Pre-popular finalChoices ao entrar na fase reveal: por padrão mantém a
  // escolha cega — árbitro só precisa intervir se mudar de ideia.
  useEffect(() => {
    if (phase !== "reveal") return;
    const currentDoc = docs[docIndex];
    if (!currentDoc) return;
    setFinalChoices((prev) => {
      const merged = { ...prev };
      let changed = false;
      for (const f of currentDoc.fields) {
        if (merged[f.fieldReviewId] == null && f.blindVerdict != null) {
          merged[f.fieldReviewId] = f.blindVerdict;
          changed = true;
        }
      }
      return changed ? merged : prev;
    });
  }, [phase, docIndex, docs]);

  function handleDocNavigate(newIndex: number) {
    const clamped = Math.max(0, Math.min(newIndex, docs.length - 1));
    const target = docs[clamped];
    if (target) {
      setPinnedDocId(target.docId);
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(storageKey, target.docId);
      }
    }
  }

  const docListEntries: ArbitrationDocListEntry[] = useMemo(
    () =>
      docs.map((d) => ({
        id: d.docId,
        title: d.title,
        externalId: d.externalId,
        totalFields: d.fields.length,
        blindDecided: d.fields.filter((f) => f.blindVerdict !== null).length,
        // Os campos vêm do server com final_verdict=NULL — o que está aqui é só
        // a decisão local na sessão (ainda não enviada).
        finalDecided: d.fields.filter(
          (f) => finalChoices[f.fieldReviewId] != null,
        ).length,
      })),
    [docs, finalChoices],
  );

  if (docs.length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-10 text-center">
        <h1 className="mb-4 text-2xl font-semibold">Arbitragem</h1>
        <p className="text-muted-foreground">
          Nenhuma arbitragem pendente. Quando outro pesquisador contestar o LLM
          em uma codificação atribuída a você, ela aparecerá aqui.
        </p>
      </div>
    );
  }

  const doc = docs[docIndex];
  const allBlindChosen = doc.fields.every(
    (f) => f.blindVerdict !== null || blindChoices[f.fieldReviewId] != null,
  );
  const allFinalChosen = doc.fields.every(
    (f) => finalChoices[f.fieldReviewId] != null,
  );

  async function handleBlindSubmit() {
    setSubmitting(true);
    const choices: BlindChoice[] = doc.fields
      .filter((f) => f.blindVerdict === null)
      .map((f) => ({
        fieldReviewId: f.fieldReviewId,
        choice: blindChoices[f.fieldReviewId],
      }));
    if (choices.length > 0) {
      const r = await submitBlindVerdicts(projectId, doc.docId, choices);
      if (!r.success) {
        setSubmitting(false);
        toast.error(r.error ?? "Falha ao registrar veredito cego");
        return;
      }
    }
    router.refresh();
    setSubmitting(false);
  }

  async function handleFinalSubmit() {
    for (const f of doc.fields) {
      if (finalChoices[f.fieldReviewId] === "llm") {
        if (!suggestions[f.fieldReviewId]?.trim()) {
          toast.error(
            `Campo "${f.fieldName}": preencha a sugestão de melhoria.`,
          );
          return;
        }
      }
    }
    setSubmitting(true);
    const payload: FinalChoice[] = doc.fields.map((f) => ({
      fieldName: f.fieldName,
      verdict: finalChoices[f.fieldReviewId],
      questionImprovementSuggestion:
        finalChoices[f.fieldReviewId] === "llm"
          ? suggestions[f.fieldReviewId]
          : undefined,
      arbitratorComment: comments[f.fieldReviewId] || undefined,
    }));
    const r = await submitFinalVerdicts(projectId, doc.docId, payload);
    setSubmitting(false);
    if (!r.success) {
      toast.error(r.error ?? "Falha ao enviar veredito final");
      return;
    }
    toast.success("Arbitragem concluída para este documento.");
    setBlindChoices({});
    setFinalChoices({});
    setSuggestions({});
    setComments({});
    if (docIndex < docs.length - 1) {
      handleDocNavigate(docIndex + 1);
    } else {
      router.refresh();
    }
  }

  return (
    <div className="flex h-[calc(100vh-96px)] flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-4 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">Arbitragem humano vs LLM</span>
          <Badge variant={phase === "blind" ? "default" : "secondary"}>
            {phase === "blind" ? "Cega" : "Revelação"}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {docs.length} doc{docs.length === 1 ? "" : "s"}
          </Badge>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleDocNavigate(docIndex - 1)}
              disabled={docIndex === 0}
              title="Documento anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground">
              {docIndex + 1}/{docs.length}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleDocNavigate(docIndex + 1)}
              disabled={docIndex === docs.length - 1}
              title="Próximo documento"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {phase === "reveal" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPhase("blind")}
              title="Voltar à fase cega (sua decisão fica registrada)"
            >
              Voltar à cega
            </Button>
          ) : null}
          {phase === "blind" ? (
            <Button
              size="sm"
              onClick={handleBlindSubmit}
              disabled={!allBlindChosen || submitting}
            >
              {submitting ? "Salvando…" : "Avançar para revelação"}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleFinalSubmit}
              disabled={!allFinalChosen || submitting}
            >
              {submitting ? "Enviando…" : "Enviar arbitragem"}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <ArbitrationDocList
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
            <div className="flex h-full flex-col">
              <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
                {phase === "blind"
                  ? "Fase 1 (cega): escolha sem ver a justificativa do LLM."
                  : "Fase 2: agora você vê a justificativa do LLM. Pode manter ou mudar sua escolha."}
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {phase === "blind" ? (
                  <BlindPhase
                    fields={doc.fields}
                    fieldMeta={fieldMeta}
                    choices={blindChoices}
                    onChoose={(fieldReviewId, choice) =>
                      setBlindChoices((c) => ({
                        ...c,
                        [fieldReviewId]: choice,
                      }))
                    }
                  />
                ) : (
                  <RevealPhase
                    fields={doc.fields}
                    fieldMeta={fieldMeta}
                    arbitrationBlind={arbitrationBlind}
                    finalChoices={finalChoices}
                    suggestions={suggestions}
                    comments={comments}
                    onChooseFinal={(fieldReviewId, verdict) =>
                      setFinalChoices((c) => ({
                        ...c,
                        [fieldReviewId]: verdict,
                      }))
                    }
                    onSuggestion={(fieldReviewId, v) =>
                      setSuggestions((s) => ({ ...s, [fieldReviewId]: v }))
                    }
                    onComment={(fieldReviewId, v) =>
                      setComments((s) => ({ ...s, [fieldReviewId]: v }))
                    }
                  />
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
