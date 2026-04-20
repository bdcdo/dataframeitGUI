export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      assignment_batches: {
        Row: {
          created_at: string | null
          created_by: string | null
          deadline_date: string | null
          deadline_mode: string | null
          doc_subset_size: number | null
          docs_per_researcher: number | null
          id: string
          label: string | null
          project_id: string | null
          recurring_count: number | null
          recurring_start: string | null
          researchers_per_doc: number
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          deadline_date?: string | null
          deadline_mode?: string | null
          doc_subset_size?: number | null
          docs_per_researcher?: number | null
          id?: string
          label?: string | null
          project_id?: string | null
          recurring_count?: number | null
          recurring_start?: string | null
          researchers_per_doc?: number
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          deadline_date?: string | null
          deadline_mode?: string | null
          doc_subset_size?: number | null
          docs_per_researcher?: number | null
          id?: string
          label?: string | null
          project_id?: string | null
          recurring_count?: number | null
          recurring_start?: string | null
          researchers_per_doc?: number
        }
        Relationships: [
          {
            foreignKeyName: "assignment_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_batches_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      assignments: {
        Row: {
          batch_id: string | null
          completed_at: string | null
          deadline: string | null
          document_id: string | null
          id: string
          project_id: string | null
          status: string | null
          type: string
          user_id: string | null
        }
        Insert: {
          batch_id?: string | null
          completed_at?: string | null
          deadline?: string | null
          document_id?: string | null
          id?: string
          project_id?: string | null
          status?: string | null
          type?: string
          user_id?: string | null
        }
        Update: {
          batch_id?: string | null
          completed_at?: string | null
          deadline?: string | null
          document_id?: string | null
          id?: string
          project_id?: string | null
          status?: string | null
          type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assignments_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "assignment_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clerk_user_mapping: {
        Row: {
          clerk_user_id: string
          created_at: string | null
          supabase_user_id: string
        }
        Insert: {
          clerk_user_id: string
          created_at?: string | null
          supabase_user_id: string
        }
        Update: {
          clerk_user_id?: string
          created_at?: string | null
          supabase_user_id?: string
        }
        Relationships: []
      }
      difficulty_resolutions: {
        Row: {
          document_id: string
          id: string
          note: string | null
          project_id: string
          resolved_at: string
          resolved_by: string
          response_id: string
        }
        Insert: {
          document_id: string
          id?: string
          note?: string | null
          project_id: string
          resolved_at?: string
          resolved_by: string
          response_id: string
        }
        Update: {
          document_id?: string
          id?: string
          note?: string | null
          project_id?: string
          resolved_at?: string
          resolved_by?: string
          response_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "difficulty_resolutions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "difficulty_resolutions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "difficulty_resolutions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "difficulty_resolutions_response_id_fkey"
            columns: ["response_id"]
            isOneToOne: false
            referencedRelation: "responses"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          created_at: string | null
          external_id: string | null
          id: string
          metadata: Json | null
          project_id: string | null
          text: string
          text_hash: string | null
          title: string | null
        }
        Insert: {
          created_at?: string | null
          external_id?: string | null
          id?: string
          metadata?: Json | null
          project_id?: string | null
          text: string
          text_hash?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string | null
          external_id?: string | null
          id?: string
          metadata?: Json | null
          project_id?: string | null
          text?: string
          text_hash?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      error_resolutions: {
        Row: {
          document_id: string
          field_name: string
          id: string
          note: string | null
          project_id: string
          resolved_at: string
          resolved_by: string
        }
        Insert: {
          document_id: string
          field_name: string
          id?: string
          note?: string | null
          project_id: string
          resolved_at?: string
          resolved_by: string
        }
        Update: {
          document_id?: string
          field_name?: string
          id?: string
          note?: string | null
          project_id?: string
          resolved_at?: string
          resolved_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "error_resolutions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "error_resolutions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "error_resolutions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      master_users: {
        Row: {
          user_id: string
        }
        Insert: {
          user_id: string
        }
        Update: {
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string | null
          email: string
          first_name: string | null
          id: string
          last_name: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          first_name?: string | null
          id: string
          last_name?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
        }
        Relationships: []
      }
      project_comments: {
        Row: {
          author_id: string
          body: string
          created_at: string | null
          document_id: string | null
          field_name: string | null
          id: string
          parent_id: string | null
          project_id: string
          resolved_at: string | null
          resolved_by: string | null
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string | null
          document_id?: string | null
          field_name?: string | null
          id?: string
          parent_id?: string | null
          project_id: string
          resolved_at?: string | null
          resolved_by?: string | null
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string | null
          document_id?: string | null
          field_name?: string | null
          id?: string
          parent_id?: string | null
          project_id?: string
          resolved_at?: string | null
          resolved_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_comments_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "project_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_comments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_comments_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_members: {
        Row: {
          id: string
          project_id: string | null
          role: string
          user_id: string | null
        }
        Insert: {
          id?: string
          project_id?: string | null
          role: string
          user_id?: string | null
        }
        Update: {
          id?: string
          project_id?: string | null
          role?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          allow_researcher_review: boolean | null
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string
          llm_kwargs: Json | null
          llm_model: string | null
          llm_provider: string | null
          min_responses_for_comparison: number | null
          name: string
          prompt_template: string | null
          pydantic_code: string | null
          pydantic_fields: Json | null
          pydantic_hash: string | null
          resolution_rule: string | null
          schema_version_major: number
          schema_version_minor: number
          schema_version_patch: number
        }
        Insert: {
          allow_researcher_review?: boolean | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          llm_kwargs?: Json | null
          llm_model?: string | null
          llm_provider?: string | null
          min_responses_for_comparison?: number | null
          name: string
          prompt_template?: string | null
          pydantic_code?: string | null
          pydantic_fields?: Json | null
          pydantic_hash?: string | null
          resolution_rule?: string | null
          schema_version_major?: number
          schema_version_minor?: number
          schema_version_patch?: number
        }
        Update: {
          allow_researcher_review?: boolean | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          llm_kwargs?: Json | null
          llm_model?: string | null
          llm_provider?: string | null
          min_responses_for_comparison?: number | null
          name?: string
          prompt_template?: string | null
          pydantic_code?: string | null
          pydantic_fields?: Json | null
          pydantic_hash?: string | null
          resolution_rule?: string | null
          schema_version_major?: number
          schema_version_minor?: number
          schema_version_patch?: number
        }
        Relationships: [
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      question_meta: {
        Row: {
          field_name: string
          id: string
          priority: string | null
          project_id: string | null
        }
        Insert: {
          field_name: string
          id?: string
          priority?: string | null
          project_id?: string | null
        }
        Update: {
          field_name?: string
          id?: string
          priority?: string | null
          project_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "question_meta_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      responses: {
        Row: {
          answer_field_hashes: Json | null
          answers: Json
          created_at: string | null
          document_id: string | null
          id: string
          is_current: boolean | null
          justifications: Json | null
          project_id: string | null
          pydantic_hash: string | null
          respondent_id: string | null
          respondent_name: string | null
          respondent_type: string
          schema_version_major: number | null
          schema_version_minor: number | null
          schema_version_patch: number | null
          version_inferred_from: string | null
        }
        Insert: {
          answer_field_hashes?: Json | null
          answers: Json
          created_at?: string | null
          document_id?: string | null
          id?: string
          is_current?: boolean | null
          justifications?: Json | null
          project_id?: string | null
          pydantic_hash?: string | null
          respondent_id?: string | null
          respondent_name?: string | null
          respondent_type: string
          schema_version_major?: number | null
          schema_version_minor?: number | null
          schema_version_patch?: number | null
          version_inferred_from?: string | null
        }
        Update: {
          answer_field_hashes?: Json | null
          answers?: Json
          created_at?: string | null
          document_id?: string | null
          id?: string
          is_current?: boolean | null
          justifications?: Json | null
          project_id?: string | null
          pydantic_hash?: string | null
          respondent_id?: string | null
          respondent_name?: string | null
          respondent_type?: string
          schema_version_major?: number | null
          schema_version_minor?: number | null
          schema_version_patch?: number | null
          version_inferred_from?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "responses_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "responses_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "responses_respondent_id_fkey"
            columns: ["respondent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          chosen_response_id: string | null
          comment: string | null
          created_at: string | null
          document_id: string | null
          field_name: string
          id: string
          project_id: string | null
          resolved_at: string | null
          resolved_by: string | null
          response_snapshot: Json | null
          reviewer_id: string | null
          verdict: string
        }
        Insert: {
          chosen_response_id?: string | null
          comment?: string | null
          created_at?: string | null
          document_id?: string | null
          field_name: string
          id?: string
          project_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          response_snapshot?: Json | null
          reviewer_id?: string | null
          verdict: string
        }
        Update: {
          chosen_response_id?: string | null
          comment?: string | null
          created_at?: string | null
          document_id?: string | null
          field_name?: string
          id?: string
          project_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          response_snapshot?: Json | null
          reviewer_id?: string | null
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_chosen_response_id_fkey"
            columns: ["chosen_response_id"]
            isOneToOne: false
            referencedRelation: "responses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      schema_change_log: {
        Row: {
          after_value: Json | null
          before_value: Json | null
          change_summary: string
          change_type: string | null
          changed_by: string
          created_at: string
          field_name: string
          id: string
          project_id: string
          version_major: number | null
          version_minor: number | null
          version_patch: number | null
        }
        Insert: {
          after_value?: Json | null
          before_value?: Json | null
          change_summary: string
          change_type?: string | null
          changed_by: string
          created_at?: string
          field_name: string
          id?: string
          project_id: string
          version_major?: number | null
          version_minor?: number | null
          version_patch?: number | null
        }
        Update: {
          after_value?: Json | null
          before_value?: Json | null
          change_summary?: string
          change_type?: string | null
          changed_by?: string
          created_at?: string
          field_name?: string
          id?: string
          project_id?: string
          version_major?: number | null
          version_minor?: number | null
          version_patch?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "schema_change_log_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schema_change_log_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      schema_suggestions: {
        Row: {
          created_at: string | null
          field_name: string
          id: string
          project_id: string
          reason: string | null
          rejection_reason: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          suggested_by: string
          suggested_changes: Json
        }
        Insert: {
          created_at?: string | null
          field_name: string
          id?: string
          project_id: string
          reason?: string | null
          rejection_reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          suggested_by: string
          suggested_changes: Json
        }
        Update: {
          created_at?: string | null
          field_name?: string
          id?: string
          project_id?: string
          reason?: string | null
          rejection_reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          suggested_by?: string
          suggested_changes?: Json
        }
        Relationships: [
          {
            foreignKeyName: "schema_suggestions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schema_suggestions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schema_suggestions_suggested_by_fkey"
            columns: ["suggested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      verdict_acknowledgments: {
        Row: {
          comment: string | null
          created_at: string | null
          id: string
          respondent_id: string
          review_id: string
          status: string
        }
        Insert: {
          comment?: string | null
          created_at?: string | null
          id?: string
          respondent_id: string
          review_id: string
          status?: string
        }
        Update: {
          comment?: string | null
          created_at?: string | null
          id?: string
          respondent_id?: string
          review_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "verdict_acknowledgments_respondent_id_fkey"
            columns: ["respondent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verdict_acknowledgments_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      auth_user_coordinator_project_ids: { Args: never; Returns: string[] }
      auth_user_project_ids: { Args: never; Returns: string[] }
      clerk_uid: { Args: never; Returns: string }
      is_master: { Args: never; Returns: boolean }
      remove_answer_key: {
        Args: { p_field_name: string; p_project_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
