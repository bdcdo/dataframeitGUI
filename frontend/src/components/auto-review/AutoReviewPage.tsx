"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  submitAutoReview,
  regenerateAutoReviewBacklog,
} from "@/actions/field-reviews";
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
  isCoordinator?: boolean;
}

export function AutoReviewPage({
  projectId,
  fields,
  docs,
  isCoordinator = false,
}: AutoReviewPageProps) {
  const router = useRouter();
  const [docIndex, setDocIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Keyed por `${docId}::${fieldName}` — fieldName se repete entre documentos.
  // Sem o prefixo, escolha de "q1" no doc A pre-selecionaria "q1" do doc B.
  const [choices, setChoices] = useState<Record<string, SelfVerdict>>({});

  const choiceKey = (docId: string, fieldName: string) =>
    `${docId}::${fieldName}`;

  // useMemo precisa rodar incondicionalmente — antes do early return.
  const fieldMetaMap = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );
  const fieldMeta = (name: string) => fieldMetaMap.get(name);

  async function handleRegenerate() {
    setRegenerating(true);
    const result = await regenerateAutoReviewBacklog(projectId);
    setRegenerating(false);
    if (!result.success) {
      toast.error(result.error ?? "Falha ao regenerar backlog");
      return;
    }
    toast.success(
      `Backlog regenerado. ${result.scanned ?? 0} resposta(s) escaneada(s), ${result.regenerated ?? 0} doc(s) com divergência.`,
    );
    router.refresh();
  }

  if (docs.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-center space-y-4">
        <h1 className="text-2xl font-semibold mb-4">Auto-revisão</h1>
        <p className="text-muted-foreground">
          Nenhuma auto-revisão pendente. Quando você submeter uma codificação
          que diverge do LLM, ela aparecerá aqui.
        </p>
        {isCoordinator ? (
          <div className="pt-4 border-t mt-6 space-y-2">
            <p className="text-xs text-muted-foreground">
              Coordenador: se alguma codificação humana já submetida não gerou
              backlog (por exemplo, por falha silenciosa em produção), você
              pode forçar a varredura.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              {regenerating ? "Regenerando…" : "Regenerar backlog"}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const doc = docs[docIndex];
  const pending = doc.fields.filter((f) => !f.alreadyAnswered);
  const allChosen = pending.every(
    (f) => choices[choiceKey(doc.docId, f.fieldName)] != null,
  );

  async function handleSubmit() {
    setSubmitting(true);
    const payload = pending.map((f) => ({
      fieldName: f.fieldName,
      verdict: choices[choiceKey(doc.docId, f.fieldName)],
    }));
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
          : "Enviado. Todos os campos resolvidos.",
      );
    }
    setChoices({});
    if (docIndex < docs.length - 1) {
      setDocIndex(docIndex + 1);
    } else {
      // Acabou; revalidar a rota para atualizar a lista
      router.refresh();
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
        <div className="flex items-center gap-2">
          {isCoordinator ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRegenerate}
              disabled={regenerating}
              title="Reexecutar varredura de divergências (coordenador)"
            >
              {regenerating ? "Regenerando…" : "Regenerar backlog"}
            </Button>
          ) : null}
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

      <div className="space-y-4">
        {pending.map((f) => {
          const key = choiceKey(doc.docId, f.fieldName);
          return (
            <FieldVerdictRow
              key={key}
              fieldName={f.fieldName}
              fieldDescription={fieldMeta(f.fieldName)?.description ?? null}
              humanAnswer={f.humanAnswer}
              llmAnswer={f.llmAnswer}
              llmJustification={f.llmJustification}
              choice={choices[key] ?? null}
              onChoose={(v) => setChoices((c) => ({ ...c, [key]: v }))}
            />
          );
        })}
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
