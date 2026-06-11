import { describe, it, expect, beforeEach, vi } from "vitest";

// preregisterSupabaseUser (spec 002): placeholder Supabase-only. Os testes
// cobrem a idempotência — profile existente, criação nova, recuperação de
// race via re-consulta de profiles e último recurso via listUsers.
// `profileRowQueue` é consumida na ordem das consultas a profiles (lookup
// inicial e, no caminho de race, a re-consulta).
let profileRowQueue: ({ id: string } | null)[];
let createUserResult: {
  data: { user: { id: string } } | { user: null };
  error: { message: string } | null;
};
let listedUsers: { id: string; email: string }[];

const createUserSpy = vi.fn(async () => createUserResult);
const listUsersSpy = vi.fn(async () => ({
  data: { users: listedUsers },
  error: null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "single", "update", "is"]) {
        builder[m] = () => builder;
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data:
            table === "profiles" && profileRowQueue.length > 0
              ? profileRowQueue.shift()
              : null,
          error: null,
        });
      return builder;
    },
    auth: {
      admin: {
        createUser: createUserSpy,
        listUsers: listUsersSpy,
      },
    },
  }),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { updateUserMetadata: async () => ({}) },
  }),
}));

beforeEach(() => {
  profileRowQueue = [];
  createUserResult = {
    data: { user: { id: "newUid" } },
    error: null,
  };
  listedUsers = [];
  createUserSpy.mockClear();
  listUsersSpy.mockClear();
});

async function loadPreregister() {
  return (await import("@/lib/clerk-sync")).preregisterSupabaseUser;
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
    profileRowQueue = [{ id: "existingUid" }];
    const preregister = await loadPreregister();
    const uid = await preregister("ja-existe@exemplo.com");
    expect(uid).toBe("existingUid");
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it("race entre pré-registros: createUser falha e a re-consulta de profiles resolve, sem listUsers", async () => {
    profileRowQueue = [null, { id: "racedUid" }];
    createUserResult = {
      data: { user: null },
      error: { message: "email already registered" },
    };
    const preregister = await loadPreregister();
    const uid = await preregister("corrida@exemplo.com");
    expect(uid).toBe("racedUid");
    expect(listUsersSpy).not.toHaveBeenCalled();
  });

  it("auth.users órfão de profile: re-consulta vazia → listUsers encontra e reusa o id", async () => {
    createUserResult = {
      data: { user: null },
      error: { message: "email already registered" },
    };
    listedUsers = [{ id: "orphanUid", email: "orfao@exemplo.com" }];
    const preregister = await loadPreregister();
    const uid = await preregister("orfao@exemplo.com");
    expect(uid).toBe("orphanUid");
  });

  it("createUser falha sem usuário existente → lança erro", async () => {
    createUserResult = {
      data: { user: null },
      error: { message: "kaboom" },
    };
    const preregister = await loadPreregister();
    await expect(preregister("falha@exemplo.com")).rejects.toThrow(
      /Erro ao criar usuário Supabase: kaboom/,
    );
  });
});
