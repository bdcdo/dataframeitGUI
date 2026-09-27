import type { FieldChangeLogRow } from "@/lib/field-hash-universe";

// As três entradas do schema_change_log de produção para o campo `resultado`
// do projeto "PIBIC - Tráfico | Parte 2", lidas em 26/09/2026 e copiadas sem
// `changed_by` nem `project_id`. A versão com quatro opções existiu de 23:04:13
// a 23:10:31 de 07/09 e só aparece aqui como lado parcial, e uma resposta
// gravada nesse intervalo carrega o hash dela.
export const RESULTADO_INTERMEDIATE_HASH = "a18bc76d2852";

const THREE_OPTIONS = ["Condenação do réu", "Absolvição do réu", "Não é possível avaliar"];
const FOUR_OPTIONS = [
  "Condenação do réu",
  "Absolvição do réu",
  "O pedido foi apenas redução de pena",
  "Não é possível avaliar",
];

export const resultadoProductionLog: FieldChangeLogRow[] = [
  {
    id: "443b9e27-875a-4300-a011-09dbcc0298dc",
    field_name: "resultado",
    created_at: "2026-08-30T21:13:26.794978+00:00",
    before_value: {},
    after_value: {
      name: "resultado",
      type: "multi",
      target: "human_only",
      options: THREE_OPTIONS,
      required: true,
      condition: null,
      help_text: null,
      subfields: null,
      allow_other: false,
      description: "Qual foi o resultado do julgamento?",
      subfield_rule: "all",
      justification_prompt: null,
    },
  },
  {
    id: "a904569c-92e1-42e4-9ff9-ed3f058be4fb",
    field_name: "resultado",
    created_at: "2026-09-07T23:04:13.824027+00:00",
    before_value: { options: THREE_OPTIONS },
    after_value: { options: FOUR_OPTIONS },
  },
  {
    id: "6e378baf-b3e1-42a6-b91c-ab83182bb388",
    field_name: "resultado",
    created_at: "2026-09-07T23:10:31.771783+00:00",
    before_value: { options: FOUR_OPTIONS },
    after_value: { options: THREE_OPTIONS },
  },
];
