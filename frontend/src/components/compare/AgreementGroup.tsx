"use client";

import { useMemo, useState, useTransition } from "react";
import { AnswerCard, type EquivalentVariant } from "./AnswerCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { normalizeForComparison } from "@/lib/utils";
import { buildResponseGroupKeys } from "@/lib/equivalence";
import { Link2 } from "lucide-react";

interface AgreementResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answer: unknown;
  justification?: string;
  is_current: boolean;
  isFieldStale: boolean;
  schemaVersion?: string | null;
}

export interface FieldEquivalencePair {
  id: string;
  response_a_id: string;
  response_b_id: string;
  reviewer_id: string | null;
}

function compareVersionsDesc(a: string, b: string): number {
  const [am, an, ap] = a.split(".").map((n) => Number.parseInt(n, 10));
  const [bm, bn, bp] = b.split(".").map((n) => Number.parseInt(n, 10));
  if (am !== bm) return bm - am;
  if (an !== bn) return bn - an;
  return bp - ap;
}

interface ExistingVerdict {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface AgreementGroupProps {
  responses: AgreementResponse[];
  existingVerdict: ExistingVerdict | null;
  onVote: (displayAnswer: string, chosenResponseId: string) => void;
  allowEquivalence: boolean;
  equivalences: FieldEquivalencePair[];
  onConfirmEquivalent?: (
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  onUnmarkPair?: (pairId: string) => Promise<void>;
  currentUserId: string;
  canManageAnyPair: boolean;
}

function formatAnswer(answer: unknown): string {
  if (answer == null) return "";
  if (typeof answer === "string") return answer.trim();
  if (Array.isArray(answer))
    return answer.map((v) => (typeof v === "string" ? v.trim() : v)).join(", ");
  if (typeof answer === "object") {
    const obj = answer as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
  }
  return String(answer);
}

interface RenderedGroup {
  groupKey: string;
  displayAnswer: string;
  responses: AgreementResponse[];
  variants: EquivalentVariant[];
}

export function AgreementGroup({
  responses,
  existingVerdict,
  onVote,
  allowEquivalence,
  equivalences,
  onConfirmEquivalent,
  onUnmarkPair,
  currentUserId,
  canManageAnyPair,
}: AgreementGroupProps) {
  // Track selection order so the first selected card is the default gabarito.
  const [selectionOrder, setSelectionOrder] = useState<string[]>([]);
  const [gabaritoOverride, setGabaritoOverride] = useState<string | null>(null);
  const [isSubmitting, startTransition] = useTransition();

  const groups = useMemo<RenderedGroup[]>(() => {
    const present = responses.filter((r) => r.answer !== undefined);
    const groupKeys = buildResponseGroupKeys(present, equivalences, (r) =>
      normalizeForComparison(r.answer),
    );

    const map = new Map<string, RenderedGroup>();
    for (const r of present) {
      const key = groupKeys.get(r.id) ?? r.id;
      if (!map.has(key)) {
        map.set(key, {
          groupKey: key,
          displayAnswer: formatAnswer(r.answer),
          responses: [],
          variants: [],
        });
      }
      map.get(key)!.responses.push(r);
    }

    for (const group of map.values()) {
      const idsInGroup = new Set(group.responses.map((r) => r.id));
      const respondentById = new Map(
        group.responses.map((r) => [r.id, r] as const),
      );
      for (const p of equivalences) {
        if (idsInGroup.has(p.response_a_id) && idsInGroup.has(p.response_b_id)) {
          const a = respondentById.get(p.response_a_id);
          const b = respondentById.get(p.response_b_id);
          if (a && b) {
            group.variants.push({
              pairId: p.id,
              reviewerId: p.reviewer_id,
              respondentName: `${a.respondent_name} ↔ ${b.respondent_name}`,
              answerDisplay: `${formatAnswer(a.answer)} · ${formatAnswer(b.answer)}`,
            });
          }
        }
      }
    }

    return [...map.values()].sort(
      (a, b) => b.responses.length - a.responses.length,
    );
  }, [responses, equivalences]);

  // Stale selection entries (groups that disappeared after a navigation or
  // server-side fusion) are silently filtered out here; we don't need an
  // effect to clear them because they're never visible in the UI.
  // The parent (ComparisonPanel) keys this component by field+doc, so a
  // navigation also remounts and resets selection state naturally.
  const selectedGroups = selectionOrder
    .map((key) => groups.find((g) => g.groupKey === key))
    .filter((g): g is RenderedGroup => !!g);

  const showGabarito = selectedGroups.length >= 2;
  const effectiveGabarito =
    gabaritoOverride && selectionOrder.includes(gabaritoOverride)
      ? gabaritoOverride
      : (selectionOrder[0] ?? null);

  function toggleSelection(groupKey: string) {
    setSelectionOrder((prev) => {
      if (prev.includes(groupKey)) {
        if (gabaritoOverride === groupKey) setGabaritoOverride(null);
        return prev.filter((k) => k !== groupKey);
      }
      return [...prev, groupKey];
    });
  }

  function handleConfirm() {
    if (!onConfirmEquivalent) return;
    if (selectedGroups.length < 2 || !effectiveGabarito) return;
    const gabaritoGroup = selectedGroups.find(
      (g) => g.groupKey === effectiveGabarito,
    );
    if (!gabaritoGroup) return;
    const gabaritoResponseId = gabaritoGroup.responses[0].id;
    // Send only one representative per group: responses sharing the same
    // literal answer are already fused server-side via same-answer fusion,
    // so adding redundant intra-group pairs would just create useless rows.
    const responseIds = selectedGroups.map((g) => g.responses[0].id);
    const verdictDisplay = gabaritoGroup.displayAnswer;
    startTransition(async () => {
      await onConfirmEquivalent(responseIds, gabaritoResponseId, verdictDisplay);
      setSelectionOrder([]);
      setGabaritoOverride(null);
    });
  }

  function handleUnmark(pairId: string) {
    if (!onUnmarkPair) return;
    startTransition(async () => {
      await onUnmarkPair(pairId);
    });
  }

  const gabaritoLabel = (() => {
    if (!effectiveGabarito) return "";
    const g = selectedGroups.find((s) => s.groupKey === effectiveGabarito);
    return g?.displayAnswer ?? "";
  })();

  const selectedResponseCount = selectedGroups.reduce(
    (acc, g) => acc + g.responses.length,
    0,
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-1.5">
        {allowEquivalence && groups.length > 1 && (
          <div className="rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-2.5 py-1.5 text-[11px] leading-tight text-muted-foreground">
            <p>
              <Link2 className="mr-1 inline h-3 w-3" />
              Texto livre: marque os cards equivalentes e indique qual fica
              como <strong>gabarito</strong> (a resposta que será registrada).
            </p>
          </div>
        )}

        {groups.map((group, i) => {
          const hasLlm = group.responses.some(
            (r) => r.respondent_type === "llm",
          );
          const llmResponse = group.responses.find(
            (r) => r.respondent_type === "llm",
          );
          const staleCount = group.responses.filter(
            (r) => r.isFieldStale,
          ).length;
          const isChosen = group.responses.some(
            (r) => r.id === existingVerdict?.chosenResponseId,
          );
          const versions = [
            ...new Set(
              group.responses
                .map((r) => r.schemaVersion)
                .filter((v): v is string => !!v),
            ),
          ].sort(compareVersionsDesc);

          const isSelected = selectionOrder.includes(group.groupKey);

          return (
            <AnswerCard
              key={group.groupKey}
              index={i}
              displayAnswer={group.displayAnswer}
              respondentNames={group.responses.map((r) => r.respondent_name)}
              respondentCount={group.responses.length}
              hasLlm={hasLlm}
              llmJustification={llmResponse?.justification}
              staleCount={staleCount}
              isChosen={isChosen}
              versions={versions}
              onVote={() => onVote(group.displayAnswer, group.responses[0].id)}
              selectable={allowEquivalence}
              selected={isSelected}
              onSelectionToggle={() => toggleSelection(group.groupKey)}
              showGabarito={showGabarito && isSelected}
              isGabarito={effectiveGabarito === group.groupKey}
              onSetGabarito={() => setGabaritoOverride(group.groupKey)}
              equivalentVariants={
                group.variants.length > 0 ? group.variants : undefined
              }
              onUnmarkPair={onUnmarkPair ? handleUnmark : undefined}
              canUnmarkPair={(v) =>
                canManageAnyPair || v.reviewerId === currentUserId
              }
            />
          );
        })}

        {allowEquivalence && selectedGroups.length >= 2 && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-brand/30 bg-brand/5 px-2.5 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Gabarito:{" "}
              <span className="font-medium text-foreground">
                {gabaritoLabel || "—"}
              </span>
            </span>
            <Button
              size="sm"
              className="h-7 gap-1"
              disabled={isSubmitting || !effectiveGabarito}
              onClick={handleConfirm}
            >
              <Link2 className="h-3.5 w-3.5" />
              Confirmar {selectedResponseCount} respostas como equivalentes
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
