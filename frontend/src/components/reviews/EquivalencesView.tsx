"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatDate } from "@/lib/date-format";
import { ChevronRight, Link2, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import {
  loadEquivalenceUsage,
  unmarkEquivalencePair,
} from "@/actions/equivalences";
import type {
  EquivalenceClassRowView,
  EquivalenceFieldView,
  EquivalenceHistoryView,
  EquivalenceRowView,
} from "@/lib/reviews/equivalences-view-model";
import type { UsageDocument } from "@/lib/value-equivalence-usage";

function formatOptionalDate(value: string | null): string {
  return value ? formatDate(value) : "—";
}

type UsageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; usage: Record<string, UsageDocument[]> }
  | { status: "error"; message: string };

export function EquivalencesView({
  projectId,
  fields,
  history,
}: {
  projectId: string;
  fields: EquivalenceFieldView[];
  history: EquivalenceHistoryView[];
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Equivalências</h1>
        <p className="text-sm text-muted-foreground">
          Uma equivalência diz que, num campo, dois valores são a mesma resposta. Ela vale em
          todo o projeto e sobrevive a uma execução nova do LLM, mas cai quando a pergunta muda
          (enunciado, opções ou tipo). Desfazer não apaga nenhum veredito: só deixa de fundir os
          valores daqui em diante.
        </p>
      </div>

      <EquivalencesSummary fields={fields} />

      {fields.map((field) => (
        // A chave muda quando as equivalências do campo mudam (desfazer +
        // refresh): a seção remonta e "onde se aplica" volta a ser carregável,
        // em vez de mostrar o mapa calculado com as classes de antes.
        <FieldSection key={fieldSignature(field)} projectId={projectId} field={field} />
      ))}

      {history.length > 0 && <HistorySection history={history} />}
    </div>
  );
}

function fieldSignature(field: EquivalenceFieldView): string {
  return `${field.name}:${field.classes.flatMap((cls) => cls.equivalences.map((e) => e.id)).join(",")}`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function EquivalencesSummary({ fields }: { fields: EquivalenceFieldView[] }) {
  if (fields.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        Nenhuma equivalência na versão atual das perguntas. Marque respostas como equivalentes na
        Comparação ou em Erros LLM.
      </p>
    );
  }
  const total = fields.reduce(
    (sum, field) => sum + field.classes.reduce((n, cls) => n + cls.equivalences.length, 0),
    0,
  );
  return (
    <p className="text-xs text-muted-foreground">
      {plural(total, "equivalência", "equivalências")} em {plural(fields.length, "campo", "campos")}.
    </p>
  );
}

function FieldSection({ projectId, field }: { projectId: string; field: EquivalenceFieldView }) {
  const [usage, setUsage] = useState<UsageState>({ status: "idle" });
  const [, startLoading] = useTransition();

  const loadUsage = () => {
    if (usage.status === "loading" || usage.status === "loaded") return;
    setUsage({ status: "loading" });
    startLoading(async () => {
      const result = await loadEquivalenceUsage(projectId, field.name);
      setUsage(
        result.usage
          ? { status: "loaded", usage: result.usage }
          : { status: "error", message: result.error ?? "Falha ao carregar." },
      );
    });
  };

  return (
    <section className="rounded-lg border" aria-labelledby={`field-${field.name}`}>
      <header className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <h2 id={`field-${field.name}`} className="min-w-0 truncate text-sm font-medium" title={field.label}>
          {field.label}
          <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">{field.name}</span>
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-xs"
          onClick={loadUsage}
          disabled={usage.status === "loading" || usage.status === "loaded"}
        >
          {usage.status === "loading" ? "Carregando…" : "Onde se aplica"}
        </Button>
      </header>
      {usage.status === "error" && (
        <p className="px-3 pt-2 text-xs text-destructive" role="alert">
          {usage.message}
        </p>
      )}
      <ul className="divide-y">
        {field.classes.map((cls) => (
          <ClassRow
            key={cls.classKey}
            projectId={projectId}
            cls={cls}
            documents={usage.status === "loaded" ? usage.usage[cls.classKey] ?? [] : null}
          />
        ))}
      </ul>
    </section>
  );
}

function ClassRow({
  projectId,
  cls,
  documents,
}: {
  projectId: string;
  cls: EquivalenceClassRowView;
  /** `null` enquanto "onde se aplica" não foi carregado. */
  documents: UsageDocument[] | null;
}) {
  return (
    <li className="space-y-1.5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        {cls.values.map((value, index) => (
          <span key={value.key} className="flex items-center gap-1">
            {index > 0 && <span className="text-xs text-muted-foreground" aria-hidden="true">=</span>}
            <Badge variant="secondary" className="max-w-md truncate font-normal" title={value.display}>
              {value.display}
            </Badge>
          </span>
        ))}
      </div>
      <ul className="space-y-0.5">
        {cls.equivalences.map((equivalence) => (
          <EquivalenceLine key={equivalence.id} projectId={projectId} equivalence={equivalence} />
        ))}
      </ul>
      {documents !== null && <UsageList projectId={projectId} documents={documents} />}
    </li>
  );
}

function EquivalenceLine({
  projectId,
  equivalence,
}: {
  projectId: string;
  equivalence: EquivalenceRowView;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  const undo = () => {
    startTransition(async () => {
      const result = await unmarkEquivalencePair(projectId, equivalence.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setConfirming(false);
      toast.success("Equivalência desfeita no projeto.");
      router.refresh();
    });
  };

  return (
    <li className="flex items-center gap-2 text-xs text-muted-foreground">
      <Link2 className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={equivalence.display}>
        {equivalence.display}
      </span>
      <span className="shrink-0">
        {equivalence.sourceLabel} · {equivalence.reviewerName} · {formatOptionalDate(equivalence.createdAt)}
      </span>
      {equivalence.canUndo && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => setConfirming(true)}
          aria-label={`Desfazer a equivalência ${equivalence.display}`}
        >
          <Undo2 className="size-3" aria-hidden="true" />
          Desfazer
        </Button>
      )}
      <ConfirmActionDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Desfazer equivalência?"
        description={
          <>
            <span className="font-medium text-foreground">{equivalence.display}</span> deixa de valer em
            todo o projeto. Nenhum veredito é apagado; documentos que voltarem a divergir sem
            veredito voltam à fila da Comparação.
          </>
        }
        confirmLabel="Desfazer"
        pendingLabel="Desfazendo…"
        isPending={isPending}
        destructive
        onConfirm={undo}
      />
    </li>
  );
}

function UsageList({
  projectId,
  documents,
}: {
  projectId: string;
  documents: UsageDocument[];
}) {
  if (documents.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Nenhum documento tem hoje respostas com valores diferentes desta classe.
      </p>
    );
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-brand hover:underline">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
        Funde respostas em {documents.length} documento{documents.length === 1 ? "" : "s"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 flex flex-wrap gap-1">
          {documents.map((document) => (
            <li key={document.id}>
              <Link
                href={`/projects/${projectId}/analyze/compare?doc=${document.id}`}
                className="inline-block max-w-64 truncate rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
                title={document.title}
              >
                {document.title}
              </Link>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function HistorySection({ history }: { history: EquivalenceHistoryView[] }) {
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center gap-1 px-3 py-2 text-left text-sm font-medium">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
        Histórico ({history.length})
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          equivalências desfeitas ou de versões anteriores das perguntas
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="divide-y border-t">
          {history.map((row) => (
            <li key={row.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="w-48 shrink-0 truncate text-muted-foreground" title={row.fieldLabel}>
                {row.fieldLabel}
              </span>
              <span className="min-w-0 flex-1 truncate" title={row.display}>
                {row.display}
              </span>
              <Badge variant="outline" className="shrink-0 font-normal">
                {row.reasonLabel}
              </Badge>
              <span className="shrink-0 text-muted-foreground">
                {row.reviewerName} · {formatOptionalDate(row.supersededAt)}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
