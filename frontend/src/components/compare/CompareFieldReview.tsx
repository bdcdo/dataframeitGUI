"use client";

import { AgreementGroup } from "./AgreementGroup";
import type { ValueEquivalence } from "@/lib/equivalence";
import { MultiOptionReview } from "./MultiOptionReview";
import { DivergenceActionsPanel } from "./DivergenceActionsPanel";
import { UnansweredNotice } from "./UnansweredNotice";
import { CompareFieldScope } from "./compare-field-scope";
import type { PendingVerdict, VerdictOrigin } from "./compare-types";
import type { StaleVerdictInfo, VerdictInfo } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { DomainField } from "@/lib/review-validity";

export interface ComparisonResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  respondent_id: string | null;
  answer: unknown;
  justification?: string;
  is_latest: boolean;
  isFieldStale: boolean;
  answersCurrentQuestion: boolean;
  schemaVersion?: string | null;
}

// Affordances de equivalência agrupadas: o painel carrega uma config estruturada
// em vez de dois booleanos soltos (`allowEquivalence`, `canManageAnyPair`) e os
// repassa ao AgreementGroup.
export interface EquivalenceConfig {
  allow: boolean;
  canManageAnyPair: boolean;
}

interface CompareFieldReviewProps {
  readOnly: boolean;
  projectId: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fields: PydanticField[];
  isMulti: boolean;
  displayOptions: string[];
  responses: ComparisonResponse[];
  existingVerdict: VerdictInfo | null;
  /** Veredito do revisor que perdeu a validade; só referência (#758). */
  staleVerdict?: StaleVerdictInfo | null;
  pendingVerdict: PendingVerdict | null;
  isSavingVerdict: boolean;
  onVerdict: (verdict: string, chosenResponseId?: string) => void;
  onPrepareVerdict: (pending: PendingVerdict) => void;
  comment: string;
  onCommentChange: (value: string) => void;
  equivalence: EquivalenceConfig;
  equivalences: ValueEquivalence[];
  onConfirmEquivalent: (
    origin: VerdictOrigin,
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  onUnmarkEquivalencePair: (pairId: string) => Promise<void>;
  currentUserId: string;
  // Um objeto, e não dois callbacks soltos: é a MESMA forma que o
  // `AgreementGroup` e o `DivergenceActionsPanel` já recebem, então a
  // confirmação viaja com um formato só da borda do painel até a folha.
  pendingConfirm: {
    onConfirm: () => void;
    onDiscard: () => void;
  };
}

/**
 * Tudo que pertence a UM campo divergente: os cards de resposta (ou a grade de
 * um campo multi), o aviso de quem não respondeu e as ações da divergência.
 * Só campo divergente chega aqui (ver `isCurrentFieldDivergent` em
 * `useCompareNavigation`), por isso não há ramo "concordante" (#616).
 *
 * Existe como componente próprio para que a identidade do campo seja UMA
 * fronteira de montagem, não três keys irmãs coincidentes — que era o desenho
 * anterior, em que `AgreementGroup`, `DivergenceActionsPanel` e
 * `MultiOptionReview` ficavam keyados pela mesma string em posições distintas
 * do mesmo pai. Duas consequências, e a segunda é a que importa para a #613:
 *
 * 1. a troca de campo passa a ser uma única deleção de subárvore, então um
 *    resíduo de DOM (o defeito da #613, cuja causa no reconciler segue em
 *    investigação) seria um painel inteiro e coerente, nunca meia tela de cards
 *    do campo antigo intercalada com as ações do campo atual;
 * 2. o `CompareFieldScope` montado aqui carimba a origem de toda decisão criada
 *    nesta subárvore. Como uma subárvore fantasma não re-renderiza, ela nunca
 *    passa a ver o campo novo — e o rascunho que ela produz é recusado na
 *    fronteira de escrita em vez de gravar no campo errado.
 *
 * Fica DE FORA da fronteira, deliberadamente, tudo que não é do campo: o
 * cabeçalho, os ProgressDots, o rodapé de confirmação e o container de scroll —
 * assim a troca de campo não zera o `scrollTop` nem rouba o foco.
 */
// Cognitive acima do limiar 15 (números no `fallow health`): a pontuação
// vem do encaminhamento de props, que o fallow conta como fiação. É o mesmo
// débito JSX inerente já rastreado na #580 para ComparePage/CompareMainView.
//
// A medição é explícita, não suposta: extrair este componente levou o
// ComparisonPanel de cognitive 55 para 53, então a extração NÃO reduz a
// complexidade total — realoca. Ela fica mesmo assim porque a razão de existir é
// de correção, não de métrica: é a fronteira única de montagem por campo que
// sustenta o escopo de origem do veredito (#613). Descer a ≤15 exigiria
// fragmentar o encaminhamento em componentes sem significado próprio.
// fallow-ignore-next-line complexity
export function CompareFieldReview({
  readOnly,
  projectId,
  documentId,
  documentTitle,
  fieldName,
  fieldDescription,
  fields,
  isMulti,
  displayOptions,
  responses,
  existingVerdict,
  staleVerdict = null,
  pendingVerdict,
  isSavingVerdict,
  onVerdict,
  onPrepareVerdict,
  comment,
  onCommentChange,
  equivalence,
  equivalences,
  onConfirmEquivalent,
  onUnmarkEquivalencePair,
  currentUserId,
  pendingConfirm: pendingConfirmActions,
}: CompareFieldReviewProps) {
  const pendingConfirm = {
    ...pendingConfirmActions,
    isSaving: isSavingVerdict,
  };

  // A barra de confirmação nasce no elemento que PRODUZIU o rascunho. Para
  // `kind: "response"` esse elemento é um card — mas só se o card existir de
  // fato na lista renderizada. Um rascunho apontando para resposta que o
  // `AgreementGroup` não mostra (`answer === undefined` é filtrado lá) não teria
  // barra em lugar nenhum, e o `guardNavigation` do #434 travaria a navegação
  // com um rascunho impossível de confirmar ou descartar pelo mouse: um
  // soft-lock, que é o defeito do #430 com o sinal trocado. Quando a âncora não
  // existe, o painel de ações assume a barra.
  const anchoredToCard =
    pendingVerdict?.kind === "response" &&
    responses.some(
      (r) => r.id === pendingVerdict.chosenResponseId && r.answer !== undefined,
    );

  return (
    <CompareFieldScope documentId={documentId} fieldName={fieldName}>
      {isMulti ? (
        <MultiOptionReview
          readOnly={readOnly}
          options={displayOptions}
          responses={responses}
          existingVerdict={existingVerdict}
          isSubmitting={isSavingVerdict}
          onSubmit={(verdictJson) => onVerdict(verdictJson)}
        />
      ) : (
        <SingleAnswerGroup
          readOnly={readOnly}
          origin={{ documentId, fieldName }}
          domainField={fields.find((f) => f.name === fieldName) ?? null}
          responses={responses}
          existingVerdict={existingVerdict}
          pendingVerdict={pendingVerdict}
          onPrepareVerdict={onPrepareVerdict}
          equivalence={equivalence}
          equivalences={equivalences}
          onConfirmEquivalent={onConfirmEquivalent}
          onUnmarkEquivalencePair={onUnmarkEquivalencePair}
          currentUserId={currentUserId}
          pendingConfirm={pendingConfirm}
        />
      )}

      <UnansweredNotice responses={responses} />

      <DivergenceActionsPanel
        readOnly={readOnly}
        projectId={projectId}
        documentTitle={documentTitle}
        fieldDescription={fieldDescription}
        fields={fields}
        isMulti={isMulti}
        existingVerdict={existingVerdict}
        staleVerdict={staleVerdict}
        pendingVerdict={pendingVerdict}
        onPrepareVerdict={onPrepareVerdict}
        comment={comment}
        onCommentChange={onCommentChange}
        pendingConfirm={anchoredToCard ? null : pendingConfirm}
      />
    </CompareFieldScope>
  );
}

/**
 * Cards de resposta de um campo NÃO-multi. Separado do `CompareFieldReview`
 * porque é aqui que mora a adaptação entre a forma das respostas do painel e a
 * do `AgreementGroup`, e o carimbo de origem nos dois callbacks de escrita.
 */
function SingleAnswerGroup({
  readOnly,
  origin,
  domainField,
  responses,
  existingVerdict,
  pendingVerdict,
  onPrepareVerdict,
  equivalence,
  equivalences,
  onConfirmEquivalent,
  onUnmarkEquivalencePair,
  currentUserId,
  pendingConfirm,
}: {
  readOnly: boolean;
  origin: VerdictOrigin;
  domainField: DomainField | null;
  responses: ComparisonResponse[];
  existingVerdict: VerdictInfo | null;
  pendingVerdict: PendingVerdict | null;
  onPrepareVerdict: (pending: PendingVerdict) => void;
  equivalence: EquivalenceConfig;
  equivalences: ValueEquivalence[];
  onConfirmEquivalent: CompareFieldReviewProps["onConfirmEquivalent"];
  onUnmarkEquivalencePair: (pairId: string) => Promise<void>;
  currentUserId: string;
  pendingConfirm: {
    onConfirm: () => void;
    onDiscard: () => void;
    isSaving: boolean;
  };
}) {
  return (
    <AgreementGroup
      readOnly={readOnly}
      responses={responses.map((r) => ({
        id: r.id,
        respondent_type: r.respondent_type,
        respondent_name: r.respondent_name,
        answer: r.answer,
        justification: r.justification,
        is_latest: r.is_latest,
        isFieldStale: r.isFieldStale,
        answersCurrentQuestion: r.answersCurrentQuestion,
        schemaVersion: r.schemaVersion,
      }))}
      existingVerdict={existingVerdict}
      pendingVerdict={pendingVerdict}
      domainField={domainField}
      // `origin` vem das props deste render — e não do container. É o que faz um
      // clique em card fantasma carregar o campo FANTASMA, que a fronteira de
      // escrita recusa, em vez de herdar o campo atual e gravar nele (#613).
      onVote={(displayAnswer, chosenResponseId) =>
        onPrepareVerdict({
          kind: "response",
          verdict: displayAnswer,
          chosenResponseId,
          origin,
        })
      }
      allowEquivalence={equivalence.allow}
      equivalences={equivalences}
      onConfirmEquivalent={(responseIds, gabaritoId, verdictDisplay) =>
        onConfirmEquivalent(origin, responseIds, gabaritoId, verdictDisplay)
      }
      onUnmarkPair={onUnmarkEquivalencePair}
      currentUserId={currentUserId}
      canManageAnyPair={equivalence.canManageAnyPair}
      pendingConfirm={pendingConfirm}
    />
  );
}
