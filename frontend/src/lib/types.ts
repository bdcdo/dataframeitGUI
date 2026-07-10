export interface Profile {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  // NULL = membro pendente (pré-registrado, nunca teve acesso autenticado).
  activated_at: string | null;
}

export type RoundStrategy = "schema_version" | "manual";

// Modo de automação de revisão do projeto (projects.automation_mode). Define o
// "mínimo necessário para liberar a revisão" + quem revê, e governa quais abas
// de revisão aparecem. Mutuamente exclusivo. Ver lib/auto-review.ts (auto_review_llm)
// e lib/auto-comparison.ts (compare_*).
export type AutomationMode =
  | "none"
  | "auto_review_llm"
  | "compare_humans"
  | "compare_llm";

// Fonte única dos rótulos/descrições dos modos — reaproveitada pelos seletores
// de criação (projects/new) e de Config › Regras (RulesForm), evitando drift.
export const AUTOMATION_MODES: ReadonlyArray<{
  value: AutomationMode;
  label: string;
  description: string;
}> = [
  {
    value: "none",
    label: "Nenhuma automação",
    description:
      "Sem revisão automática. Qualquer comparação ou revisão é criada manualmente pelo coordenador.",
  },
  {
    value: "auto_review_llm",
    label: "Auto-revisão vs LLM",
    description:
      "Quando uma pessoa termina de codificar e diverge do LLM, ela mesma revisa os campos divergentes; contestados vão para arbitragem.",
  },
  {
    value: "compare_humans",
    label: "Comparação humano-vs-humano",
    description:
      "Quando duas pessoas codificam o mesmo documento e divergem, um revisor é sorteado para comparar as codificações.",
  },
  {
    value: "compare_llm",
    label: "Comparação pessoa-vs-LLM",
    description:
      "Quando uma pessoa codifica e diverge do LLM, um revisor é sorteado para comparar a codificação humana contra a do LLM.",
  },
];

export interface Round {
  id: string;
  project_id: string;
  label: string;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  pydantic_code: string | null;
  pydantic_hash: string | null;
  pydantic_fields: PydanticField[] | null;
  prompt_template: string | null;
  llm_provider: string;
  llm_model: string;
  llm_kwargs: Record<string, unknown>;
  resolution_rule: string;
  min_responses_for_comparison: number;
  allow_researcher_review: boolean;
  round_strategy: RoundStrategy;
  current_round_id: string | null;
  arbitration_blind: boolean;
  automation_mode: AutomationMode;
  // Só relevante em automation_mode = "compare_humans": inclui a resposta do LLM
  // (quando existe) no cálculo de divergência que dispara a comparação.
  comparison_includes_llm: boolean;
  // Mostra a pergunta "Documento fora do escopo?" no topo do formulário de
  // codificação. Desligar só esconde a pergunta; pedidos pendentes continuam
  // valendo até decisão do coordenador.
  out_of_scope_enabled: boolean;
}

export interface SubfieldDef {
  key: string;
  label: string;
  required?: boolean;
}

export type ConditionScalar = string | number | boolean;

export type FieldCondition =
  | { field: string; equals: ConditionScalar }
  | { field: string; not_equals: ConditionScalar }
  | { field: string; in: ConditionScalar[] }
  | { field: string; not_in: ConditionScalar[] }
  | { field: string; exists: boolean };

export interface PydanticField {
  name: string;
  type: "single" | "multi" | "text" | "date";
  options: string[] | null;
  description: string;
  help_text?: string;
  target?: "all" | "llm_only" | "human_only" | "none";
  required?: boolean;
  hash?: string;
  subfields?: SubfieldDef[];
  subfield_rule?: "all" | "at_least_one";
  allow_other?: boolean;
  condition?: FieldCondition;
  // Texto-base do prompt da justificativa do LLM para este campo. Quando
  // ausente, o backend usa um default exigente (cita trecho do documento).
  // Ver _extend_model_with_justifications em backend/services/llm_runner.py.
  justification_prompt?: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: "coordenador" | "pesquisador";
  can_arbitrate: boolean;
  can_resolve: boolean;
  // Elegível para receber comparações automáticas (assignComparisonReviewer).
  can_compare: boolean;
  // Carga relativa no sorteio (1 = normal, 0.5 = metade). Ver distributeDocs.
  // Opcional: nem toda query de project_members seleciona estas colunas.
  assignment_weight?: number;
  // Teto absoluto de docs novos por sorteio; null = sem limite individual.
  assignment_cap?: number | null;
  profiles?: Profile;
}

// E-mail adicional vinculado a um membro, com efeito restrito ao projeto
// (spec 002). linked_user_id NULL = vínculo aguardando a conta existir.
export interface MemberEmailLink {
  id: string;
  project_id: string;
  member_user_id: string;
  email: string;
  linked_user_id: string | null;
  created_by: string;
  created_at: string;
}

// Linha original completa do CSV preservada em documents.metadata (feature 004).
// original_columns existe porque jsonb não preserva a ordem das chaves — é a
// fonte da ordenação das colunas originais no export (ver data-model.md §1).
export interface DocumentMetadata {
  original_row: Record<string, string>;
  original_columns: string[];
}

export interface Document {
  id: string;
  project_id: string;
  external_id: string | null;
  title: string | null;
  text: string;
  metadata: DocumentMetadata | null;
  created_at: string;
  excluded_at: string | null;
  excluded_reason: string | null;
  excluded_by: string | null;
  // Pedido de exclusão pendente (fora de escopo aguardando coordenador);
  // derivado dos exclusion_requests por trigger no banco.
  exclusion_pending_at: string | null;
}

type AssignmentType =
  | "codificacao"
  | "comparacao"
  | "auto_revisao"
  | "arbitragem";

export interface Assignment {
  id: string;
  project_id: string;
  document_id: string;
  user_id: string;
  status: "pendente" | "em_andamento" | "concluido";
  type: AssignmentType;
  batch_id: string | null;
  completed_at: string | null;
}

/**
 * Documento na visão de codificação, com o subconjunto de `assignment` que o
 * modo Atribuídos usa (id + status). Fonte única consumida por `CodingPage`,
 * `useAssignedCoding` e `useBrowseCoding` (evita redefinir o mesmo tipo em cada
 * arquivo).
 */
export type AssignedDoc = Document & {
  assignment?: Pick<Assignment, "id" | "status">;
};

// Snapshot por-campo do schema contra o qual a response foi codificada
// (1 chave por campo existente na época, valor = field.hash). Gravado em
// saveResponse iterando o schema completo (não os campos respondidos), então
// "chave ausente" significa "campo não existia no schema na época" — base
// para a heurística de staleness em compare-divergence e reviews/queries.
// `null`/`{}` significam legacy (response pré-coluna ou schema sem hashes):
// não dá para inferir staleness.
export type AnswerFieldHashes = Record<string, string> | null;

// Vereditos da auto-revisao. Todos resolvem o campo; só `contesta_llm` abre
// arbitragem. `equivalente` registra o par humano↔LLM em response_equivalences;
// `ambiguo` gera um project_comments para discussão.
export type SelfVerdict =
  | "admite_erro"
  | "contesta_llm"
  | "equivalente"
  | "ambiguo";
export type ArbitrationVerdict = "humano" | "llm";

export type SchemaChangeType = "major" | "minor" | "patch" | "initial";

export interface SchemaChangeEntry {
  id: string;
  fieldName: string;
  changeSummary: string;
  beforeValue: Record<string, unknown>;
  afterValue: Record<string, unknown>;
  changedBy: string;
  userId: string;
  createdAt: string;
  changeType: SchemaChangeType | null;
  version: { major: number; minor: number; patch: number } | null;
}

// Configuração de execução do LLM (projects.llm_provider / llm_model /
// llm_kwargs). Compartilhada pela orquestração `LlmConfigurePane` e pelos cards
// `ModelConfigCard`/`RunCard` — tipo único aqui evita drift ao adicionar um
// kwarg estrutural novo.
export interface LlmConfig {
  llm_provider: string;
  llm_model: string;
  llm_kwargs: Record<string, unknown>;
}
