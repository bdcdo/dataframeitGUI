import { describe, it, expect, beforeEach, vi } from "vitest";

// preregisterSupabaseUser (spec 002): placeholder Supabase-only. Os testes
// cobrem a idempotência — profile existente, criação nova e recuperação de
// race provada pela reconsulta do profile.
let profileRowQueue: ({ id: string; activated_at: string | null } | null)[];
let profileReadErrorQueue: ({ message: string } | null)[];
let createUserResult: {
  data: { user: { id: string } } | { user: null };
  error: { message: string } | null;
};
let mappingReadResult: {
  data: {
    supabase_user_id: string;
    access_sync_version: number;
    clerk_deleted?: boolean;
  } | null;
  error: { message: string } | null;
};
let linkRpcError: { message: string } | null;
let rpcErrorQueue: ({ message: string } | null)[];
let rpcResultQueues: Record<
  string,
  { data: unknown; error: { message: string } | null }[]
>;
let linkRpcCalls: { fn: string; args: unknown }[];
let queryCalls: {
  table: string;
  operation: string;
  filters: [string, string, unknown][];
}[];
let effectOrder: string[];
let clerkMetadataUid: string | undefined;
type TestClerkUser = {
  id: string;
  updatedAt: number;
  primaryEmailAddressId: string | null;
  emailAddresses: {
    id: string;
    emailAddress: string;
    verification: { status: "verified" | "unverified" } | null;
  }[];
  firstName: string | null;
  lastName: string | null;
  publicMetadata: { supabase_uid?: string };
};
let currentClerkUser: TestClerkUser;
let clerkUserList: TestClerkUser[];

type QueryFilter = [string, string, unknown];
type QueryResult = { data: unknown; error: { message: string } | null };

function shiftOr<T>(queue: T[], fallback: T): T {
  const value = queue.shift();
  return value === undefined ? fallback : value;
}

function profileSelectResult(): QueryResult {
  return {
    data: shiftOr(profileRowQueue, null),
    error: shiftOr(profileReadErrorQueue, null),
  };
}

function queryResult(table: string, operation: string): QueryResult {
  const handlers: Record<string, () => QueryResult> = {
    "clerk_user_mapping:select": () => mappingReadResult,
    "profiles:select": profileSelectResult,
  };
  const handler = handlers[`${table}:${operation}`];
  return handler ? handler() : { data: null, error: null };
}

function expectSnapshotAttemptWithoutMetadataPublication() {
  expect(linkRpcCalls.map(({ fn }) => fn)).toEqual([
    "begin_clerk_access_snapshot",
    "complete_clerk_access_snapshot",
  ]);
  expect(updateUserMetadataSpy).not.toHaveBeenCalled();
}

const createUserSpy = vi.fn(async () => createUserResult);
const updateUserMetadataSpy = vi.fn(
  async (
    _clerkUserId: string,
    metadata: { publicMetadata: { supabase_uid: string } },
  ) => {
    effectOrder.push("clerk:metadata");
    clerkMetadataUid = metadata.publicMetadata.supabase_uid;
    return {};
  },
);
const getUserSpy = vi.fn(async () => currentClerkUser);
const getUserListSpy = vi.fn(async () => ({
  data: clerkUserList,
  totalCount: clerkUserList.length,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      let operation = "select";
      const filters: QueryFilter[] = [];
      builder.select = () => builder;
      builder.update = () => {
        operation = "update";
        return builder;
      };
      for (const writeOperation of ["insert", "delete"]) {
        builder[writeOperation] = () => {
          operation = writeOperation;
          return builder;
        };
      }
      builder.upsert = () => {
        operation = "upsert";
        return builder;
      };
      for (const method of ["eq", "is", "in"]) {
        builder[method] = (column: string, value: unknown) => {
          filters.push([method, column, value]);
          return builder;
        };
      }
      for (const method of ["single", "maybeSingle"]) {
        builder[method] = () => builder;
      }
      builder.then = (resolve: (v: unknown) => unknown) => {
        queryCalls.push({ table, operation, filters });
        effectOrder.push(`${table}:${operation}`);
        return resolve(queryResult(table, operation));
      };
      return builder;
    },
    rpc: async (fn: string, args: unknown) => {
      linkRpcCalls.push({ fn, args });
      effectOrder.push(`rpc:${fn}`);
      const queued = rpcResultQueues[fn]?.shift();
      if (queued) return queued;
      const defaultData =
        fn === "begin_clerk_access_snapshot" ||
        fn === "complete_clerk_access_snapshot" ||
        fn === "complete_clerk_user_revocation"
          ? true
          : fn === "begin_clerk_user_revocation"
            ? (mappingReadResult.data?.supabase_user_id ?? null)
            : null;
      return {
        data: defaultData,
        error: rpcErrorQueue.length > 0 ? rpcErrorQueue.shift() : linkRpcError,
      };
    },
    auth: {
      admin: {
        createUser: createUserSpy,
      },
    },
  }),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: {
      getUser: getUserSpy,
      getUserList: getUserListSpy,
      updateUserMetadata: updateUserMetadataSpy,
    },
  }),
}));

vi.mock("@clerk/nextjs/errors", () => ({
  isClerkAPIResponseError: (error: unknown) =>
    typeof error === "object" && error !== null && "status" in error,
}));

beforeEach(() => {
  profileRowQueue = [];
  profileReadErrorQueue = [];
  createUserResult = {
    data: { user: { id: "newUid" } },
    error: null,
  };
  mappingReadResult = { data: null, error: null };
  linkRpcError = null;
  rpcErrorQueue = [];
  rpcResultQueues = {};
  linkRpcCalls = [];
  queryCalls = [];
  effectOrder = [];
  clerkMetadataUid = undefined;
  currentClerkUser = makeClerkUser();
  clerkUserList = [];
  createUserSpy.mockClear();
  getUserSpy.mockClear();
  getUserListSpy.mockClear();
  updateUserMetadataSpy.mockClear();
});

async function loadPreregister() {
  return (await import("@/lib/clerk-sync")).preregisterSupabaseUser;
}

async function loadClerkSync() {
  return await import("@/lib/clerk-sync");
}

function makeClerkUser(
  overrides: Partial<{
    clerkUserId: string;
    primaryEmail: string;
    verifiedEmails: readonly string[];
    firstName: string | null;
    lastName: string | null;
    observedSupabaseUid: string | null;
    updatedAt: number;
  }> = {},
): TestClerkUser {
  const primaryEmail = overrides.primaryEmail ?? "ana@exemplo.com";
  const verifiedEmails = overrides.verifiedEmails ?? [primaryEmail];
  const emails = Array.from(new Set([primaryEmail, ...verifiedEmails]));
  return {
    id: overrides.clerkUserId ?? "clerk_1",
    updatedAt: overrides.updatedAt ?? 100,
    primaryEmailAddressId: "email_primary",
    emailAddresses: emails.map((email, index) => ({
      id: index === 0 ? "email_primary" : `email_${index}`,
      emailAddress: email,
      verification: { status: "verified" as const },
    })),
    firstName: overrides.firstName ?? null,
    lastName: overrides.lastName ?? null,
    publicMetadata: overrides.observedSupabaseUid
      ? { supabase_uid: overrides.observedSupabaseUid }
      : {},
  };
}

function reconciliationInput(
  overrides: Parameters<typeof makeClerkUser>[0] = {},
): string {
  currentClerkUser = makeClerkUser(overrides);
  return currentClerkUser.id;
}

describe("preregisterSupabaseUser", () => {
  it("e-mail sem conta → cria auth.users com email_confirm e retorna o id", async () => {
    const preregister = await loadPreregister();
    const uid = await preregister("novo@exemplo.com");
    expect(uid).toBe("newUid");
    expect(createUserSpy).toHaveBeenCalledWith({
      email: "novo@exemplo.com",
      email_confirm: true,
    });
  });

  it("idempotente: profile já existe → retorna o id atual sem createUser", async () => {
    profileRowQueue = [{ id: "existingUid", activated_at: null }];
    const preregister = await loadPreregister();
    const uid = await preregister("ja-existe@exemplo.com");
    expect(uid).toBe("existingUid");
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it("profile pendente já mapeado não pode ser reutilizado como pré-registro", async () => {
    profileRowQueue = [{ id: "claimedUid", activated_at: null }];
    mappingReadResult.data = {
      supabase_user_id: "claimedUid",
      access_sync_version: 0,
    };
    const preregister = await loadPreregister();

    await expect(preregister("reclamado@exemplo.com")).rejects.toThrow(
      "Este pré-registro já pertence a uma conta Clerk",
    );
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it("race entre pré-registros: createUser falha e a reconsulta do profile resolve", async () => {
    profileRowQueue = [null, { id: "racedUid", activated_at: null }];
    createUserResult = {
      data: { user: null },
      error: { message: "email already registered" },
    };
    const preregister = await loadPreregister();
    const uid = await preregister("corrida@exemplo.com");
    expect(uid).toBe("racedUid");
  });

  it("createUser falha e a reconsulta continua vazia → falha explicitamente", async () => {
    createUserResult = {
      data: { user: null },
      error: { message: "kaboom" },
    };
    const preregister = await loadPreregister();
    await expect(preregister("falha@exemplo.com")).rejects.toThrow(
      "Erro ao criar usuário Supabase: kaboom",
    );
  });

  it("profile ativo não pode voltar a ser pré-registro", async () => {
    profileRowQueue = [
      { id: "activeUid", activated_at: "2026-07-15T00:00:00Z" },
    ];
    const preregister = await loadPreregister();

    await expect(preregister("ativo@exemplo.com")).rejects.toThrow(
      "Este e-mail já pertence a uma conta ativa",
    );
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it("propaga erro da consulta inicial sem tentar criar usuário", async () => {
    profileReadErrorQueue = [{ message: "profiles unavailable" }];
    const preregister = await loadPreregister();

    await expect(preregister("falha@exemplo.com")).rejects.toThrow(
      "Erro ao consultar profile: profiles unavailable",
    );
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it("propaga erro da reconsulta feita depois da falha de criação", async () => {
    profileReadErrorQueue = [null, { message: "profiles unavailable" }];
    createUserResult = {
      data: { user: null },
      error: { message: "kaboom" },
    };
    const preregister = await loadPreregister();

    await expect(preregister("falha@exemplo.com")).rejects.toThrow(
      "Erro ao reconsultar profile: profiles unavailable",
    );
  });
});

describe("reconcileClerkUserAccess (mapping Clerk-Supabase)", () => {
  it("mapping existente repara metadata ausente antes de retornar", async () => {
    mappingReadResult.data = {
      supabase_user_id: "canonicalUid",
      access_sync_version: 1,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    const uid = await reconcileClerkUserAccess(reconciliationInput());

    expect(uid).toBe("canonicalUid");
    expect(clerkMetadataUid).toBe("canonicalUid");
    expect(updateUserMetadataSpy).toHaveBeenCalledWith("clerk_1", {
      publicMetadata: { supabase_uid: "canonicalUid" },
    });
  });

  it("mapping existente substitui metadata divergente pelo UUID canônico", async () => {
    mappingReadResult.data = {
      supabase_user_id: "canonicalUid",
      access_sync_version: 1,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    const uid = await reconcileClerkUserAccess(
      reconciliationInput({ observedSupabaseUid: "staleUid" }),
    );

    expect(uid).toBe("canonicalUid");
    expect(clerkMetadataUid).toBe("canonicalUid");
  });

  it("user.updated causado pela metadata reconcilia localmente sem reescrever metadata", async () => {
    mappingReadResult.data = {
      supabase_user_id: "canonicalUid",
      access_sync_version: 1,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await reconcileClerkUserAccess(
      reconciliationInput({ observedSupabaseUid: "canonicalUid" }),
    );

    expectSnapshotAttemptWithoutMetadataPublication();
  });

  it("user.updated atrasado após exclusão não reabre o ciclo de reconciliação", async () => {
    // O Svix não garante ordem: um user.updated enfileirado antes do
    // user.deleted ainda chega depois. Sem o corte, o snapshot seria recusado
    // pela guarda de conta excluída, as duas tentativas voltariam "superseded"
    // e o webhook responderia 500 em retry para um evento que é no-op.
    mappingReadResult.data = {
      supabase_user_id: "canonicalUid",
      access_sync_version: 0,
      clerk_deleted: true,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    const uid = await reconcileClerkUserAccess(
      reconciliationInput({ observedSupabaseUid: "canonicalUid" }),
    );

    expect(uid).toBeNull();
    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
    expect(effectOrder).toEqual(["clerk_user_mapping:select"]);
  });

  it("mapping legado versão 0 só conclui depois dos efeitos Supabase", async () => {
    mappingReadResult.data = {
      supabase_user_id: "canonicalUid",
      access_sync_version: 0,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await reconcileClerkUserAccess(
      reconciliationInput({ observedSupabaseUid: "canonicalUid" }),
    );

    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
    expect(effectOrder).toEqual([
      "clerk_user_mapping:select",
      "rpc:begin_clerk_access_snapshot",
      "rpc:complete_clerk_access_snapshot",
    ]);
  });

  it("snapshot superseded é relido e só a geração atual chega à conclusão", async () => {
    mappingReadResult.data = {
      supabase_user_id: "canonicalUid",
      access_sync_version: 1,
    };
    getUserSpy
      .mockResolvedValueOnce(
        makeClerkUser({
          updatedAt: 100,
          verifiedEmails: ["old@example.com"],
          observedSupabaseUid: "canonicalUid",
        }),
      )
      .mockResolvedValueOnce(
        makeClerkUser({
          updatedAt: 200,
          verifiedEmails: ["new@example.com"],
          observedSupabaseUid: "canonicalUid",
        }),
      );
    rpcResultQueues.begin_clerk_access_snapshot = [
      { data: false, error: null },
      { data: true, error: null },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(reconcileClerkUserAccess("clerk_1")).resolves.toBe(
      "canonicalUid",
    );

    expect(getUserSpy).toHaveBeenCalledTimes(2);
    expect(
      linkRpcCalls
        .filter(({ fn }) => fn === "begin_clerk_access_snapshot")
        .map(
          ({ args }) =>
            (args as { p_snapshot_version: number }).p_snapshot_version,
        ),
    ).toEqual([100, 200]);
    expect(linkRpcCalls.at(-1)).toMatchObject({
      fn: "complete_clerk_access_snapshot",
      args: {
        p_snapshot_version: 200,
        p_verified_emails: ["ana@exemplo.com", "new@example.com"],
      },
    });
  });

  it("falha na fase de conclusão nunca publica metadata", async () => {
    mappingReadResult.data = {
      supabase_user_id: "canonicalUid",
      access_sync_version: 0,
    };
    rpcResultQueues.complete_clerk_access_snapshot = [
      { data: null, error: { message: "mapping unavailable" } },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(reconciliationInput()),
    ).rejects.toThrow(
      "Erro ao concluir snapshot de acesso: mapping unavailable",
    );
    expectSnapshotAttemptWithoutMetadataPublication();
  });

  it("propaga erro técnico da leitura do mapping sem tentar reparar metadata", async () => {
    mappingReadResult.error = { message: "database unavailable" };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(reconciliationInput()),
    ).rejects.toThrow(
      "Erro ao consultar mapping Clerk-Supabase: database unavailable",
    );
    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
  });

  it("mapping ausente reclama somente o placeholder liberado pela RPC", async () => {
    rpcResultQueues.claim_clerk_supabase_identity = [
      { data: "accountUid", error: null },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(
        reconciliationInput({
          primaryEmail: "pessoa@exemplo.com",
          verifiedEmails: ["pessoa@exemplo.com"],
        }),
      ),
    ).resolves.toBe("accountUid");

    expect(linkRpcCalls[0]).toEqual({
      fn: "claim_clerk_supabase_identity",
      args: {
        p_clerk_user_id: "clerk_1",
        p_email: "pessoa@exemplo.com",
      },
    });
    expect(createUserSpy).not.toHaveBeenCalled();
    expect(
      queryCalls.some(
        ({ table, operation }) =>
          table === "clerk_user_mapping" &&
          (operation === "delete" || operation === "insert"),
      ),
    ).toBe(false);
    expect(effectOrder.at(-1)).toBe("clerk:metadata");
  });

  it("profile ativo mapeado para Clerk A não pode ser tomado pelo Clerk B", async () => {
    rpcResultQueues.claim_clerk_supabase_identity = [
      {
        data: null,
        error: { message: "profile ativo pertence a outra identidade Clerk" },
      },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(
        reconciliationInput({
          clerkUserId: "clerk_b",
          primaryEmail: "pessoa@exemplo.com",
          verifiedEmails: ["pessoa@exemplo.com"],
        }),
      ),
    ).rejects.toThrow(
      "Erro ao vincular identidade Clerk: profile ativo pertence a outra identidade Clerk",
    );
    expect(createUserSpy).not.toHaveBeenCalled();
    expect(
      linkRpcCalls.some(({ fn }) => fn === "begin_clerk_access_snapshot"),
    ).toBe(false);
    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
  });

  it("profile ausente é criado e depois reclamado pela mesma RPC", async () => {
    rpcResultQueues.claim_clerk_supabase_identity = [
      { data: null, error: null },
      { data: "newUid", error: null },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(
        reconciliationInput({
          primaryEmail: "nova@exemplo.com",
          verifiedEmails: ["nova@exemplo.com"],
        }),
      ),
    ).resolves.toBe("newUid");

    expect(createUserSpy).toHaveBeenCalledWith({
      email: "nova@exemplo.com",
      email_confirm: true,
    });
    expect(
      linkRpcCalls.filter(({ fn }) => fn === "claim_clerk_supabase_identity"),
    ).toHaveLength(2);
  });

  it("corrida de createUser só converge quando a RPC prova o placeholder", async () => {
    rpcResultQueues.claim_clerk_supabase_identity = [
      { data: null, error: null },
      { data: "racedUid", error: null },
    ];
    createUserResult = {
      data: { user: null },
      error: { message: "email already registered" },
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(
        reconciliationInput({
          primaryEmail: "corrida@exemplo.com",
          verifiedEmails: ["corrida@exemplo.com"],
        }),
      ),
    ).resolves.toBe("racedUid");
  });
});

describe("reconcileClerkUserAccess", () => {
  it("erro atômico da fase local interrompe antes de publicar metadata", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    rpcResultQueues.complete_clerk_access_snapshot = [
      { data: null, error: { message: "profiles unavailable" } },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(reconciliationInput()),
    ).rejects.toThrow(
      "Erro ao concluir snapshot de acesso: profiles unavailable",
    );
    expectSnapshotAttemptWithoutMetadataPublication();
  });

  it("completeAccess recupera webhook perdido, ativa a conta real e resolve aliases pendentes", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(
        reconciliationInput({
          primaryEmail: " Pessoa@Exemplo.COM ",
          verifiedEmails: [" Pessoa@Exemplo.COM ", " Secundario@Exemplo.com "],
          firstName: "Pessoa",
        }),
      ),
    ).resolves.toBe("accountUid");

    expect(updateUserMetadataSpy).toHaveBeenCalledWith("clerk_1", {
      publicMetadata: { supabase_uid: "accountUid" },
    });
    expect(linkRpcCalls).toContainEqual({
      fn: "complete_clerk_access_snapshot",
      args: {
        p_clerk_user_id: "clerk_1",
        p_supabase_user_id: "accountUid",
        p_snapshot_version: 100,
        p_verified_emails: ["pessoa@exemplo.com", "secundario@exemplo.com"],
        p_first_name: "Pessoa",
        p_last_name: null,
        p_activate: true,
      },
    });
    expect(effectOrder.at(-1)).toBe("clerk:metadata");
  });

  it("posse verificada converge aliases e placeholders para o UID canônico", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await reconcileClerkUserAccess(
      reconciliationInput({
        verifiedEmails: ["ana@exemplo.com", "alias@exemplo.com"],
      }),
    );

    expect(linkRpcCalls).toContainEqual({
      fn: "complete_clerk_access_snapshot",
      args: {
        p_clerk_user_id: "clerk_1",
        p_supabase_user_id: "accountUid",
        p_snapshot_version: 100,
        p_verified_emails: ["ana@exemplo.com", "alias@exemplo.com"],
        p_first_name: null,
        p_last_name: null,
        p_activate: true,
      },
    });
  });

  it("delega marker e efeitos a duas transações ordenadas", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await reconcileClerkUserAccess(reconciliationInput());

    expect(linkRpcCalls).toEqual([
      {
        fn: "begin_clerk_access_snapshot",
        args: {
          p_clerk_user_id: "clerk_1",
          p_supabase_user_id: "accountUid",
          p_snapshot_version: 100,
          p_verified_emails: ["ana@exemplo.com"],
        },
      },
      {
        fn: "complete_clerk_access_snapshot",
        args: {
          p_clerk_user_id: "clerk_1",
          p_supabase_user_id: "accountUid",
          p_snapshot_version: 100,
          p_verified_emails: ["ana@exemplo.com"],
          p_first_name: null,
          p_last_name: null,
          p_activate: true,
        },
      },
    ]);
  });

  it("profile ativo e profile novo usam o mesmo contrato atômico", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(reconcileClerkUserAccess(reconciliationInput())).resolves.toBe(
      "accountUid",
    );
    expect(
      queryCalls.filter(
        ({ table, operation }) =>
          table === "profiles" && operation !== "select",
      ),
    ).toEqual([]);
    expect(linkRpcCalls.at(-1)?.fn).toBe("complete_clerk_access_snapshot");
  });

  it("RPC rejeita mapping órfão sem profile", async () => {
    mappingReadResult.data = {
      supabase_user_id: "orphanUid",
      access_sync_version: 0,
    };
    rpcResultQueues.complete_clerk_access_snapshot = [
      { data: null, error: { message: "profile Supabase inexistente" } },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(reconciliationInput()),
    ).rejects.toThrow(
      "Erro ao concluir snapshot de acesso: profile Supabase inexistente",
    );
    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "erro ao resolver vínculo interrompe e nunca publica metadata",
      accessSyncVersion: 0,
    },
    {
      label:
        "mapping concluído volta a pending antes de uma reconciliação que falha",
      accessSyncVersion: 1,
    },
  ])("$label", async ({ accessSyncVersion }) => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: accessSyncVersion,
    };
    rpcResultQueues.complete_clerk_access_snapshot = [
      { data: null, error: { message: "links unavailable" } },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(
      reconcileClerkUserAccess(reconciliationInput()),
    ).rejects.toThrow("Erro ao concluir snapshot de acesso: links unavailable");
    expectSnapshotAttemptWithoutMetadataPublication();
  });

  it("sem primário verificado revoga aliases de um mapping existente", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    currentClerkUser = {
      ...makeClerkUser(),
      emailAddresses: [
        {
          id: "email_primary",
          emailAddress: "ana@exemplo.com",
          verification: { status: "unverified" },
        },
      ],
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(reconcileClerkUserAccess("clerk_1")).resolves.toBeNull();

    expect(linkRpcCalls).toEqual([
      {
        fn: "begin_clerk_access_snapshot",
        args: {
          p_clerk_user_id: "clerk_1",
          p_supabase_user_id: "accountUid",
          p_snapshot_version: 100,
          p_verified_emails: [],
        },
      },
      {
        fn: "complete_clerk_access_snapshot",
        args: {
          p_clerk_user_id: "clerk_1",
          p_supabase_user_id: "accountUid",
          p_snapshot_version: 100,
          p_verified_emails: [],
          p_first_name: null,
          p_last_name: null,
          p_activate: false,
        },
      },
    ]);
    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
  });

  it("sem primário e sem mapping não cria identidade nem executa RPC", async () => {
    currentClerkUser = {
      ...makeClerkUser(),
      primaryEmailAddressId: null,
    };
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(reconcileClerkUserAccess("clerk_1")).resolves.toBeNull();

    expect(linkRpcCalls).toEqual([]);
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it("falha ao reler o Clerk interrompe antes de qualquer efeito local", async () => {
    getUserSpy.mockRejectedValueOnce(new Error("Clerk unavailable"));
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(reconcileClerkUserAccess("clerk_1")).rejects.toThrow(
      "Clerk unavailable",
    );

    expect(queryCalls).toEqual([]);
    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
  });

  it("404 ao reler conta removida revoga mapping e aliases idempotentemente", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    getUserSpy.mockRejectedValueOnce({ status: 404 });
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(reconcileClerkUserAccess("clerk_1")).resolves.toBeNull();

    expect(linkRpcCalls).toEqual([
      {
        fn: "begin_clerk_user_revocation",
        args: {
          p_clerk_user_id: "clerk_1",
        },
      },
      {
        fn: "complete_clerk_user_revocation",
        args: {
          p_clerk_user_id: "clerk_1",
          p_supabase_user_id: "accountUid",
        },
      },
    ]);
  });

  it("revogação explícita sem mapping é um no-op", async () => {
    const { revokeClerkUserAccess } = await loadClerkSync();

    await expect(revokeClerkUserAccess("deleted_1")).resolves.toBeUndefined();

    expect(linkRpcCalls).toEqual([
      {
        fn: "begin_clerk_user_revocation",
        args: { p_clerk_user_id: "deleted_1" },
      },
    ]);
  });

  it("repete a conclusão do snapshot depois de uma falha parcial", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    currentClerkUser = makeClerkUser({ firstName: "Ana" });
    rpcResultQueues.complete_clerk_access_snapshot = [
      { data: null, error: { message: "profiles unavailable" } },
      { data: true, error: null },
    ];
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await expect(reconcileClerkUserAccess("clerk_1")).rejects.toThrow(
      "Erro ao concluir snapshot de acesso: profiles unavailable",
    );
    await expect(reconcileClerkUserAccess("clerk_1")).resolves.toBe(
      "accountUid",
    );

    expect(
      linkRpcCalls.filter(({ fn }) => fn === "complete_clerk_access_snapshot"),
    ).toHaveLength(2);
  });

  it("relê, prova o mesmo e-mail e reconcilia o snapshot atual", async () => {
    clerkUserList = [
      makeClerkUser({
        verifiedEmails: ["ana@exemplo.com", "alias@exemplo.com"],
      }),
    ];
    currentClerkUser = makeClerkUser({
      verifiedEmails: ["ana@exemplo.com", "alias@exemplo.com"],
      observedSupabaseUid: "accountUid",
    });
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    const { reconcileVerifiedClerkEmailOwner } = await loadClerkSync();

    await expect(
      reconcileVerifiedClerkEmailOwner(" Alias@Exemplo.COM "),
    ).resolves.toEqual({
      status: "resolved",
      userId: "accountUid",
      snapshotVersion: 100,
    });

    expect(getUserListSpy).toHaveBeenCalledWith({
      emailAddress: ["alias@exemplo.com"],
      limit: 2,
    });
    expect(getUserSpy).toHaveBeenCalledWith("clerk_1");
    expect(linkRpcCalls.at(-1)).toMatchObject({
      fn: "complete_clerk_access_snapshot",
      args: {
        p_verified_emails: ["ana@exemplo.com", "alias@exemplo.com"],
      },
    });
  });

  it("busca sem dono retorna unowned sem reler nem reconciliar", async () => {
    const { reconcileVerifiedClerkEmailOwner } = await loadClerkSync();

    await expect(
      reconcileVerifiedClerkEmailOwner("sem-dono@exemplo.com"),
    ).resolves.toEqual({ status: "unowned" });

    expect(getUserSpy).not.toHaveBeenCalled();
    expect(queryCalls).toEqual([]);
    expect(linkRpcCalls).toEqual([]);
  });

  it("alias removido entre busca e releitura retorna changed sem efeitos locais", async () => {
    clerkUserList = [
      makeClerkUser({
        verifiedEmails: ["ana@exemplo.com", "alias@exemplo.com"],
      }),
    ];
    currentClerkUser = makeClerkUser({
      primaryEmail: "novo-primario@exemplo.com",
      verifiedEmails: ["novo-primario@exemplo.com"],
    });
    const { reconcileVerifiedClerkEmailOwner } = await loadClerkSync();

    await expect(
      reconcileVerifiedClerkEmailOwner("alias@exemplo.com"),
    ).resolves.toEqual({ status: "changed" });

    expect(getUserSpy).toHaveBeenCalledWith("clerk_1");
    expect(queryCalls).toEqual([]);
    expect(linkRpcCalls).toEqual([]);
    expect(createUserSpy).not.toHaveBeenCalled();
    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
  });

  it("404 após reconciliar o snapshot revoga o mapping criado na corrida", async () => {
    clerkUserList = [makeClerkUser({ verifiedEmails: ["alias@exemplo.com"] })];
    currentClerkUser = makeClerkUser({
      primaryEmail: "alias@exemplo.com",
      verifiedEmails: ["alias@exemplo.com"],
    });
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    updateUserMetadataSpy.mockRejectedValueOnce({ status: 404 });
    const { reconcileVerifiedClerkEmailOwner } = await loadClerkSync();

    await expect(
      reconcileVerifiedClerkEmailOwner("alias@exemplo.com"),
    ).resolves.toEqual({ status: "changed" });

    expect(linkRpcCalls.slice(-2)).toEqual([
      {
        fn: "begin_clerk_user_revocation",
        args: { p_clerk_user_id: "clerk_1" },
      },
      {
        fn: "complete_clerk_user_revocation",
        args: {
          p_clerk_user_id: "clerk_1",
          p_supabase_user_id: "accountUid",
        },
      },
    ]);
  });

  it("dono marcado clerk_deleted na janela releitura→aplicação retorna changed retryable", async () => {
    // A mesma corrida de exclusão observada via 404 nos vizinhos: aqui o
    // webhook de exclusão marcou o mapping antes da aplicação, então o
    // snapshot volta applied+null. Precisa ser 'changed' (retry resolve como
    // unowned), nunca ClerkIdentityConflictError terminal.
    clerkUserList = [makeClerkUser({ verifiedEmails: ["alias@exemplo.com"] })];
    currentClerkUser = makeClerkUser({
      primaryEmail: "alias@exemplo.com",
      verifiedEmails: ["alias@exemplo.com"],
    });
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
      clerk_deleted: true,
    };
    const { reconcileVerifiedClerkEmailOwner } = await loadClerkSync();

    await expect(
      reconcileVerifiedClerkEmailOwner("alias@exemplo.com"),
    ).resolves.toEqual({ status: "changed" });

    expect(updateUserMetadataSpy).not.toHaveBeenCalled();
  });

  it("limpa nomes removidos no Clerk em vez de preservar valores antigos", async () => {
    mappingReadResult.data = {
      supabase_user_id: "accountUid",
      access_sync_version: 1,
    };
    currentClerkUser = makeClerkUser({ firstName: null, lastName: null });
    const { reconcileClerkUserAccess } = await loadClerkSync();

    await reconcileClerkUserAccess("clerk_1");

    expect(linkRpcCalls.at(-1)).toMatchObject({
      fn: "complete_clerk_access_snapshot",
      args: { p_first_name: null, p_last_name: null },
    });
  });
});
