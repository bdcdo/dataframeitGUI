import { describe, expect, it } from "vitest";
import {
  classifyNotFound,
  describeNavigation,
  readRscPayload,
  redactUrl,
  type NavigationRecord,
} from "../../../e2e/navigation-diagnostics";

// Os payloads abaixo reproduzem, encurtados, a forma dos 404 medidos no Next
// 16.3.5 em `next dev` e `next start`: a raiz da árvore de segmentos vem como
// `["",{"children":["<segmento>"`, e o `next dev` acrescenta um `pagePath` por
// segmento. No HTML, o payload chega fatiado em strings JSON dentro de
// `self.__next_f.push([1,"..."])`, às vezes com a árvore cortada entre duas.

const UNMATCHED_DEV =
  '0:{"b":"development","c":["","projects","p1","analyze","naoexiste"],"f":[[["",{"children":["/_not-found",{"children":["__PAGE__",{}]}]}],' +
  '[["$","$L7","layout",{"type":"layout","pagePath":"layout.tsx"}],["$","$L8","page",{"type":"page","pagePath":"__next_builtin__not-found.js"}]]]]}';
const UNMATCHED_PROD =
  '0:{"b":"a1b2","c":["","projects","p1","analyze","naoexiste"],"f":[[["",{"children":["/_not-found",{"children":["__PAGE__",{}]}]}]]]}';
const LAYOUT_NOT_FOUND_DEV =
  '0:{"b":"development","c":["","projects","p0","analyze","code"],"f":[[["",{"children":["(app)",{"children":["projects",{}]}]}],' +
  '[["$","$L7","layout",{"type":"layout","pagePath":"layout.tsx"}],["$","$L9","layout",{"type":"layout","pagePath":"(app)/layout.tsx"}],' +
  '["$","$La","layout",{"type":"layout","pagePath":"(app)/projects/[id]/layout.tsx"}]]]]}';

function asHtml(payload: string, splitAt?: number): string {
  const parts = splitAt === undefined ? [payload] : [payload.slice(0, splitAt), payload.slice(splitAt)];
  return (
    "<!DOCTYPE html><html><body>" +
    parts.map((p) => `<script>self.__next_f.push([1,${JSON.stringify(p)}])</script>`).join("") +
    "</body></html>"
  );
}

function record(overrides: Partial<NavigationRecord> & { body?: string }): NavigationRecord {
  const { body = "", ...rest } = overrides;
  return {
    method: "GET",
    url: "http://localhost:3100/projects/p1/analyze/code",
    status: 404,
    middlewareRewrite: "/projects/p1/analyze/code",
    clerkAuthReason: null,
    ...readRscPayload(body),
    ...rest,
  };
}

describe("readRscPayload", () => {
  it("lê a raiz da árvore e os pagePath do HTML do next dev", () => {
    expect(readRscPayload(asHtml(UNMATCHED_DEV))).toEqual({
      rootSegment: "/_not-found",
      pagePaths: ["layout.tsx", "__next_builtin__not-found.js"],
    });
  });

  it("junta as fatias antes de procurar, quando a árvore vem cortada entre duas", () => {
    const cut = UNMATCHED_DEV.indexOf('"children":["/_not-found"') + 5;
    expect(readRscPayload(asHtml(UNMATCHED_DEV, cut)).rootSegment).toBe("/_not-found");
  });

  it("lê o payload cru, sem o envelope do HTML", () => {
    expect(readRscPayload(LAYOUT_NOT_FOUND_DEV).rootSegment).toBe("(app)");
  });

  it("subárvore sem a raiz (navegação do cliente entre layouts comuns) fica sem raiz", () => {
    const partial = '0:{"b":"development","f":[["projects",{"children":[["id","p0","d"],{}]}]]}';
    expect(readRscPayload(partial).rootSegment).toBeNull();
  });

  it("devolve vazio para corpo sem payload RSC", () => {
    expect(readRscPayload("")).toEqual({ rootSegment: null, pagePaths: [] });
    expect(readRscPayload('{"error":"not found"}')).toEqual({ rootSegment: null, pagePaths: [] });
  });
});

describe("classifyNotFound", () => {
  it("rota não casada no next dev (forma do incidente: rewrite igual ao próprio path)", () => {
    expect(classifyNotFound(record({ body: asHtml(UNMATCHED_DEV) }))).toBe("rota-nao-casada");
  });

  it("rota não casada no next start, sem pagePath", () => {
    const r = record({ body: asHtml(UNMATCHED_PROD) });
    expect(r.pagePaths).toEqual([]);
    expect(classifyNotFound(r)).toBe("rota-nao-casada");
  });

  it("notFound() do layout do projeto", () => {
    expect(classifyNotFound(record({ body: asHtml(LAYOUT_NOT_FOUND_DEV) }))).toBe("notfound-do-app");
  });

  it("protect do Clerk pelo rewrite, mesmo com a página /_not-found por baixo", () => {
    for (const rewrite of ["/clerk_1792073855574", "http://localhost:3100/clerk_1792073855574"]) {
      const r = record({ body: asHtml(UNMATCHED_DEV), middlewareRewrite: rewrite });
      expect(classifyNotFound(r)).toBe("clerk-protect");
    }
  });

  it("protect do Clerk pelo header de motivo, sem rewrite", () => {
    const r = record({ body: asHtml(UNMATCHED_DEV), middlewareRewrite: null, clerkAuthReason: "protect-rewrite" });
    expect(classifyNotFound(r)).toBe("clerk-protect");
  });

  it("outro motivo do Clerk no header não é protect", () => {
    for (const reason of ["dev-browser-missing", "session-token-and-uat-missing"]) {
      const r = record({ body: asHtml(UNMATCHED_DEV), clerkAuthReason: reason });
      expect(classifyNotFound(r)).toBe("rota-nao-casada");
    }
  });

  it("não confunde segmento com clerk_ no nome com o rewrite do Clerk", () => {
    const r = record({ body: asHtml(UNMATCHED_DEV), middlewareRewrite: "/projects/clerk_2024/notas" });
    expect(classifyNotFound(r)).toBe("rota-nao-casada");
  });

  it("sem veredito fora do 404 ou sem payload", () => {
    expect(classifyNotFound(record({ status: 200, body: asHtml(UNMATCHED_DEV) }))).toBeNull();
    expect(classifyNotFound(record({ status: 500, body: asHtml(UNMATCHED_DEV) }))).toBeNull();
    expect(classifyNotFound(record({ body: "" }))).toBeNull();
  });
});

describe("redactUrl", () => {
  it("omite o valor dos parâmetros __clerk* e preserva o resto", () => {
    const url = redactUrl("http://localhost:3100/projects/p1?__clerk_handshake=eyJhbGci.x.y&tab=2&__clerk_db_jwt=dvb_1");
    expect(url).not.toContain("eyJhbGci");
    expect(url).not.toContain("dvb_1");
    expect(new URL(url).searchParams.get("tab")).toBe("2");
    expect(new URL(url).searchParams.get("__clerk_handshake")).toBe("<omitido>");
  });

  it("devolve igual a URL sem parâmetro do Clerk ou malformada", () => {
    expect(redactUrl("http://localhost:3100/a?b=1")).toBe("http://localhost:3100/a?b=1");
    expect(redactUrl("não é url")).toBe("não é url");
  });
});

describe("describeNavigation", () => {
  it("mostra método, path, status e a origem, sem acusar o fixture na rota não casada", () => {
    const line = describeNavigation(record({ body: asHtml(UNMATCHED_DEV) }));
    expect(line).toMatch(/^GET \/projects\/p1\/analyze\/code → 404 — rota não casada/);
    expect(line).toContain("Não é fixture nem reset");
  });

  it("mostra só status quando não há veredito", () => {
    expect(describeNavigation(record({ status: 500 }))).toBe("GET /projects/p1/analyze/code → 500");
  });
});
