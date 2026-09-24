export interface RespondentAnswer {
  respondentKey: string;
  respondentName: string;
  respondentType: "humano" | "llm";
  answer: unknown;
  justification: string | null;
  isCorrect: boolean;
  isStale: boolean;
}

export interface ReviewedField {
  fieldName: string;
  fieldDescription: string;
  fieldType: "single" | "multi" | "text" | "date";
  verdict: string;
  resolutionLabel?: string;
  resolutionStatus?: "approved" | "discussion";
  respondentAnswers: RespondentAnswer[];
}

export interface ReviewedDocument {
  documentId: string;
  documentTitle: string;
  fields: ReviewedField[];
}
