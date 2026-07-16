// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  schemaDraftStorageKey,
  useSchemaDraft,
} from "../useSchemaDraft";
import { parseSchemaDraft, type SchemaDraftEnvelope } from "@/lib/schema-draft";
import { unresolvedSchemaConflicts } from "@/lib/schema-merge";
import type { PydanticField, SchemaSnapshot } from "@/lib/types";

const BASE_FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "Pergunta" },
];
const EDITED_FIELDS: PydanticField[] = [
  { ...BASE_FIELDS[0], description: "Pergunta editada" },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SCOPE = { projectId: "project-1", userId: "user-1" };

function renderDraft(
  version = "0.1.0",
  revision = 1,
  fields = BASE_FIELDS,
  scope = SCOPE,
) {
  return renderHook(() =>
    useSchemaDraft({
      projectId: scope.projectId,
      userId: scope.userId,
      initialFields: fields,
      currentVersion: version,
      currentRevision: revision,
    }),
  );
}

function snapshot(
  fields: PydanticField[],
  version = "0.1.1",
  revision = 2,
): SchemaSnapshot {
  return { fields, version, revision };
}

function storedDraft(): SchemaDraftEnvelope | null {
  return parseSchemaDraft(
    window.localStorage.getItem(schemaDraftStorageKey(SCOPE)),
  );
}

function flushDebounce() {
  void act(() => vi.advanceTimersByTime(300));
}

// O localStorage é do navegador, não da sessão, e nada o limpa no logout. Numa
// máquina compartilhada, um rascunho escopado só por projeto vazaria de um
// coordenador para o outro — e quem salvasse assinaria no `schema_change_log`
// uma mudança que o colega escreveu, porque `p_changed_by` vem do servidor.
describe("useSchemaDraft — isolamento entre usuários", () => {
  const OTHER = { projectId: "project-1", userId: "user-2" };

  it("o rascunho de um usuário não é recuperado por outro no mesmo projeto", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    expect(storedDraft()).not.toBeNull();

    const second = renderDraft("0.1.0", 1, BASE_FIELDS, OTHER);

    expect(second.result.current.origin).toBe("session");
    expect(second.result.current.isDirty).toBe(false);
    expect(second.result.current.fields).toEqual(BASE_FIELDS);
  });

  it("cada usuário tem sua própria chave e um não apaga o rascunho do outro", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    flushDebounce();

    const second = renderDraft("0.1.0", 1, BASE_FIELDS, OTHER);
    act(() => second.result.current.setFields(EDITED_FIELDS));
    flushDebounce();

    expect(Object.keys(window.localStorage).sort()).toEqual(
      [schemaDraftStorageKey(SCOPE), schemaDraftStorageKey(OTHER)].sort(),
    );
    expect(storedDraft()).not.toBeNull();
  });
});

describe("useSchemaDraft", () => {
  it("usa uma chave por projeto, salva com debounce e recupera o draft", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));

    expect(first.result.current.draftPersisted).toBe(false);
    expect(storedDraft()).toBeNull();
    flushDebounce();

    expect(Object.keys(window.localStorage)).toEqual([
      schemaDraftStorageKey(SCOPE),
    ]);
    expect(storedDraft()).toMatchObject({
      formatVersion: 4,
      base: { fields: BASE_FIELDS, version: "0.1.0", revision: 1 },
      fields: EDITED_FIELDS,
    });
    expect(first.result.current.draftPersisted).toBe(true);

    first.unmount();
    const second = renderDraft();
    expect(second.result.current.fields).toEqual(EDITED_FIELDS);
    expect(second.result.current.origin).toBe("recovered");
  });

  it("substitui o mesmo envelope em edições sucessivas", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    const firstToken = storedDraft()?.writeToken;

    const later = [{ ...EDITED_FIELDS[0], help_text: "Ajuda" }];
    act(() => view.result.current.setFields(later));
    flushDebounce();

    expect(Object.keys(window.localStorage)).toHaveLength(1);
    expect(storedDraft()?.writeToken).not.toBe(firstToken);
    expect(storedDraft()?.fields).toEqual(later);
  });

  it("remove o token persistido substituído ao reverter antes do debounce", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    const persistedToken = storedDraft()?.writeToken;

    act(() =>
      view.result.current.setFields([
        { ...EDITED_FIELDS[0], help_text: "ainda em memória" },
      ]),
    );
    expect(view.result.current.draftPersisted).toBe(false);
    expect(storedDraft()?.writeToken).toBe(persistedToken);

    act(() => view.result.current.setFields(BASE_FIELDS));
    expect(storedDraft()).toBeNull();

    view.unmount();
    const reloaded = renderDraft();
    expect(reloaded.result.current.fields).toEqual(BASE_FIELDS);
    expect(reloaded.result.current.origin).toBe("session");
  });

  it("faz flush em pagehide, visibilitychange e beforeunload", () => {
    const pagehide = renderDraft();
    act(() => pagehide.result.current.setFields(EDITED_FIELDS));
    void act(() => window.dispatchEvent(new Event("pagehide")));
    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
    pagehide.unmount();

    window.localStorage.clear();
    const visibility = renderDraft();
    act(() => visibility.result.current.setFields(EDITED_FIELDS));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    void act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
    visibility.unmount();

    window.localStorage.clear();
    const unload = renderDraft();
    act(() => unload.result.current.setFields(EDITED_FIELDS));
    const event = new Event("beforeunload", { cancelable: true });
    void act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
  });

  it("faz flush ao desmontar antes do fim do debounce", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));

    view.unmount();

    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
  });

  // SCHEMA_DRAFT_FORMAT_VERSION já foi bumpado 3 vezes. Durante um deploy que o
  // bumpe de novo, a aba velha convive com a nova: se ela tratar o envelope que
  // não sabe ler como "slot livre", apaga o rascunho da aba nova em silêncio.
  it("não sobrescreve rascunho de um formato mais novo que o seu", () => {
    window.localStorage.setItem(
      schemaDraftStorageKey(SCOPE),
      JSON.stringify({
        formatVersion: 99,
        writeToken: "build-mais-novo",
        algoQueAindaNaoExiste: true,
      }),
    );

    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();

    expect(
      JSON.parse(window.localStorage.getItem(schemaDraftStorageKey(SCOPE))!),
    ).toMatchObject({ formatVersion: 99, writeToken: "build-mais-novo" });
    expect(view.result.current.storageBlocked).toBe(true);
  });

  // Contrapartida: lixo e formato anterior não podem travar o rascunho para
  // sempre — ninguém mais escreve neles e não há o que preservar.
  it("assume o slot quando o conteúdo é lixo ou de formato anterior", () => {
    window.localStorage.setItem(schemaDraftStorageKey(SCOPE), "{{{ não é json");
    const lixo = renderDraft();
    act(() => lixo.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
    lixo.unmount();

    window.localStorage.setItem(
      schemaDraftStorageKey(SCOPE),
      JSON.stringify({ formatVersion: 1, writeToken: "build-antigo" }),
    );
    const antigo = renderDraft();
    act(() => antigo.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
    expect(antigo.result.current.storageBlocked).toBe(false);
  });

  it("não sobrescreve o rascunho que outra aba gravou", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const otherTab: SchemaDraftEnvelope = {
      formatVersion: 4,
      writeToken: "outra-aba",
      base: snapshot(BASE_FIELDS, "0.1.0", 1),
      fields: [{ ...BASE_FIELDS[0], help_text: "Outra aba" }],
    };
    window.localStorage.setItem(
      schemaDraftStorageKey(SCOPE),
      JSON.stringify(otherTab),
    );

    flushDebounce();

    expect(storedDraft()).toEqual(otherTab);
    expect(view.result.current.draftPersisted).toBe(false);
    expect(view.result.current.storageBlocked).toBe(true);
  });

  it("não avança persistência após falha transitória e tenta novamente na edição seguinte", () => {
    const originalSetItem = Storage.prototype.setItem;
    let fail = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (fail) {
        fail = false;
        throw new DOMException("quota", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    });
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();

    expect(view.result.current.draftPersisted).toBe(false);
    expect(view.result.current.storageAvailable).toBe(false);
    expect(storedDraft()).toBeNull();

    const later = [{ ...EDITED_FIELDS[0], help_text: "Segunda edição" }];
    act(() => view.result.current.setFields(later));
    flushDebounce();
    expect(view.result.current.draftPersisted).toBe(true);
    expect(view.result.current.storageAvailable).toBe(true);
    expect(storedDraft()?.fields).toEqual(later);
  });

  it("remove o draft quando os campos retornam ao baseline", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    act(() => view.result.current.setFields(BASE_FIELDS));

    expect(view.result.current.isDirty).toBe(false);
    expect(view.result.current.draftPersisted).toBe(false);
    expect(storedDraft()).toBeNull();
  });

  it("não apaga envelope com token mais novo ao concluir save", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const submission = view.result.current.prepareSubmission();
    const submitted = storedDraft()!;
    const newer: SchemaDraftEnvelope = {
      ...submitted,
      writeToken: "outra-aba",
      fields: [{ ...EDITED_FIELDS[0], help_text: "Outra aba" }],
    };
    window.localStorage.setItem(
      schemaDraftStorageKey(SCOPE),
      JSON.stringify(newer),
    );

    act(() => view.result.current.markSaved(snapshot(EDITED_FIELDS), submission.writeToken));
    expect(storedDraft()).toEqual(newer);
  });

  it("preserva e rebasa edição feita durante o save", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const submission = view.result.current.prepareSubmission();
    const later = [{ ...EDITED_FIELDS[0], help_text: "Durante o save" }];
    act(() => view.result.current.setFields(later));

    act(() =>
      view.result.current.markSaved(
        snapshot(submission.fields, "0.1.1", 2),
        submission.writeToken,
      ),
    );

    expect(view.result.current.fields).toEqual(later);
    expect(view.result.current.isDirty).toBe(true);
    expect(storedDraft()).toMatchObject({
      base: { fields: submission.fields, version: "0.1.1", revision: 2 },
      fields: later,
    });
  });

  it("auto-mescla conflito remoto não sobreposto e rebasa o draft", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const remoteFields = [{ ...BASE_FIELDS[0], help_text: "Ajuda remota" }];

    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(remoteFields, "0.1.1", 2),
      ),
    );

    expect(view.result.current.conflict).toBeNull();
    expect(view.result.current.fields).toEqual([
      { ...EDITED_FIELDS[0], help_text: "Ajuda remota" },
    ]);
    expect(storedDraft()?.base.revision).toBe(2);
    // Nada foi recuperado: a aba nunca foi fechada. Anunciar "rascunho
    // recuperado" aqui descreveria um evento que não aconteceu.
    expect(view.result.current.origin).toBe("rebased");
  });

  it("um rascunho recuperado do storage passa a rebasado ao mesclar revisão nova", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    first.unmount();

    const second = renderDraft();
    expect(second.result.current.origin).toBe("recovered");

    act(() =>
      second.result.current.registerRemoteConflict(
        snapshot([{ ...BASE_FIELDS[0], help_text: "Ajuda remota" }], "0.1.1", 2),
      ),
    );

    expect(second.result.current.origin).toBe("rebased");
  });

  it("exige resolução explícita antes de aplicar merge conflitante", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const remoteFields = [{ ...BASE_FIELDS[0], description: "Pergunta remota" }];
    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(remoteFields, "0.1.1", 2),
      ),
    );

    const conflictId = unresolvedSchemaConflicts(
      view.result.current.conflict!.merge,
    )[0].id;
    expect(view.result.current.fields).toEqual(remoteFields);
    expect(view.result.current.applyResolvedDraft()).toBe(false);

    act(() => view.result.current.resolveConflict(conflictId, "local"));
    expect(unresolvedSchemaConflicts(view.result.current.conflict!.merge)).toEqual([]);
    expect(view.result.current.fields).toEqual(EDITED_FIELDS);
    act(() => expect(view.result.current.applyResolvedDraft()).toBe(true));

    expect(view.result.current.conflict).toBeNull();
    expect(view.result.current.baseline).toEqual({ revision: 2 });
    expect(storedDraft()).toMatchObject({
      base: { fields: remoteFields, version: "0.1.1", revision: 2 },
      fields: EDITED_FIELDS,
    });
  });

  // Resolver tudo escolhendo "remote" deixa o merge idêntico ao remoto: não
  // sobrou intenção local nenhuma, então o rascunho deve sumir do storage em vez
  // de ficar como um "não salvo" que não difere de nada.
  it("resolver todos os conflitos a favor do remoto limpa o rascunho", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    const remoteFields = [{ ...BASE_FIELDS[0], description: "Pergunta remota" }];
    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(remoteFields, "0.1.1", 2),
      ),
    );

    const conflictId = unresolvedSchemaConflicts(
      view.result.current.conflict!.merge,
    )[0].id;
    act(() => view.result.current.resolveConflict(conflictId, "remote"));
    act(() => expect(view.result.current.applyResolvedDraft()).toBe(true));

    expect(view.result.current.conflict).toBeNull();
    expect(view.result.current.isDirty).toBe(false);
    expect(view.result.current.fields).toEqual(remoteFields);
    expect(storedDraft()).toBeNull();
  });

  it("no mount, rascunho de revisão antiga é rebasado quando não há colisão", () => {
    const first = renderDraft("0.1.0", 1);
    act(() => first.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    first.unmount();

    // A aba reabre já com uma revisão remota nova que mexeu em outra
    // propriedade — nada colide, então o rascunho é reaproveitado sobre ela.
    const remoteFields = [{ ...BASE_FIELDS[0], help_text: "Ajuda remota" }];
    const second = renderDraft("0.1.1", 2, remoteFields);

    expect(second.result.current.conflict).toBeNull();
    expect(second.result.current.origin).toBe("rebased");
    expect(second.result.current.fields).toEqual([
      { ...EDITED_FIELDS[0], help_text: "Ajuda remota" },
    ]);
    expect(second.result.current.baseline).toEqual({ revision: 2 });
    expect(storedDraft()?.base.revision).toBe(2);
  });

  it("no mount, rascunho já contemplado pela revisão remota é descartado", () => {
    const first = renderDraft("0.1.0", 1);
    act(() => first.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    first.unmount();

    // Alguém salvou remotamente exatamente a mesma edição: não há trabalho local
    // a preservar, e manter o rascunho mostraria "não salvo" sem diferença real.
    const second = renderDraft("0.1.1", 2, EDITED_FIELDS);

    expect(second.result.current.isDirty).toBe(false);
    expect(second.result.current.origin).toBe("session");
    expect(storedDraft()).toBeNull();
  });

  // O envelope é plantado direto no storage: o rascunho precisa EXISTIR e ser
  // redundante para exercitar a limpeza. Chegar aqui pela UI não serve — reverter
  // a edição já apaga o rascunho antes do unmount, e o mount cairia no ramo
  // "não há rascunho", que é outro caminho.
  it("no mount, rascunho redundante na mesma revisão é limpo do storage", () => {
    const redundante: SchemaDraftEnvelope = {
      formatVersion: 4,
      writeToken: "rascunho-redundante",
      base: snapshot(BASE_FIELDS, "0.1.0", 1),
      fields: BASE_FIELDS,
    };
    window.localStorage.setItem(
      schemaDraftStorageKey(SCOPE),
      JSON.stringify(redundante),
    );

    const view = renderDraft("0.1.0", 1, BASE_FIELDS);

    expect(view.result.current.isDirty).toBe(false);
    expect(view.result.current.origin).toBe("session");
    expect(storedDraft()).toBeNull();
  });

  it("preserva a intenção local quando chega outra revisão durante o conflito", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const remoteRevision2 = [{
      ...BASE_FIELDS[0],
      description: "Pergunta remota",
    }];
    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(remoteRevision2, "0.1.1", 2),
      ),
    );

    const remoteRevision3 = [{
      ...remoteRevision2[0],
      help_text: "Ajuda remota posterior",
    }];
    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(remoteRevision3, "0.1.2", 3),
      ),
    );

    const [conflict] = unresolvedSchemaConflicts(
      view.result.current.conflict!.merge,
    );
    act(() => view.result.current.resolveConflict(conflict.id, "local"));
    expect(view.result.current.fields).toEqual([{
      ...EDITED_FIELDS[0],
      help_text: "Ajuda remota posterior",
    }]);
  });

  it("ignora snapshot atrasado com revisão menor", () => {
    const view = renderDraft();
    const revision3 = [{ ...BASE_FIELDS[0], help_text: "Revisão 3" }];
    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(revision3, "0.1.2", 3),
      ),
    );
    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot([{ ...BASE_FIELDS[0], help_text: "Revisão 2" }], "0.1.1", 2),
      ),
    );

    expect(view.result.current.baseline).toEqual({ revision: 3 });
    expect(view.result.current.fields).toEqual(revision3);
  });

  it("recupera como conflito quando o baseline persistido ficou antigo", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    first.unmount();

    const remoteFields = [{ ...BASE_FIELDS[0], description: "Remota" }];
    const reloaded = renderDraft("0.1.1", 2, remoteFields);
    expect(reloaded.result.current.conflict).not.toBeNull();
    expect(unresolvedSchemaConflicts(reloaded.result.current.conflict!.merge)).toHaveLength(1);

    act(() => reloaded.result.current.discardConflictingDraft());
    expect(reloaded.result.current.fields).toEqual(remoteFields);
    expect(storedDraft()).toBeNull();
  });

  it("beforeunload fica inativo após save limpo", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const submission = view.result.current.prepareSubmission();
    act(() =>
      view.result.current.markSaved(snapshot(EDITED_FIELDS), submission.writeToken),
    );

    const event = new Event("beforeunload", { cancelable: true });
    void act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});
