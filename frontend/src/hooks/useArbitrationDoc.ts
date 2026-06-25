"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  submitBlindVerdicts,
  submitFinalVerdicts,
  type BlindChoice,
  type FinalChoice,
} from "@/actions/field-reviews";
import type { ArbitrationVerdict } from "@/lib/types";
import type {
  ArbitrationDoc,
  ArbitrationField,
} from "@/components/arbitration/ArbitrationPage";

function computePhaseForDoc(
  doc: ArbitrationDoc | undefined,
): "blind" | "reveal" {
  if (!doc || doc.fields.length === 0) return "blind";
  return doc.fields.every((f) => f.blindVerdict !== null) ? "reveal" : "blind";
}

export interface UseArbitrationDocParams {
  doc: ArbitrationDoc | undefined;
  docIndex: number;
  docsLength: number;
  projectId: string;
  onNavigate: (index: number) => void;
}

export interface UseArbitrationDoc {
  phase: "blind" | "reveal";
  submitting: boolean;
  allBlindChosen: boolean;
  allFinalChosen: boolean;
  // States keyed por fieldReviewId (UUID único por (doc, campo)) — ver nota em
  // ArbitrationPage sobre por que nunca chavear por fieldName.
  blindChoices: Record<string, "a" | "b">;
  effectiveFinalChoices: Record<string, ArbitrationVerdict>;
  suggestions: Record<string, string>;
  comments: Record<string, string>;
  onChooseBlind: (fieldReviewId: string, choice: "a" | "b") => void;
  onChooseFinal: (fieldReviewId: string, verdict: ArbitrationVerdict) => void;
  onSuggestion: (fieldReviewId: string, v: string) => void;
  onComment: (fieldReviewId: string, v: string) => void;
  onBackToBlind: () => void;
  handleBlindSubmit: () => Promise<void>;
  handleFinalSubmit: () => Promise<void>;
}

/**
 * Estado e ações de interação da arbitragem de UM documento.
 *
 * Agrupa o estado coeso da página (escolhas cega/final, sugestões, comentários,
 * envio) num hook em vez de espalhá-lo em vários `useState` no componente — assim
 * `ArbitrationPage` fica enxuto e legível, na linha dos hooks de state/effect
 * extraídos em #231/#244.
 *
 * Pontos de design:
 * - `phase` é DERIVADA no render (`computePhaseForDoc`), não guardada em state.
 *   O botão "Voltar à cega" é um override explícito chaveado por `docId`
 *   (`blindOverrideDocId`): navegar para outro doc reverte sozinho para a fase
 *   dos dados, sem `useEffect`. O override é limpo ao enviar (cego ou final).
 * - `effectiveFinalChoices` faz o merge do `blindVerdict` (default) com os
 *   overrides do usuário na fase reveal — também no render, em vez de pré-popular
 *   `finalChoices` por effect. O árbitro mantém a escolha cega por padrão.
 */
export function useArbitrationDoc({
  doc,
  docIndex,
  docsLength,
  projectId,
  onNavigate,
}: UseArbitrationDocParams): UseArbitrationDoc {
  const { refresh } = useRouter();

  const [submitting, setSubmitting] = useState(false);
  const [blindOverrideDocId, setBlindOverrideDocId] = useState<string | null>(
    null,
  );
  const [blindChoices, setBlindChoices] = useState<Record<string, "a" | "b">>(
    {},
  );
  const [finalChoices, setFinalChoices] = useState<
    Record<string, ArbitrationVerdict>
  >({});
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});

  const dataPhase = computePhaseForDoc(doc);
  const phase: "blind" | "reveal" =
    doc && blindOverrideDocId === doc.docId ? "blind" : dataPhase;

  // Merge do verdict cego (default) com os overrides do usuário, só na reveal.
  const effectiveFinalChoices = useMemo(() => {
    if (phase !== "reveal" || !doc) return finalChoices;
    const merged = { ...finalChoices };
    for (const f of doc.fields) {
      if (merged[f.fieldReviewId] == null && f.blindVerdict != null) {
        merged[f.fieldReviewId] = f.blindVerdict;
      }
    }
    return merged;
  }, [phase, doc, finalChoices]);

  const allBlindChosen = doc
    ? doc.fields.every(
        (f) => f.blindVerdict !== null || blindChoices[f.fieldReviewId] != null,
      )
    : false;
  const allFinalChosen = doc
    ? doc.fields.every((f) => effectiveFinalChoices[f.fieldReviewId] != null)
    : false;

  const onChooseBlind = useCallback((fieldReviewId: string, choice: "a" | "b") => {
    setBlindChoices((c) => ({ ...c, [fieldReviewId]: choice }));
  }, []);
  const onChooseFinal = useCallback(
    (fieldReviewId: string, verdict: ArbitrationVerdict) => {
      setFinalChoices((c) => ({ ...c, [fieldReviewId]: verdict }));
    },
    [],
  );
  const onSuggestion = useCallback((fieldReviewId: string, v: string) => {
    setSuggestions((s) => ({ ...s, [fieldReviewId]: v }));
  }, []);
  const onComment = useCallback((fieldReviewId: string, v: string) => {
    setComments((s) => ({ ...s, [fieldReviewId]: v }));
  }, []);
  const onBackToBlind = useCallback(() => {
    if (doc) setBlindOverrideDocId(doc.docId);
  }, [doc]);

  async function handleBlindSubmit() {
    if (!doc) return;
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
    // Limpa o override para que, após o refresh, a fase derivada dos dados
    // (agora "reveal") apareça — inclusive se o usuário tinha voltado à cega.
    setBlindOverrideDocId(null);
    // refresh() repuxa o payload com `reveal` populado; a fase deriva sozinha.
    refresh();
    setSubmitting(false);
  }

  async function handleFinalSubmit() {
    if (!doc) return;
    for (const f of doc.fields) {
      if (effectiveFinalChoices[f.fieldReviewId] === "llm") {
        if (!suggestions[f.fieldReviewId]?.trim()) {
          toast.error(
            `Campo "${f.fieldName}": preencha a sugestão de melhoria.`,
          );
          return;
        }
      }
    }
    setSubmitting(true);
    const payload: FinalChoice[] = doc.fields.map((f: ArbitrationField) => ({
      fieldName: f.fieldName,
      verdict: effectiveFinalChoices[f.fieldReviewId],
      questionImprovementSuggestion:
        effectiveFinalChoices[f.fieldReviewId] === "llm"
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
    setBlindOverrideDocId(null);
    if (docIndex < docsLength - 1) {
      onNavigate(docIndex + 1);
    } else {
      refresh();
    }
  }

  return {
    phase,
    submitting,
    allBlindChosen,
    allFinalChosen,
    blindChoices,
    effectiveFinalChoices,
    suggestions,
    comments,
    onChooseBlind,
    onChooseFinal,
    onSuggestion,
    onComment,
    onBackToBlind,
    handleBlindSubmit,
    handleFinalSubmit,
  };
}
