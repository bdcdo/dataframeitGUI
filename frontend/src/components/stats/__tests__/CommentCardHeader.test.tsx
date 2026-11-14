// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { cleanup, render, screen } from "@testing-library/react";
import { CommentCardHeader } from "../CommentCardHeader";
import { TYPE_LABELS } from "../comment-card-utils";
import type { ReviewComment } from "../comment-card-utils";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    documentId: "d1",
    documentTitle: "Doc 1",
    fieldName: "q1",
    fieldDescription: "q1",
    verdict: "humano",
    comment: "texto",
    reviewerName: "Ana",
    resolvedAt: null,
    createdAt: "2026-11-14T00:00:00Z",
    chosenResponseId: null,
    source: "review",
    responseSnapshot: null,
    ...overrides,
  };
}

describe("CommentCardHeader — metadados do campo", () => {
  it("mostra tipo, ajuda e opções quando o campo os tem", () => {
    render(
      <CommentCardHeader
        comment={comment({
          fieldType: "single",
          fieldHelpText: "Leia a ementa",
          fieldOptions: ["Sim", "Não"],
        })}
      />,
    );
    expect(screen.getByText(TYPE_LABELS.single)).toBeTruthy();
    expect(screen.getByText("Leia a ementa")).toBeTruthy();
    expect(screen.getByText("Sim")).toBeTruthy();
    expect(screen.getByText("Não")).toBeTruthy();
  });

  it("omite o bloco quando não há metadado (lista de opções vazia não conta)", () => {
    const { container } = render(
      <CommentCardHeader comment={comment({ fieldOptions: [] })} />,
    );
    expect(container.querySelector(".bg-muted\\/30")).toBeNull();
  });

  it("descrição só aparece quando difere do nome", () => {
    render(<CommentCardHeader comment={comment({ fieldDescription: "q1" })} />);
    expect(screen.getAllByText("q1")).toHaveLength(1); // só o <code>
    cleanup();
    render(<CommentCardHeader comment={comment({ fieldDescription: "Pergunta um" })} />);
    expect(screen.getByText("Pergunta um")).toBeTruthy();
  });
});

describe("CommentCardHeader — editar ou sugerir o campo", () => {
  it("coordenador edita; pesquisador sugere", () => {
    const onEditField = vi.fn();
    const onSuggestField = vi.fn();
    render(
      <CommentCardHeader
        comment={comment()}
        isCoordinator
        onEditField={onEditField}
        onSuggestField={onSuggestField}
      />,
    );
    expect(screen.getByTitle("Editar campo")).toBeTruthy();
    expect(screen.queryByTitle("Sugerir alteração")).toBeNull();
    cleanup();
    render(
      <CommentCardHeader
        comment={comment()}
        onEditField={onEditField}
        onSuggestField={onSuggestField}
      />,
    );
    expect(screen.getByTitle("Sugerir alteração")).toBeTruthy();
    expect(screen.queryByTitle("Editar campo")).toBeNull();
  });

  it.each(["nota", "exclusao"] as const)("sem botão em comentário de origem %s", (source) => {
    render(
      <CommentCardHeader
        comment={comment({ source })}
        isCoordinator
        onEditField={vi.fn()}
        onSuggestField={vi.fn()}
      />,
    );
    expect(screen.queryByTitle("Editar campo")).toBeNull();
    expect(screen.queryByTitle("Sugerir alteração")).toBeNull();
  });
});
