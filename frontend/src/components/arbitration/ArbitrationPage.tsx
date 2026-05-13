"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  submitBlindVerdicts,
  submitFinalVerdicts,
  type BlindChoice,
  type FinalChoice,
} from "@/actions/field-reviews";
import { BlindPhase } from "./BlindPhase";
import { RevealPhase } from "./RevealPhase";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";

export interface ArbitrationField {
  fieldReviewId: string;
  fieldName: string;
  humanAnswer: unknown;
  humanName: string | null;
  llmAnswer: unknown;
  llmName: string | null;
  llmJustification: string | null;
  blindVerdict: ArbitrationVerdict | null;
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

// Determina ordem A/B do par (humano, llm) por field_review.id de forma
// deterministica — assim re-renders nao reordenam.
function assignOrder(fieldReviewId: string): "human_first" | "llm_first" {
  let h = 0;
  for (let i = 0; i < fieldReviewId.length; i++) {
    h = (h * 31 + fieldReviewId.charCodeAt(i)) >>> 0;
  }
  return h % 2 === 0 ? "human_first" : "llm_first";
}

export function ArbitrationPage({
  projectId,
  fields,
  docs,
  arbitrationBlind,
}: ArbitrationPageProps) {
  const [docIndex, setDocIndex] = useState(0);
  // Inicia em reveal se TODOS os campos do primeiro doc ja tem blind_verdict
  const initialPhase: "blind" | "reveal" =
    docs.length > 0 && docs[0].fields.every((f) => f.blindVerdict !== null)
      ? "reveal"
      : "blind";
  const [phase, setPhase] = useState<"blind" | "reveal">(initialPhase);
  const [submitting, setSubmitting] = useState(false);
  const [blindChoices, setBlindChoices] = useState<
    Record<string, ArbitrationVerdict>
  >({});
  const [finalChoices, setFinalChoices] = useState<
    Record<string, ArbitrationVerdict>
  >({});
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});

  const fieldMeta = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );

  if (docs.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-center">
        <h1 className="text-2xl font-semibold mb-4">Arbitragem</h1>
        <p className="text-muted-foreground">
          Nenhuma arbitragem pendente. Quando outro pesquisador contestar o
          LLM em uma codificação atribuída a você, ela aparecerá aqui.
        </p>
      </div>
    );
  }

  const doc = docs[docIndex];
  const orderByField = new Map(
    doc.fields.map((f) => [f.fieldName, assignOrder(f.fieldReviewId)]),
  );

  const allBlindChosen = doc.fields.every(
    (f) => f.blindVerdict !== null || blindChoices[f.fieldName] != null,
  );
  const allFinalChosen = doc.fields.every(
    (f) => finalChoices[f.fieldName] != null,
  );

  async function handleBlindSubmit() {
    setSubmitting(true);
    const choices: BlindChoice[] = doc.fields
      .filter((f) => f.blindVerdict === null)
      .map((f) => ({
        fieldName: f.fieldName,
        verdict: blindChoices[f.fieldName],
      }));
    if (choices.length > 0) {
      const r = await submitBlindVerdicts(projectId, doc.docId, choices);
      if (!r.success) {
        setSubmitting(false);
        toast.error(r.error ?? "Falha ao registrar veredito cego");
        return;
      }
    }
    // Inicializa final com o que escolheu na cega (mais comum: manter)
    const merged: Record<string, ArbitrationVerdict> = {};
    for (const f of doc.fields) {
      merged[f.fieldName] = f.blindVerdict ?? blindChoices[f.fieldName];
    }
    setFinalChoices(merged);
    setPhase("reveal");
    setSubmitting(false);
  }

  async function handleFinalSubmit() {
    // Validar sugestoes para campos onde final='llm' (humano perdeu)
    for (const f of doc.fields) {
      if (finalChoices[f.fieldName] === "llm") {
        if (!suggestions[f.fieldName]?.trim()) {
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
      verdict: finalChoices[f.fieldName],
      questionImprovementSuggestion:
        finalChoices[f.fieldName] === "llm"
          ? suggestions[f.fieldName]
          : undefined,
      arbitratorComment: comments[f.fieldName] || undefined,
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
      setDocIndex(docIndex + 1);
      setPhase("blind");
    } else {
      window.location.reload();
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Arbitragem humano vs LLM</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {phase === "blind"
              ? "Fase 1 (cega): escolha sem ver a justificativa do LLM."
              : "Fase 2: agora você vê a justificativa do LLM. Pode manter ou mudar sua escolha."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={phase === "blind" ? "default" : "secondary"}>
            {phase === "blind" ? "Cega" : "Revelação"}
          </Badge>
          <Badge variant="secondary">
            Documento {docIndex + 1} de {docs.length}
          </Badge>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {doc.title ?? doc.externalId ?? doc.docId.slice(0, 8)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Ver texto do documento
            </summary>
            <pre className="mt-3 whitespace-pre-wrap text-sm bg-muted p-3 rounded max-h-80 overflow-auto">
              {doc.text}
            </pre>
          </details>
        </CardContent>
      </Card>

      {phase === "blind" ? (
        <BlindPhase
          fields={doc.fields}
          fieldMeta={fieldMeta}
          orderByField={orderByField}
          choices={blindChoices}
          onChoose={(field, verdict) =>
            setBlindChoices((c) => ({ ...c, [field]: verdict }))
          }
        />
      ) : (
        <RevealPhase
          fields={doc.fields}
          fieldMeta={fieldMeta}
          orderByField={orderByField}
          arbitrationBlind={arbitrationBlind}
          finalChoices={finalChoices}
          suggestions={suggestions}
          comments={comments}
          onChooseFinal={(field, verdict) =>
            setFinalChoices((c) => ({ ...c, [field]: verdict }))
          }
          onSuggestion={(field, v) =>
            setSuggestions((s) => ({ ...s, [field]: v }))
          }
          onComment={(field, v) =>
            setComments((s) => ({ ...s, [field]: v }))
          }
          blindChoices={blindChoices}
        />
      )}

      <div className="flex justify-between pt-4">
        <Button
          variant="outline"
          onClick={() => {
            if (phase === "reveal") setPhase("blind");
            else if (docIndex > 0) setDocIndex(docIndex - 1);
          }}
          disabled={phase === "blind" && docIndex === 0}
        >
          ← {phase === "reveal" ? "Voltar à fase cega" : "Documento anterior"}
        </Button>
        {phase === "blind" ? (
          <Button
            onClick={handleBlindSubmit}
            disabled={!allBlindChosen || submitting}
          >
            {submitting ? "Salvando…" : "Avançar para revelação →"}
          </Button>
        ) : (
          <Button
            onClick={handleFinalSubmit}
            disabled={!allFinalChosen || submitting}
          >
            {submitting ? "Enviando…" : "Enviar arbitragem final"}
          </Button>
        )}
      </div>
    </div>
  );
}
