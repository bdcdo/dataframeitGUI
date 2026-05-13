"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { submitAutoReview } from "@/actions/field-reviews";
import { FieldVerdictRow } from "./FieldVerdictRow";
import type { PydanticField, SelfVerdict } from "@/lib/types";

export interface AutoReviewDoc {
  docId: string;
  title: string | null;
  externalId: string | null;
  text: string;
  fields: Array<{
    fieldName: string;
    humanAnswer: unknown;
    llmAnswer: unknown;
    llmJustification: string | null;
    alreadyAnswered: boolean;
  }>;
}

export interface AutoReviewPageProps {
  projectId: string;
  projectName: string;
  fields: PydanticField[];
  docs: AutoReviewDoc[];
}

export function AutoReviewPage({
  projectId,
  fields,
  docs,
}: AutoReviewPageProps) {
  const [docIndex, setDocIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [choices, setChoices] = useState<Record<string, SelfVerdict>>({});

  if (docs.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-center">
        <h1 className="text-2xl font-semibold mb-4">Auto-revisão</h1>
        <p className="text-muted-foreground">
          Nenhuma auto-revisão pendente. Quando você submeter uma codificação
          que diverge do LLM, ela aparecerá aqui.
        </p>
      </div>
    );
  }

  const doc = docs[docIndex];
  const pending = doc.fields.filter((f) => !f.alreadyAnswered);
  const allChosen = pending.every((f) => choices[f.fieldName] != null);

  const fieldMeta = (name: string) => fields.find((f) => f.name === name);

  async function handleSubmit() {
    setSubmitting(true);
    const payload = pending.map((f) => ({
      fieldName: f.fieldName,
      verdict: choices[f.fieldName],
    }));
    const result = await submitAutoReview(projectId, doc.docId, payload);
    setSubmitting(false);
    if (!result.success) {
      toast.error(result.error ?? "Falha ao enviar");
      return;
    }
    toast.success(
      result.arbitrated
        ? `Enviado. ${result.arbitrated} campo(s) seguem para arbitragem.`
        : "Enviado. Todos os campos resolvidos.",
    );
    setChoices({});
    if (docIndex < docs.length - 1) {
      setDocIndex(docIndex + 1);
    } else {
      // Acabou; recarrega para atualizar lista
      window.location.reload();
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Auto-revisão humano vs LLM</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Para cada campo divergente, decida quem acertou. Se contestar o
            LLM, o caso vai para arbitragem por outro pesquisador.
          </p>
        </div>
        <Badge variant="secondary">
          Documento {docIndex + 1} de {docs.length}
        </Badge>
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

      <div className="space-y-4">
        {pending.map((f) => (
          <FieldVerdictRow
            key={f.fieldName}
            fieldName={f.fieldName}
            fieldDescription={fieldMeta(f.fieldName)?.description ?? null}
            humanAnswer={f.humanAnswer}
            llmAnswer={f.llmAnswer}
            llmJustification={f.llmJustification}
            choice={choices[f.fieldName] ?? null}
            onChoose={(v) => setChoices((c) => ({ ...c, [f.fieldName]: v }))}
          />
        ))}
      </div>

      <div className="flex justify-between items-center pt-4">
        <Button
          variant="outline"
          onClick={() => setDocIndex(Math.max(0, docIndex - 1))}
          disabled={docIndex === 0}
        >
          ← Anterior
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={!allChosen || submitting}
        >
          {submitting ? "Enviando…" : "Enviar auto-revisão"}
        </Button>
      </div>
    </div>
  );
}
