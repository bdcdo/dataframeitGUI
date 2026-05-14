"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DocumentReader } from "../coding/DocumentReader";
import { FullscreenNav } from "../coding/FullscreenNav";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { CompareNav } from "./CompareNav";
import { ComparisonPanel } from "./ComparisonPanel";
import { CompareDocList, type DocListEntry } from "./CompareDocList";
import { submitVerdict, markCompareDocReviewed, type ResponseSnapshotEntry } from "@/actions/reviews";
import {
  confirmEquivalentVerdict,
  unmarkEquivalencePair,
} from "@/actions/equivalences";
import { toast } from "sonner";
import { normalizeForComparison } from "@/lib/utils";
import { isFreeTextField } from "@/lib/compare-divergence";
import { buildResponseGroupKeys } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";
import type { DocCoverage } from "@/app/(app)/projects/[id]/analyze/compare/page";

interface EquivalencePairWire {
  id: string;
  response_a_id: string;
  response_b_id: string;
  reviewer_id: string | null;
}

interface CompareResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answers: Record<string, unknown>;
  justifications: Record<string, string> | null;
  is_current: boolean;
  pydantic_hash: string | null;
  answer_field_hashes: Record<string, string> | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
  created_at: string;
}

interface CompareDocument {
  id: string;
  title: string | null;
  external_id: string | null;
  text: string;
}

interface ExistingVerdictInfo {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface ComparePageProps {
  projectId: string;
  documents: CompareDocument[];
  responses: Record<string, CompareResponse[]>;
  divergentFields: Record<string, string[]>;
  fields: PydanticField[];
  existingReviews: Record<string, Record<string, ExistingVerdictInfo>>;
  projectPydanticHash: string | null;
  respondentNames: string[];
  coverageByDoc: Record<string, DocCoverage>;
  commentCountsByKey: Record<string, number>;
  suggestionCountsByField: Record<string, number>;
  availableVersions: string[];
  latestMajorLabel: string | null;
  currentProjectVersion: string;
  equivalencesByDocField: Record<
    string,
    Record<string, EquivalencePairWire[]>
  >;
  currentUserId: string;
  canManageAnyPair: boolean;
}

export function ComparePage({
  projectId,
  documents,
  responses,
  divergentFields,
  fields,
  existingReviews,
  projectPydanticHash,
  respondentNames,
  coverageByDoc,
  commentCountsByKey,
  suggestionCountsByField,
  availableVersions,
  latestMajorLabel,
  currentProjectVersion,
  equivalencesByDocField,
  currentUserId,
  canManageAnyPair,
}: ComparePageProps) {
  const [pinnedDocId, setPinnedDocId] = useState<string | null>(null);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [filter, setFilter] = useState("all");
  const [comment, setComment] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);

  const [localReviews, setLocalReviews] = useState<
    Record<string, Record<string, ExistingVerdictInfo>>
  >(existingReviews);

  // O parecer atual é derivado de `pinnedDocId` (última escolha explícita do
  // usuário). `documents` é reordenado pelo Server Component a cada
  // `revalidatePath` (sort por pendências); rastrear por índice numérico
  // faria o parecer mudar sob o usuário a cada veredito. Quando o ID atual
  // some da lista (filtro mudou, etc.) caímos para `documents[0]`.
  const docIndex = useMemo(() => {
    if (documents.length === 0) return 0;
    if (pinnedDocId) {
      const i = documents.findIndex((d) => d.id === pinnedDocId);
      if (i >= 0) return i;
    }
    return 0;
  }, [documents, pinnedDocId]);

  // Avisa quando o doc pinado some da lista (ex.: foi excluído). O
  // `docIndex` memo já cai para `documents[0]` automaticamente; aqui só
  // disparamos o toast uma vez, na transição "estava lá → sumiu".
  const lastValidPinnedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pinnedDocId || documents.length === 0) {
      lastValidPinnedRef.current = pinnedDocId;
      return;
    }
    const exists = documents.some((d) => d.id === pinnedDocId);
    if (exists) {
      lastValidPinnedRef.current = pinnedDocId;
    } else if (lastValidPinnedRef.current === pinnedDocId) {
      toast.info("Documento removido da fila — voltando ao topo.");
      lastValidPinnedRef.current = null;
    }
  }, [pinnedDocId, documents]);

  const currentDoc = documents[docIndex];
  const allDocDivergent = useMemo(
    () => (currentDoc ? divergentFields[currentDoc.id] || [] : []),
    [currentDoc, divergentFields],
  );
  const divergentSet = useMemo(() => new Set(allDocDivergent), [allDocDivergent]);

  const docFields = filter === "all"
    ? allDocDivergent
    : allDocDivergent.filter((fn) => fn === filter);
  const currentFieldName = docFields[fieldIndex];
  const currentField = fields.find((f) => f.name === currentFieldName);
  const isCurrentFieldDivergent = divergentSet.has(currentFieldName);
  const docResponses = currentDoc ? (responses[currentDoc.id] || []) : [];

  const reviewed = docFields.map((fn) => !!localReviews[currentDoc?.id]?.[fn]);

  const reviewedDocsCount = useMemo(() => {
    return documents.filter((doc) => {
      const fieldsForDoc = divergentFields[doc.id] || [];
      if (fieldsForDoc.length === 0) return false;
      return fieldsForDoc.every((fn) => !!localReviews[doc.id]?.[fn]);
    }).length;
  }, [documents, divergentFields, localReviews]);

  // Documento "concluído" = todos os campos divergentes têm veredito. Quando
  // verdadeiro, a UI mostra o botão "Próximo parecer" (com foco automático)
  // em vez de avançar por timer cego.
  const isCurrentDocComplete = useMemo(() => {
    if (!currentDoc || allDocDivergent.length === 0) return false;
    const docReviews = localReviews[currentDoc.id];
    if (!docReviews) return false;
    return allDocDivergent.every((fn) => !!docReviews[fn]);
  }, [currentDoc, allDocDivergent, localReviews]);

  const hasNextDoc = docIndex < documents.length - 1;

  const handleNextDoc = useCallback(() => {
    if (docIndex < documents.length - 1) {
      setPinnedDocId(documents[docIndex + 1].id);
      setFieldIndex(0);
    }
  }, [docIndex, documents]);

  const currentVerdict = currentDoc && currentFieldName
    ? localReviews[currentDoc.id]?.[currentFieldName] ?? null
    : null;

  useEffect(() => {
    setComment(currentVerdict?.comment || "");
  }, [currentFieldName, currentDoc?.id, currentVerdict?.comment]);

  const currentFieldHashes = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fields) {
      if (f.hash) map[f.name] = f.hash;
    }
    return map;
  }, [fields]);

  const fieldResponses = docResponses.map((r) => {
    let isFieldStale = false;
    if (r.answer_field_hashes) {
      const savedHash = r.answer_field_hashes[currentFieldName];
      const currentHash = currentFieldHashes[currentFieldName];
      isFieldStale = !savedHash || !currentHash || savedHash !== currentHash;
    } else {
      isFieldStale = !!projectPydanticHash && r.pydantic_hash !== projectPydanticHash;
    }
    const version =
      r.schema_version_major !== null
        ? `${r.schema_version_major}.${r.schema_version_minor ?? 0}.${r.schema_version_patch ?? 0}`
        : null;
    return {
      id: r.id,
      respondent_type: r.respondent_type,
      respondent_name: r.respondent_name,
      answer: Object.prototype.hasOwnProperty.call(r.answers, currentFieldName)
        ? r.answers[currentFieldName]
        : undefined,
      justification: r.justifications?.[currentFieldName],
      is_current: r.is_current,
      isFieldStale,
      schemaVersion: version,
    };
  });

  const currentFieldEquivalences = useMemo<EquivalencePairWire[]>(() => {
    if (!currentDoc || !currentFieldName) return [];
    return equivalencesByDocField[currentDoc.id]?.[currentFieldName] ?? [];
  }, [equivalencesByDocField, currentDoc, currentFieldName]);

  const allowEquivalence = useMemo(() => {
    return !!currentField && isFreeTextField(currentField);
  }, [currentField]);

  const answerGroups = useMemo(() => {
    const present = fieldResponses.filter((r) => r.answer !== undefined);
    const groupKeys = buildResponseGroupKeys(
      present,
      currentFieldEquivalences,
      (r) => normalizeForComparison(r.answer),
    );
    const map = new Map<string, typeof fieldResponses>();
    for (const r of present) {
      const key = groupKeys.get(r.id) ?? r.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.values()].sort((a, b) => b.length - a.length);
  }, [fieldResponses, currentFieldEquivalences]);

  const handleVerdict = useCallback(
    async (verdict: string, chosenResponseId?: string) => {
      if (!currentDoc || !currentFieldName || !isCurrentFieldDivergent) return;

      const verdictComment = comment || undefined;

      const nextDocReviews = {
        ...localReviews[currentDoc.id],
        [currentFieldName]: {
          verdict,
          chosenResponseId: chosenResponseId ?? null,
          comment: verdictComment ?? null,
        },
      };
      setLocalReviews((prev) => ({
        ...prev,
        [currentDoc.id]: { ...prev[currentDoc.id], ...nextDocReviews },
      }));

      const snapshot: ResponseSnapshotEntry[] = fieldResponses
        .filter((r) => r.answer !== undefined)
        .map((r) => ({
          id: r.id,
          respondent_name: r.respondent_name,
          respondent_type: r.respondent_type,
          answer: r.answer,
          ...(r.justification ? { justification: r.justification } : {}),
        }));

      await submitVerdict(projectId, currentDoc.id, currentFieldName, verdict, chosenResponseId, verdictComment, snapshot);

      setComment("");
      toast.success("Veredito salvo!");

      // Usa `nextDocReviews` (já contém o veredito recém-emitido) em vez de
      // `localReviews`, que ainda reflete o estado pré-setState neste closure.
      const allFieldsReviewed = allDocDivergent.every((fn) => !!nextDocReviews[fn]);

      if (allFieldsReviewed) {
        toast.success("Revisão do documento concluída!");
      } else if (fieldIndex < docFields.length - 1) {
        setFieldIndex(fieldIndex + 1);
      }
    },
    [projectId, currentDoc, currentFieldName, isCurrentFieldDivergent, fieldIndex, docFields, allDocDivergent, localReviews, comment, fieldResponses]
  );

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      if (documents.length === 0) return;
      const clamped = Math.max(0, Math.min(newIndex, documents.length - 1));
      setPinnedDocId(documents[clamped].id);
      setFieldIndex(0);
    },
    [documents]
  );

  const toggleFullscreen = useCallback(() => setIsFullscreen((prev) => !prev), []);

  const handleMarkReviewed = useCallback(async () => {
    if (!currentDoc) return;
    await markCompareDocReviewed(projectId, currentDoc.id);
    toast.success("Documento marcado como revisado.");
  }, [projectId, currentDoc]);

  const handleConfirmEquivalent = useCallback(
    async (
      responseIds: string[],
      gabaritoId: string,
      verdictDisplay: string,
    ) => {
      if (!currentDoc || !currentFieldName || !isCurrentFieldDivergent) return;

      const verdictComment = comment || undefined;
      const docId = currentDoc.id;
      const fieldName = currentFieldName;

      const nextDocReviews = {
        ...localReviews[docId],
        [fieldName]: {
          verdict: verdictDisplay,
          chosenResponseId: gabaritoId,
          comment: verdictComment ?? null,
        },
      };
      setLocalReviews((prev) => ({
        ...prev,
        [docId]: { ...prev[docId], ...nextDocReviews },
      }));

      const snapshot: ResponseSnapshotEntry[] = fieldResponses
        .filter((r) => r.answer !== undefined)
        .map((r) => ({
          id: r.id,
          respondent_name: r.respondent_name,
          respondent_type: r.respondent_type,
          answer: r.answer,
          ...(r.justification ? { justification: r.justification } : {}),
        }));

      try {
        await confirmEquivalentVerdict(
          projectId,
          docId,
          fieldName,
          responseIds,
          gabaritoId,
          verdictDisplay,
          verdictComment,
          snapshot,
        );
        setComment("");
        toast.success(
          `${responseIds.length} respostas marcadas como equivalentes.`,
        );

        // Usa `nextDocReviews` (já contém o veredito recém-emitido) em vez de
        // `localReviews`, que ainda reflete o estado pré-setState neste closure.
        const allFieldsReviewed = allDocDivergent.every(
          (fn) => !!nextDocReviews[fn],
        );
        if (allFieldsReviewed) {
          toast.success("Revisão do documento concluída!");
        } else if (fieldIndex < docFields.length - 1) {
          setFieldIndex(fieldIndex + 1);
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Falha ao marcar equivalentes.",
        );
      }
    },
    [
      projectId,
      currentDoc,
      currentFieldName,
      isCurrentFieldDivergent,
      fieldIndex,
      docFields,
      allDocDivergent,
      localReviews,
      comment,
      fieldResponses,
    ],
  );

  const handleUnmarkPair = useCallback(
    async (pairId: string) => {
      try {
        await unmarkEquivalencePair(projectId, pairId);
        toast.success("Equivalência removida.");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Falha ao desfazer equivalência.",
        );
      }
    },
    [projectId],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === "F" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
        return;
      }
      if (e.key === "Escape" && isFullscreen) {
        setIsFullscreen(false);
        return;
      }

      if (e.key === "n" && fieldIndex < docFields.length - 1) { setFieldIndex(fieldIndex + 1); return; }
      if (e.key === "p" && fieldIndex > 0) { setFieldIndex(fieldIndex - 1); return; }

      if (!isCurrentFieldDivergent) return;

      const isMultiField = currentField?.type === "multi" && currentField.options?.length;
      if (isMultiField) {
        if (e.key === "a") handleVerdict("ambiguo");
        if (e.key === "s") handleVerdict("pular");
        return;
      }

      const num = parseInt(e.key);
      if (num >= 1 && num <= answerGroups.length) {
        const group = answerGroups[num - 1];
        const answer = group[0].answer;
        const displayAnswer = answer == null ? "" : Array.isArray(answer) ? answer.join(", ") : String(answer);
        handleVerdict(displayAnswer, group[0].id);
        return;
      }

      if (e.key === "a") handleVerdict("ambiguo");
      if (e.key === "s") handleVerdict("pular");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [answerGroups, handleVerdict, fieldIndex, docFields.length, isFullscreen, isCurrentFieldDivergent, currentField]);

  const docListEntries: DocListEntry[] = documents.map((d) => {
    const c = coverageByDoc[d.id];
    const reviewedOverride = localReviews[d.id]
      ? (divergentFields[d.id] ?? []).filter((fn) => !!localReviews[d.id][fn]).length
      : c?.reviewedCount ?? 0;
    return {
      id: d.id,
      title: d.title,
      external_id: d.external_id,
      humanCount: c?.humanCount ?? 0,
      totalCount: c?.totalCount ?? 0,
      assignedCodingCount: c?.assignedCodingCount ?? 0,
      humansFromAssigned: c?.humansFromAssigned ?? 0,
      divergentCount: c?.divergentCount ?? 0,
      reviewedCount: reviewedOverride,
      assignmentStatus: c?.assignmentStatus ?? null,
    };
  });

  if (!currentDoc || docFields.length === 0) {
    return (
      <div className="flex h-[calc(100vh-96px)] w-full">
        <CompareDocList
          docs={docListEntries}
          currentIndex={docIndex}
          onSelect={handleDocNavigate}
          collapsed={listCollapsed}
          onToggle={() => setListCollapsed((v) => !v)}
        />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          {documents.length === 0
            ? "Nenhum documento na fila com os filtros atuais."
            : "Nenhuma divergência neste documento."}
        </div>
      </div>
    );
  }

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const parecerUrl = `${baseUrl}/projects/${projectId}/analyze/code?doc=${currentDoc.id}`;
  const docTitle = currentDoc.title || currentDoc.external_id || "Documento";

  const fieldCommentCount =
    (commentCountsByKey[`${currentDoc.id}|${currentFieldName}`] ?? 0) +
    (commentCountsByKey[`${currentDoc.id}|`] ?? 0);
  const fieldSuggestionCount = suggestionCountsByField[currentFieldName] ?? 0;

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-96px)] flex-col"
      }
    >
      {isFullscreen ? (
        <FullscreenNav
          title={docTitle}
          currentIndex={docIndex}
          total={documents.length}
          onNavigate={handleDocNavigate}
          onExit={toggleFullscreen}
        />
      ) : (
        <CompareNav
          title={docTitle}
          docIndex={docIndex}
          totalDocs={documents.length}
          onDocNavigate={handleDocNavigate}
          filter={filter}
          onFilterChange={(v) => { setFilter(v); setFieldIndex(0); }}
          fields={fields}
          reviewedDocsCount={reviewedDocsCount}
          onToggleFullscreen={toggleFullscreen}
          parecerUrl={parecerUrl}
          respondentNames={respondentNames}
          availableVersions={availableVersions}
          latestMajorLabel={latestMajorLabel}
          currentProjectVersion={currentProjectVersion}
          projectId={projectId}
          documentId={currentDoc?.id}
        />
      )}

      <div className="flex flex-1 overflow-hidden">
        <CompareDocList
          docs={docListEntries}
          currentIndex={docIndex}
          onSelect={handleDocNavigate}
          collapsed={listCollapsed}
          onToggle={() => setListCollapsed((v) => !v)}
        />

        <ResizablePanelGroup className="flex-1">
          <ResizablePanel defaultSize={50} minSize={25}>
            <DocumentReader text={currentDoc.text} />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={50} minSize={25}>
            <ComparisonPanel
              projectId={projectId}
              documentId={currentDoc?.id}
              documentTitle={docTitle}
              fieldName={currentFieldName}
              fieldDescription={currentField?.description || currentFieldName}
              fieldType={currentField?.type}
              fieldOptions={currentField?.options}
              fields={fields}
              fieldIndex={fieldIndex}
              totalFields={docFields.length}
              responses={fieldResponses}
              existingVerdict={currentVerdict}
              reviewed={reviewed}
              isDivergent={isCurrentFieldDivergent}
              isDocComplete={isCurrentDocComplete}
              hasNextDoc={hasNextDoc}
              onNextDoc={handleNextDoc}
              onFieldNavigate={setFieldIndex}
              onVerdict={handleVerdict}
              onMarkReviewed={handleMarkReviewed}
              comment={comment}
              onCommentChange={setComment}
              commentCount={fieldCommentCount}
              suggestionCount={fieldSuggestionCount}
              allowEquivalence={allowEquivalence}
              equivalences={currentFieldEquivalences}
              onConfirmEquivalent={handleConfirmEquivalent}
              onUnmarkEquivalencePair={handleUnmarkPair}
              currentUserId={currentUserId}
              canManageAnyPair={canManageAnyPair}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
