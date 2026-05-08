export interface Profile {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
}

export type RoundStrategy = "schema_version" | "manual";

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
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: "coordenador" | "pesquisador";
  profiles?: Profile;
}

export interface Document {
  id: string;
  project_id: string;
  external_id: string | null;
  title: string | null;
  text: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  excluded_at: string | null;
  excluded_reason: string | null;
  excluded_by: string | null;
}

export interface Assignment {
  id: string;
  project_id: string;
  document_id: string;
  user_id: string;
  status: "pendente" | "em_andamento" | "concluido";
  type: "codificacao" | "comparacao";
  batch_id: string | null;
  deadline: string | null;
  completed_at: string | null;
}

export interface AssignmentBatch {
  id: string;
  project_id: string;
  created_by: string;
  created_at: string;
  researchers_per_doc: number;
  docs_per_researcher: number | null;
  doc_subset_size: number | null;
  deadline_mode: "none" | "batch" | "recurring";
  deadline_date: string | null;
  recurring_count: number | null;
  recurring_start: string | null;
  label: string | null;
}

export interface Response {
  id: string;
  project_id: string;
  document_id: string;
  respondent_id: string | null;
  respondent_type: "humano" | "llm";
  respondent_name: string | null;
  answers: Record<string, unknown>;
  justifications: Record<string, string> | null;
  is_current: boolean;
  pydantic_hash: string | null;
  answer_field_hashes: Record<string, string> | null;
  created_at: string;
}

export interface Review {
  id: string;
  project_id: string;
  document_id: string;
  field_name: string;
  reviewer_id: string | null;
  verdict: string;
  chosen_response_id: string | null;
  comment: string | null;
  created_at: string;
}

export interface ResponseEquivalence {
  id: string;
  project_id: string;
  document_id: string;
  field_name: string;
  response_a_id: string;
  response_b_id: string;
  reviewer_id: string | null;
  created_at: string;
}

export interface QuestionMeta {
  id: string;
  project_id: string;
  field_name: string;
  priority: "ALTA" | "MEDIA" | "BAIXA";
}

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
