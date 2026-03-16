import type { PydanticField } from "@/lib/types";

// ---------- Geração de código Pydantic (pure, client-safe) ----------

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function fieldAnnotation(field: PydanticField): string {
  if (field.type === "single" && field.options) {
    return `Literal[${field.options.map((o) => `"${escapeString(o)}"`).join(", ")}]`;
  }
  if (field.type === "multi" && field.options) {
    return `list[Literal[${field.options.map((o) => `"${escapeString(o)}"`).join(", ")}]]`;
  }
  return "str";
}

export function generatePydanticCode(
  fields: PydanticField[],
  modelName = "Analysis"
): string {
  const lines = [
    "from pydantic import BaseModel, Field",
    "from typing import Literal",
    "",
    "",
    `class ${modelName}(BaseModel):`,
  ];

  if (fields.length === 0) {
    lines.push("    pass");
  }

  for (const field of fields) {
    const ann = fieldAnnotation(field);
    const desc = escapeString(field.description);
    const target =
      field.target && field.target !== "all"
        ? `, json_schema_extra={"target": "${field.target}"}`
        : "";
    lines.push(
      `    ${field.name}: ${ann} = Field(description="${desc}"${target})`
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
  }

  return errors;
}
