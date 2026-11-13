import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "@/lib/download-blob";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadBlob", () => {
  it("clica num link com o nome do arquivo e libera a URL depois", () => {
    const calls: string[] = [];
    const anchor = {
      href: "",
      download: "",
      click: () => calls.push(`click:${anchor.href}:${anchor.download}`),
    };
    vi.stubGlobal("document", { createElement: (tag: string) => (tag === "a" ? anchor : null) });
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:1",
      revokeObjectURL: (url: string) => calls.push(`revoke:${url}`),
    });

    downloadBlob(new Blob(["x"]), "planilha.xlsx");

    expect(calls).toEqual(["click:blob:1:planilha.xlsx", "revoke:blob:1"]);
  });
});
