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
  fieldType: "single" | "multi" | "text";
  verdict: string;
  respondentAnswers: RespondentAnswer[];
}

export interface ReviewedDocument {
  documentId: string;
  documentTitle: string;
  fields: ReviewedField[];
}

export interface ConfusionDataSingle {
  type: "single";
  fieldName: string;
  fieldDescription: string;
  options: string[];
  matrix: Record<string, Record<string, number>>;
  total: number;
}

export interface ConfusionDataMulti {
  type: "multi";
  fieldName: string;
  fieldDescription: string;
  options: {
    option: string;
    correct: number;
    total: number;
    accuracy: number;
  }[];
}

export type ConfusionData = ConfusionDataSingle | ConfusionDataMulti;

export interface RespondentProfileData {
  respondentKey: string;
  respondentName: string;
  respondentType: "humano" | "llm";
  overallCorrect: number;
  overallTotal: number;
  overallAccuracy: number;
  perField: Record<
    string,
    { correct: number; total: number; accuracy: number }
  >;
  mostErroredFields: {
    fieldName: string;
    fieldDescription: string;
    errorRate: number;
  }[];
}

export interface HardestDocumentData {
  documentId: string;
  documentTitle: string;
  totalFieldsReviewed: number;
  totalErrors: number;
  errorRate: number;
}
