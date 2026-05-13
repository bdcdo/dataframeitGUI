"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
  // Sempre presente — embaralhamento A/B feito server-side via assignOrder
  aAnswer: unknown;
  bAnswer: unknown;
  blindVerdict: ArbitrationVerdict | null;
  // Populado apenas quando blindVerdict !== null (fase 2). Na fase cega, o
  // navegador nao recebe esta relacao — DevTools nao revela qual e humano.
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

export function ArbitrationPage({
  projectId,
  fields,
  docs,
  arbitrationBlind,
}: ArbitrationPageProps) {
  const router = useRouter();
  const [docIndex, setDocIndex] = useState(0);
  const [phase, setPhase] = useState<"blind" | "reveal">(() =>
    computePhaseForDoc(docs[0]),
  );
  const [submitting, setSubmitting] = useState(false);
  // Blind: keyed por fieldReviewId, valores "a" | "b"
  const [blindChoices, setBlindChoices] = useState<Record<string, "a" | "b">>(
    {},
  );
  // Final: keyed por fieldName, valores humano/llm
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

  const allBlindChosen = doc.fields.every(
    (f) => f.blindVerdict !== null || blindChoices[f.fieldReviewId] != null,
  );
  const allFinalChosen = doc.fields.every(
    (f) => finalChoices[f.fieldName] != null,
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
    // router.refresh() repuxa o payload com `reveal` populado para esses
    // campos. UI re-renderiza, useEffect detecta blindVerdict definido e
    // muda phase para reveal automaticamente.
    router.refresh();
    setSubmitting(false);
  }

  // Quando entra na fase reveal, pre-popular finalChoices com o que foi
  // decidido na cega (caso comum: manter). Roda quando doc/fase muda e
  // finalChoices ainda nao esta populado para este doc.
  useEffect(() => {
    if (phase !== "reveal") return;
    const currentDoc = docs[docIndex];
    if (!currentDoc) return;
    setFinalChoices((prev) => {
      const merged = { ...prev };
      let changed = false;
      for (const f of currentDoc.fields) {
        if (merged[f.fieldName] == null && f.blindVerdict != null) {
          merged[f.fieldName] = f.blindVerdict;
          changed = true;
        }
      }
      return changed ? merged : prev;
    });
  }, [phase, docIndex, docs]);

  async function handleFinalSubmit() {
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
    } else {
      router.refresh();
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
          choices={blindChoices}
          onChoose={(fieldReviewId, choice) =>
            setBlindChoices((c) => ({ ...c, [fieldReviewId]: choice }))
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
          onChooseFinal={(field, verdict) =>
            setFinalChoices((c) => ({ ...c, [field]: verdict }))
          }
          onSuggestion={(field, v) =>
            setSuggestions((s) => ({ ...s, [field]: v }))
          }
          onComment={(field, v) =>
            setComments((s) => ({ ...s, [field]: v }))
          }
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
