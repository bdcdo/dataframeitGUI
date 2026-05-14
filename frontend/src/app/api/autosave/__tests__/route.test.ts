import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveResponse } from "@/actions/responses";

vi.mock("@/actions/responses", () => ({
  saveResponse: vi.fn(async () => ({ success: true })),
}));

async function loadPOST() {
  return (await import("@/app/api/autosave/route")).POST;
}

function makeRequest(
  body: unknown,
  {
    origin = "https://app.test",
    host = "app.test",
    rawBody,
  }: { origin?: string | null; host?: string | null; rawBody?: string } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (origin !== null) headers.set("origin", origin);
  if (host !== null) headers.set("host", host);
  return new Request("https://app.test/api/autosave", {
    method: "POST",
    headers,
    body: rawBody ?? JSON.stringify(body),
  });
}

const validBody = {
  projectId: "proj-1",
  documentId: "doc-1",
  answers: { q1: "a" },
  notes: "comentario",
};

beforeEach(() => {
  vi.mocked(saveResponse).mockClear();
  vi.mocked(saveResponse).mockResolvedValue({ success: true });
});

describe("POST /api/autosave — validacao de origem", () => {
  it("rejeita request sem header Origin com 403", async () => {
    const POST = await loadPOST();
    const res = await POST(makeRequest(validBody, { origin: null }));
    expect(res.status).toBe(403);
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it("rejeita Origin que nao bate com Host com 403", async () => {
    const POST = await loadPOST();
    const res = await POST(
      makeRequest(validBody, { origin: "https://evil.test" }),
    );
    expect(res.status).toBe(403);
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it("aceita Origin same-origin", async () => {
    const POST = await loadPOST();
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/autosave — validacao de body", () => {
  it("rejeita JSON invalido com 400", async () => {
    const POST = await loadPOST();
    const res = await POST(makeRequest(null, { rawBody: "{nao-e-json" }));
    expect(res.status).toBe(400);
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it("rejeita projectId/documentId ausentes com 400", async () => {
    const POST = await loadPOST();
    const res = await POST(
      makeRequest({ answers: { q1: "a" } }),
    );
    expect(res.status).toBe(400);
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it("rejeita answers nao-objeto com 400", async () => {
    const POST = await loadPOST();
    const res = await POST(
      makeRequest({ projectId: "p", documentId: "d", answers: [] }),
    );
    expect(res.status).toBe(400);
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it("rejeita notes nao-string com 400", async () => {
    const POST = await loadPOST();
    const res = await POST(
      makeRequest({
        projectId: "p",
        documentId: "d",
        answers: { q1: "a" },
        notes: 42,
      }),
    );
    expect(res.status).toBe(400);
    expect(saveResponse).not.toHaveBeenCalled();
  });
});

describe("POST /api/autosave — delegacao para saveResponse", () => {
  it("delega com isAutoSave=true e responde 200", async () => {
    const POST = await loadPOST();
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(saveResponse).toHaveBeenCalledWith(
      "proj-1",
      "doc-1",
      { q1: "a" },
      { notes: "comentario", isAutoSave: true },
    );
  });

  it("nao vaza o erro cru do saveResponse na resposta 500", async () => {
    vi.mocked(saveResponse).mockResolvedValue({
      success: false,
      error: "duplicate key value violates unique constraint",
    });
    const POST = await loadPOST();
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Falha ao salvar");
    expect(json.error).not.toContain("constraint");
  });
});
