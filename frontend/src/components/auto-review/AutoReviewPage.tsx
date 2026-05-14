"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { DocumentReader } from "@/components/coding/DocumentReader";
import { submitAutoReview } from "@/actions/field-reviews";
import {
  AutoReviewDocList,
  type AutoReviewDocListEntry,
} from "./AutoReviewDocList";
import {
  AutoReviewFieldPanel,
  type AutoReviewField,
} from "./AutoReviewFieldPanel";
import type { PydanticField, SelfVerdict } from "@/lib/types";

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

export function AutoReviewPage({
  projectId,
  docs,
  isCoordinator = false,
  viewAsUserId,
  reviewers,
  currentUserId,
}: AutoReviewPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const isOwnQueue = viewAsUserId === currentUserId;
  const readOnly = !isOwnQueue;

  const storageKey = `${STORAGE_KEY_PREFIX}${projectId}:${viewAsUserId}`;
  const [pinnedDocId, setPinnedDocId] = useState<string | null>(null);

  // Restore último doc visto (por projeto+fila) — espelha o padrão da Compare.
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

  const [fieldIndex, setFieldIndex] = useState(0);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Keyed por `${docId}::${fieldName}` — fieldName se repete entre documentos.
  // Sem o prefixo do docId, escolher "q1" no doc A pre-selecionaria "q1" do
  // doc B na navegação. O composto garante isolamento por (doc, campo).
  const [choices, setChoices] = useState<Record<string, SelfVerdict>>({});
  // Justificativa por (doc, campo) — só usada quando a escolha é contesta_llm.
  const [justifications, setJustifications] = useState<Record<string, string>>(
    {},
  );

  const choiceKey = (docId: string, fieldName: string) =>
    `${docId}::${fieldName}`;

  useEffect(() => {
    setFieldIndex(0);
  }, [docIndex]);

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

  function handleViewAsChange(newUserId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (newUserId === currentUserId) {
      params.delete("viewAs");
    } else {
      params.set("viewAs", newUserId);
    }
    router.push(`?${params.toString()}`);
  }

  const docListEntries: AutoReviewDocListEntry[] = useMemo(
    () =>
      docs.map((d) => {
        const total = d.fields.length;
        const pending = d.fields.filter((f) => {
          if (f.alreadyAnswered) return false;
          const k = choiceKey(d.docId, f.fieldName);
          return choices[k] == null;
        }).length;
        return {
          id: d.docId,
          title: d.title,
          externalId: d.externalId,
          totalFields: total,
          pendingFields: pending,
        };
      }),
    [docs, choices],
  );

  if (docs.length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-10 text-center">
        <h1 className="mb-4 text-2xl font-semibold">Auto-revisão</h1>
        {readOnly ? (
          <p className="text-muted-foreground">
            Este pesquisador não tem auto-revisão pendente no momento.
          </p>
        ) : (
          <p className="text-muted-foreground">
            Nenhuma auto-revisão pendente. Quando você submeter uma codificação
            que diverge do LLM, ela aparecerá aqui.
          </p>
        )}
        {isCoordinator ? (
          <div className="mt-6 space-y-3 border-t pt-4 text-left">
            {reviewers.length > 1 ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">
                  Ver fila de outro pesquisador
                </p>
                <Select
                  value={viewAsUserId}
                  onValueChange={handleViewAsChange}
                >
                  <SelectTrigger className="w-full max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reviewers.map((r) => (
                      <SelectItem key={r.userId} value={r.userId}>
                        {r.name || r.email || r.userId.slice(0, 8)}
                        {r.userId === currentUserId ? " (você)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Coordenador: o backlog pode ser reexecutado em{" "}
              <span className="font-medium">Reviews → Erros LLM</span>.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  const doc = docs[docIndex];
  const currentField = doc.fields[fieldIndex];
  // Campo "decidido" = já respondido OU com escolha local; se a escolha for
  // contesta_llm, a justificativa também precisa estar preenchida.
  const isFieldDecided = (f: AutoReviewField) => {
    if (f.alreadyAnswered) return true;
    const key = choiceKey(doc.docId, f.fieldName);
    const choice = choices[key];
    if (choice == null) return false;
    if (choice === "contesta_llm") return !!justifications[key]?.trim();
    return true;
  };
  const allChosen = doc.fields.every(isFieldDecided);
  const answeredFlags = doc.fields.map(isFieldDecided);

  async function handleSubmit() {
    if (readOnly) return;
    setSubmitting(true);
    const payload = doc.fields
      .filter((f) => !f.alreadyAnswered)
      .map((f) => {
        const key = choiceKey(doc.docId, f.fieldName);
        return {
          fieldName: f.fieldName,
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
          : "Enviado. Todos os campos resolvidos.",
      );
    }
    setChoices((c) => {
      const next = { ...c };
      for (const f of doc.fields)
        delete next[choiceKey(doc.docId, f.fieldName)];
      return next;
    });
    setJustifications((j) => {
      const next = { ...j };
      for (const f of doc.fields)
        delete next[choiceKey(doc.docId, f.fieldName)];
      return next;
    });
    if (docIndex < docs.length - 1) {
      handleDocNavigate(docIndex + 1);
    } else {
      router.refresh();
    }
  }

  const currentReviewer = reviewers.find((r) => r.userId === viewAsUserId);
  const reviewerLabel =
    currentReviewer?.name ?? currentReviewer?.email ?? viewAsUserId.slice(0, 8);

  return (
    <div className="flex h-[calc(100vh-96px)] flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-4 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">
            Auto-revisão humano vs LLM
          </span>
          {readOnly ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
              visualizando {reviewerLabel}
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isCoordinator && reviewers.length > 1 ? (
            <Select value={viewAsUserId} onValueChange={handleViewAsChange}>
              <SelectTrigger className="h-7 w-[200px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {reviewers.map((r) => (
                  <SelectItem
                    key={r.userId}
                    value={r.userId}
                    className="text-xs"
                  >
                    {r.name || r.email || r.userId.slice(0, 8)}
                    {r.userId === currentUserId ? " (você)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
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
          {!readOnly ? (
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!allChosen || submitting}
              title={
                allChosen
                  ? "Enviar auto-revisão do documento"
                  : "Decida todos os campos pendentes"
              }
            >
              {submitting ? "Enviando…" : "Enviar"}
            </Button>
          ) : null}
        </div>
      </div>

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
            <AutoReviewFieldPanel
              field={currentField}
              fieldIndex={fieldIndex}
              totalFields={doc.fields.length}
              answered={answeredFlags}
              choice={
                choices[choiceKey(doc.docId, currentField.fieldName)] ?? null
              }
              justification={
                justifications[
                  choiceKey(doc.docId, currentField.fieldName)
                ] ?? ""
              }
              readOnly={readOnly}
              onChoose={(v) =>
                setChoices((c) => ({
                  ...c,
                  [choiceKey(doc.docId, currentField.fieldName)]: v,
                }))
              }
              onJustificationChange={(value) =>
                setJustifications((j) => ({
                  ...j,
                  [choiceKey(doc.docId, currentField.fieldName)]: value,
                }))
              }
              onFieldNavigate={setFieldIndex}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
