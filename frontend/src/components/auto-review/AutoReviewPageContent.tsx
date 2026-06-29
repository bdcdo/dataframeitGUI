"use client";

import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { submitAutoReview } from "@/actions/field-reviews";
import { AutoReviewFieldPanel } from "./AutoReviewFieldPanel";
import {
  choiceKey,
  isAutoReviewFieldDecided,
  verdictRequiresJustification,
} from "@/lib/auto-review-decided";
import type { SelfVerdict } from "@/lib/types";
import type { AutoReviewDoc } from "./AutoReviewPage";

interface AutoReviewPageContentProps {
  doc: AutoReviewDoc;
  projectId: string;
  readOnly: boolean;
  choices: Record<string, SelfVerdict>;
  justifications: Record<string, string>;
  setChoices: Dispatch<SetStateAction<Record<string, SelfVerdict>>>;
  setJustifications: Dispatch<SetStateAction<Record<string, string>>>;
}

// Renderizado pelo pai com `key={doc.docId}`: ao trocar de documento, o
// componente remonta e `fieldIndex` volta a 0 — sem effect (no-adjust-state-on-
// prop-change) nem ajuste durante render (useState-prev e marcado pela 0.5.8;
// useRef-prev e barrado pelo eslint react-hooks/refs). Keyar por docId (e nao
// por indice) tambem reseta corretamente quando um doc resolvido sai da fila e
// outro assume o mesmo indice. O ResizablePanelGroup fica no pai, fora desta
// remontagem, preservando o tamanho do split entre navegacoes.
export function AutoReviewPageContent({
  doc,
  projectId,
  readOnly,
  choices,
  justifications,
  setChoices,
  setJustifications,
}: AutoReviewPageContentProps) {
  const { refresh } = useRouter();
  const [fieldIndex, setFieldIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Classifica cada campo do doc na sessao atual:
  //   ready      = decidido nesta sessao e completo -> entra no proximo envio
  //   incomplete = verdict que exige justificativa escolhido mas sem ela
  //   answered   = ja enviado (alreadyAnswered) OU pronto pra enviar
  const {
    fieldStatus,
    answeredFlags,
    incompleteFlags,
    readyCount,
    incompleteCount,
  } = useMemo(() => {
    const status = doc.fields.map((f) => {
      const key = choiceKey(doc.docId, f.fieldName);
      const choice = choices[key];
      const justification = justifications[key];
      const incomplete =
        !f.alreadyAnswered &&
        verdictRequiresJustification(choice) &&
        !justification?.trim();
      const ready =
        !f.alreadyAnswered &&
        isAutoReviewFieldDecided(false, choice, justification);
      return { answered: f.alreadyAnswered || ready, incomplete, ready };
    });
    return {
      fieldStatus: status,
      answeredFlags: status.map((s) => s.answered),
      incompleteFlags: status.map((s) => s.incomplete),
      readyCount: status.filter((s) => s.ready).length,
      incompleteCount: status.filter((s) => s.incomplete).length,
    };
  }, [doc.docId, doc.fields, choices, justifications]);

  const canSubmit = readyCount > 0 && !submitting;
  const currentField = doc.fields[fieldIndex];
  const currentKey = choiceKey(doc.docId, currentField.fieldName);

  async function handleSubmit() {
    if (readOnly) return;
    const readyFieldNames = doc.fields
      .filter((_, i) => fieldStatus[i].ready)
      .map((f) => f.fieldName);
    if (readyFieldNames.length === 0) return;
    setSubmitting(true);
    const payload = readyFieldNames.map((fieldName) => {
      const key = choiceKey(doc.docId, fieldName);
      return {
        fieldName,
        verdict: choices[key],
        justification: justifications[key],
      };
    });
    const result = await submitAutoReview(projectId, doc.docId, payload);
    setSubmitting(false);
    if (!result.success) {
      toast.error(result.error ?? "Falha ao enviar");
      return;
    }
    if (result.warning) {
      toast.warning(result.warning);
    } else {
      toast.success(
        result.arbitrated
          ? `Enviado. ${result.arbitrated} campo(s) seguem para arbitragem.`
          : `Enviado. ${readyFieldNames.length} campo(s) resolvido(s).`,
      );
    }
    // Limpa so os campos enviados — escolhas incompletas (contesta_llm sem
    // justificativa) permanecem para o usuario continuar de onde parou.
    setChoices((c) => {
      const next = { ...c };
      for (const fieldName of readyFieldNames)
        delete next[choiceKey(doc.docId, fieldName)];
      return next;
    });
    setJustifications((j) => {
      const next = { ...j };
      for (const fieldName of readyFieldNames)
        delete next[choiceKey(doc.docId, fieldName)];
      return next;
    });
    // Recarrega o estado do servidor: os campos enviados voltam como
    // alreadyAnswered e o doc sai da fila se todos foram resolvidos.
    refresh();
  }

  return (
    <AutoReviewFieldPanel
      // Remonta ao trocar de doc/campo: reseta o estado local do painel (ex.:
      // `showJustification` volta ao default aberto) sem precisar de effect de
      // sincronizacao — ver react-doctor/no-adjust-state-on-prop-change.
      key={currentKey}
      field={currentField}
      fieldIndex={fieldIndex}
      totalFields={doc.fields.length}
      answered={answeredFlags}
      incomplete={incompleteFlags}
      choice={choices[currentKey] ?? null}
      justification={justifications[currentKey] ?? ""}
      readOnly={readOnly}
      readyCount={readyCount}
      incompleteCount={incompleteCount}
      submitting={submitting}
      canSubmit={canSubmit}
      onSubmit={handleSubmit}
      onChoose={(v) => setChoices((c) => ({ ...c, [currentKey]: v }))}
      onJustificationChange={(value) =>
        setJustifications((j) => ({ ...j, [currentKey]: value }))
      }
      onFieldNavigate={setFieldIndex}
    />
  );
}
