import type {
  ConditionScalar,
  FieldCondition,
  PydanticField,
} from "@/lib/types";

// ---------- Geração de código Pydantic (pure, client-safe) ----------

function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function subfieldClassName(fieldName: string): string {
  return `_${fieldName}_fields`;
}

function baseAnnotation(field: PydanticField): string {
  if (field.type === "single" && field.options) {
    return `Literal[${field.options.map((o) => `"${escapeString(o)}"`).join(", ")}]`;
  }
  if (field.type === "multi" && field.options) {
    return `list[Literal[${field.options.map((o) => `"${escapeString(o)}"`).join(", ")}]]`;
  }
  if (field.subfields && field.subfields.length > 0) {
    return subfieldClassName(field.name);
  }
  return "str";
}

function fieldAnnotation(field: PydanticField): string {
  const base = baseAnnotation(field);
  if (field.condition) return `Optional[${base}]`;
  return base;
}

function pythonScalar(value: ConditionScalar): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";
  return `"${escapeString(value)}"`;
}

function pythonScalarList(values: ConditionScalar[]): string {
  return `[${values.map(pythonScalar).join(", ")}]`;
}

function conditionToPython(condition: FieldCondition): string {
  const parts: string[] = [`"field": "${escapeString(condition.field)}"`];
  if ("equals" in condition) {
    parts.push(`"equals": ${pythonScalar(condition.equals)}`);
  } else if ("not_equals" in condition) {
    parts.push(`"not_equals": ${pythonScalar(condition.not_equals)}`);
  } else if ("in" in condition) {
    parts.push(`"in": ${pythonScalarList(condition.in)}`);
  } else if ("not_in" in condition) {
    parts.push(`"not_in": ${pythonScalarList(condition.not_in)}`);
  } else if ("exists" in condition) {
    parts.push(`"exists": ${condition.exists ? "True" : "False"}`);
  }
  return `{${parts.join(", ")}}`;
}

function fieldExtra(field: PydanticField): string {
  const extras: string[] = [];
  if (field.target && field.target !== "all") {
    extras.push(`"target": "${field.target}"`);
  }
  if (field.type === "date") {
    extras.push(`"field_type": "date"`);
  }
  if ((field.type === "single" || field.type === "multi") && field.allow_other) {
    extras.push(`"allowOther": True`);
  }
  if (
    field.subfields &&
    field.subfields.length > 0 &&
    field.subfield_rule &&
    field.subfield_rule !== "all"
  ) {
    extras.push(`"subfield_rule": "${field.subfield_rule}"`);
  }
  if (field.help_text?.trim()) {
    extras.push(`"help_text": "${escapeString(field.help_text.trim())}"`);
  }
  if (field.condition) {
    extras.push(`"condition": ${conditionToPython(field.condition)}`);
  }
  if (extras.length === 0) return "";
  return `, json_schema_extra={${extras.join(", ")}}`;
}

export function generatePydanticCode(
  fields: PydanticField[],
  modelName = "Analysis"
): string {
  const lines = [
    "from pydantic import BaseModel, Field",
    "from typing import Literal, Optional",
    "",
  ];

  // Generate nested BaseModel classes for composite text fields
  for (const field of fields) {
    if (field.subfields && field.subfields.length > 0) {
      lines.push("");
      lines.push(`class ${subfieldClassName(field.name)}(BaseModel):`);
      for (const sf of field.subfields) {
        const ann = sf.required && field.subfield_rule !== "at_least_one"
          ? "str"
          : "Optional[str]";
        lines.push(
          `    ${sf.key}: ${ann} = Field(${ann === "Optional[str]" ? "default=None, " : ""}description="${escapeString(sf.label)}")`
        );
      }
    }
  }

  lines.push("");
  lines.push(`class ${modelName}(BaseModel):`);

  if (fields.length === 0) {
    lines.push("    pass");
  }

  for (const field of fields) {
    const ann = fieldAnnotation(field);
    let desc = escapeString(field.description);
    if (field.type === "date") {
      desc += ". Formato: DD/MM/AAAA (use XX para partes desconhecidas)";
    }
    if (field.help_text?.trim()) {
      desc += `. Instrucoes: ${escapeString(field.help_text.trim())}`;
    }
    const extra = fieldExtra(field);
    lines.push(
      `    ${field.name}: ${ann} = Field(description="${desc}"${extra})`
    );
  }

  return lines.join("\n") + "\n";
}

// ---------- Validação client-side ----------

const PYTHON_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function validateGUIFields(fields: PydanticField[]): string[] {
  const errors: string[] = [];

  if (fields.length === 0) {
    errors.push("Adicione pelo menos um campo.");
    return errors;
  }

  const names = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const label = `Campo ${i + 1}`;

    if (!f.name || !PYTHON_IDENTIFIER.test(f.name)) {
      errors.push(
        `${label}: nome inválido "${f.name}" (use letras minúsculas, números e _)`
      );
    }
    if (names.has(f.name)) {
      errors.push(`${label}: nome "${f.name}" duplicado`);
    }
    names.add(f.name);

    if (!f.description.trim()) {
      errors.push(`${label}: descrição não pode ser vazia`);
    }

    if (f.type === "date" && f.options && f.options.length > 0) {
      errors.push(`${label}: campo de data não deve ter opções`);
    }

    if (f.subfields && f.subfields.length > 0) {
      const sfKeys = new Set<string>();
      for (let j = 0; j < f.subfields.length; j++) {
        const sf = f.subfields[j];
        if (!sf.key || !PYTHON_IDENTIFIER.test(sf.key)) {
          errors.push(
            `${label}: subcampo ${j + 1} tem chave inválida "${sf.key}"`
          );
        }
        if (sfKeys.has(sf.key)) {
          errors.push(`${label}: subcampo "${sf.key}" duplicado`);
        }
        sfKeys.add(sf.key);
        if (!sf.label.trim()) {
          errors.push(`${label}: subcampo ${j + 1} tem label vazio`);
        }
      }
    }

    if (
      (f.type === "single" || f.type === "multi") &&
      (!f.options || f.options.length === 0)
    ) {
      errors.push(
        `${label}: campo de escolha precisa de pelo menos uma opção`
      );
    }

    if (f.options) {
      for (let j = 0; j < f.options.length; j++) {
        if (!f.options[j].trim()) {
          errors.push(`${label}: opção ${j + 1} está vazia`);
        }
      }
    }

    if (f.condition) {
      const trigger = f.condition.field;
      if (!trigger) {
        errors.push(`${label}: condição sem campo gatilho`);
      } else if (trigger === f.name) {
        errors.push(`${label}: condição não pode referenciar o próprio campo`);
      } else {
        const earlier = fields.slice(0, i);
        const triggerField = earlier.find((g) => g.name === trigger);
        if (!triggerField) {
          errors.push(
            `${label}: campo gatilho "${trigger}" inexistente ou posterior ao campo condicional`,
          );
        } else if ("equals" in f.condition || "not_equals" in f.condition) {
          const val =
            "equals" in f.condition
              ? f.condition.equals
              : f.condition.not_equals;
          if (
            triggerField.options &&
            typeof val === "string" &&
            !triggerField.options.includes(val)
          ) {
            errors.push(
              `${label}: valor "${val}" não está nas opções de "${trigger}"`,
            );
          }
        } else if ("in" in f.condition || "not_in" in f.condition) {
          const vals =
            "in" in f.condition ? f.condition.in : f.condition.not_in;
          if (!Array.isArray(vals) || vals.length === 0) {
            errors.push(`${label}: lista de valores da condição vazia`);
          } else if (triggerField.options) {
            for (const v of vals) {
              if (typeof v === "string" && !triggerField.options.includes(v)) {
                errors.push(
                  `${label}: valor "${v}" não está nas opções de "${trigger}"`,
                );
              }
            }
          }
        }
      }
    }
  }

  return errors;
}
