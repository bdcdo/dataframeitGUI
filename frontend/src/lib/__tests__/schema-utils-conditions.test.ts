import { describe, it, expect } from "vitest";
import {
  findConditionConflicts,
  stripOptionFromConditions,
  validateGUIFields,
} from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

const baseField = (over: Partial<PydanticField>): PydanticField => ({
  name: "x",
  type: "single",
  description: "x",
  options: null,
  ...over,
});

describe("findConditionConflicts", () => {
  it("returns empty when no field references the option", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A", "B"] }),
      baseField({ name: "q2", type: "text" }),
    ];
    expect(findConditionConflicts(fields, "q1", "A")).toEqual([]);
  });

  it("flags equals match", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A", "B"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", equals: "A" },
      }),
    ];
    const c = findConditionConflicts(fields, "q1", "A");
    expect(c).toEqual([
      { fieldName: "q2", fieldLabel: "Campo 2", conditionKey: "equals" },
    ]);
  });

  it("flags in match and skips unrelated", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A", "B", "C"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", in: ["A", "B"] },
      }),
      baseField({
        name: "q3",
        type: "text",
        condition: { field: "q1", in: ["C"] },
      }),
    ];
    expect(findConditionConflicts(fields, "q1", "A")).toEqual([
      { fieldName: "q2", fieldLabel: "Campo 2", conditionKey: "in" },
    ]);
  });

  it("ignores conditions that target a different trigger field", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({ name: "q2", options: ["A"] }),
      baseField({
        name: "q3",
        type: "text",
        condition: { field: "q2", equals: "A" },
      }),
    ];
    expect(findConditionConflicts(fields, "q1", "A")).toEqual([]);
  });
});

describe("stripOptionFromConditions", () => {
  it("filters value from in list", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A", "B"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", in: ["A", "B"] },
      }),
    ];
    const next = stripOptionFromConditions(fields, "q1", "A");
    expect(next[1].condition).toEqual({ field: "q1", in: ["B"] });
  });

  it("removes the entire condition when in becomes empty", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", in: ["A"] },
      }),
    ];
    const next = stripOptionFromConditions(fields, "q1", "A");
    expect(next[1].condition).toBeUndefined();
  });

  it("removes the entire condition on equals match", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", equals: "A" },
      }),
    ];
    const next = stripOptionFromConditions(fields, "q1", "A");
    expect(next[1].condition).toBeUndefined();
  });

  it("does not touch unrelated conditions", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "other", equals: "A" },
      }),
    ];
    const next = stripOptionFromConditions(fields, "q1", "A");
    expect(next[1].condition).toEqual({ field: "other", equals: "A" });
  });
});

describe("after strip, validateGUIFields should pass", () => {
  it("reproduces the Zolgensma scenario then fixes it", () => {
    // q25 sem "NatJus aponta incerteza", q26 com condition que referencia.
    const fields: PydanticField[] = [
      baseField({
        name: "q25",
        options: ["Sim", "Sim, com ressalvas"],
        description: "q25",
      }),
      baseField({
        name: "q26",
        type: "text",
        description: "q26",
        condition: {
          field: "q25",
          in: ["Sim, com ressalvas", "NatJus aponta incerteza"],
        },
      }),
    ];
    expect(validateGUIFields(fields)).toContain(
      'Campo 2: valor "NatJus aponta incerteza" não está nas opções de "q25"',
    );

    const fixed = stripOptionFromConditions(fields, "q25", "NatJus aponta incerteza");
    expect(validateGUIFields(fixed)).toEqual([]);
  });
});
