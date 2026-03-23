export interface Profile {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
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
}

export interface PydanticField {
  name: string;
  type: "single" | "multi" | "text";
  options: string[] | null;
  description: string;
  help_text?: string;
  target?: "all" | "llm_only" | "human_only";
  required?: boolean;
  hash?: string;
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
}

export interface Assignment {
  id: string;
  project_id: string;
  document_id: string;
  user_id: string;
  status: "pendente" | "em_andamento" | "concluido";
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

export interface QuestionMeta {
  id: string;
  project_id: string;
  field_name: string;
  priority: "ALTA" | "MEDIA" | "BAIXA";
}

export interface Discussion {
  id: string;
  project_id: string;
  document_id: string | null;
  created_by: string;
  title: string;
  body: string | null;
  status: "open" | "resolved";
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface DiscussionComment {
  id: string;
  discussion_id: string;
  created_by: string;
  body: string;
  created_at: string;
}
